/**
 * Lecteur de l'éditeur (docs/plan-etape-7.md §5.3) : horloge maître audio, double tampon vidéo,
 * composition canvas depuis la scène partagée (aplats compris), Web Audio limité aux pistes
 * autorisées. « Image exacte » : image FFmpeg de l'export au même instant (elle fait foi).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  captionLinesV2,
  effectiveCaptionItems,
  editToSource,
  placeSegments,
  resolvedEffects,
  sceneAt,
  segmentsV2,
  sourceRangeToEditRanges,
  textOverlayLines,
  totalEditDuration,
  zoomFactorAt,
  type CaptionRole,
  type ClipProjectV2,
  type DisplayCaptionLike,
  type EditMs,
  type SourceMs,
} from '@acs/timeline';
import { editorApi, type EditorDocument, type EditorMedia, type EditorTexts } from '../api';
import type { UiStore } from '../ui-store';
import { AudioEngine, type LoadedStem } from './audio-engine';
import { PlaybackClock, VideoSync } from './clock';
import { Compositor, type CanvasLike } from './compositor';
import type { EditorMediaSession } from './media';

/** Taille du canvas : celle de l'aperçu FFmpeg (540 × 960), même géométrie. */
export const PREVIEW_SIZE = { width: 540, height: 960 } as const;

/**
 * Sous-titres affichés : textes du SERVEUR (pseudonymisés) ; positions recalculées sur le montage
 * affiché (gestes en attente compris). Un item sans texte du serveur n'est pas affiché.
 */
export function previewCaptions(
  doc: ClipProjectV2,
  texts: EditorTexts | null,
  allowed: readonly CaptionRole[],
) {
  if (!texts) return [];
  const segments = segmentsV2(doc.segments);
  const byId = new Map(texts.items.map((i) => [i.itemId, i]));
  const display: DisplayCaptionLike[] = [];
  // Horaires EFFECTIFS (réglage compris), comme la timeline et l'export.
  for (const item of effectiveCaptionItems(doc)) {
    const t = byId.get(item.id);
    if (!t) continue;
    const editRanges = sourceRangeToEditRanges(
      segments,
      item.srcStartMs as SourceMs,
      item.srcEndMs as SourceMs,
    ).map((r) => ({ editStartMs: r.editStartMs, editEndMs: r.editEndMs }));
    if (editRanges.length) display.push({ ...t, editRanges });
  }
  const manual = Object.fromEntries(
    doc.captions.manual
      .filter((m) => texts.manual[m.id] !== undefined)
      .map((m) => [m.id, texts.manual[m.id]!]),
  );
  const shown = {
    ...doc,
    captions: { ...doc.captions, manual: doc.captions.manual.filter((m) => manual[m.id]) },
  };
  const roles = doc.captions.sources.filter((r) => allowed.includes(r));
  return captionLinesV2(shown, display, manual, {
    roles,
    emphasis: resolvedEffects(doc).some((e) => e.type === 'caption_emphasis'),
  });
}

export function previewOverlays(doc: ClipProjectV2, texts: EditorTexts | null) {
  if (!texts) return [];
  const shown = {
    ...doc,
    overlays: doc.overlays.filter((o) => o.kind === 'text' && texts.overlays[o.id]),
  };
  return textOverlayLines(shown, texts.overlays);
}

/** Clé de chargement des pistes : médias préparés ET pistes autorisées au moment du chargement. */
const stemsKey = (media: EditorMedia | null, allowed: readonly number[]) =>
  media ? `${media.audio.map((a) => a.id).join(',')}|${[...allowed].sort().join(',')}` : null;

const browserTime = { now: () => performance.now() / 1000 };

/** Polices OFL servies par l'API (mêmes fichiers que libass) pour les textes du canvas. */
let fontsLoading: Promise<void> | null = null;
export function loadEditorFonts(): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    return Promise.resolve();
  }
  fontsLoading ??= Promise.all(
    [
      new FontFace(
        'Montserrat ExtraBold',
        `url(${editorApi.fontUrl('Montserrat-ExtraBold.ttf')})`,
        {
          weight: '800',
        },
      ),
      new FontFace('Inter', `url(${editorApi.fontUrl('Inter-Bold.ttf')})`, { weight: '700' }),
    ].map(async (f) => {
      document.fonts.add(await f.load());
    }),
  ).then(
    () => undefined,
    () => undefined,
  );
  return fontsLoading;
}

function makeCanvas(w: number, h: number): CanvasLike {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

interface Props {
  doc: ClipProjectV2;
  server: EditorDocument;
  texts: EditorTexts | null;
  media: EditorMedia | null;
  session: EditorMediaSession | null;
  ui: UiStore;
  /** Contenu superposé au canvas (poignées de cadrage). */
  children?: React.ReactNode;
}

export function Player({ doc, server, texts, media, session, ui, children }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoA = useRef<HTMLVideoElement | null>(null);
  const videoB = useRef<HTMLVideoElement | null>(null);
  const compositor = useRef<Compositor | null>(null);
  const engine = useRef<AudioEngine | null>(null);
  const stems = useRef<LoadedStem[]>([]);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [exact, setExact] = useState<{ url: string; atMs: number } | null>(null);
  const [exactError, setExactError] = useState<string | null>(null);
  /** Pistes chargées pour quel couple (médias préparés, pistes autorisées) ? */
  const [stemsFor, setStemsFor] = useState<string | null>(null);
  const playing = useStore(ui, (s) => s.playing);
  const playhead = useStore(ui, (s) => s.playheadMs);
  const playingTracks = useStore(ui, (s) => s.playingTracks);

  const durationMs = totalEditDuration(segmentsV2(doc.segments));
  // État affiché d'après la décision ACTUELLE du serveur : une piste révoquée n'est jamais
  // comptée, même avant la nouvelle préparation des médias.
  const audible = (media?.audio ?? []).filter((a) =>
    server.audio.selected.some((t) => t.audioIndex === a.audioIndex),
  );
  const audioState: 'none' | 'loading' | 'ready' = !audible.length
    ? 'none'
    : stemsFor ===
        stemsKey(
          media,
          server.audio.selected.map((t) => t.audioIndex),
        )
      ? 'ready'
      : 'loading';
  const fps = server.recording.fps ?? 30;
  const src = useMemo(
    () => ({ width: server.recording.width ?? 1920, height: server.recording.height ?? 1080 }),
    [server.recording.width, server.recording.height],
  );
  const allowedAudio = useMemo(
    () => server.audio.selected.map((t) => t.audioIndex),
    [server.audio],
  );
  const allowedRoles = useMemo(() => [...server.audio.captionRoles], [server.audio]);
  const captions = useMemo(
    () => previewCaptions(doc, texts, allowedRoles),
    [doc, texts, allowedRoles],
  );
  const overlays = useMemo(() => previewOverlays(doc, texts), [doc, texts]);

  const [clock] = useState(() => new PlaybackClock(browserTime, durationMs));
  useEffect(() => clock.setDuration(durationMs), [clock, durationMs]);
  const sync = useRef<VideoSync | null>(null);

  // Proxy (non masqué) : lu uniquement dans un élément caché ; jamais affiché tel quel.
  useEffect(() => {
    let alive = true;
    if (!media?.proxy || !session) return;
    void session.url(media.proxy.id).then((u) => alive && setProxyUrl(u));
    return () => {
      alive = false;
    };
  }, [media?.proxy, session]);

  // Pistes de montage : seules celles que le serveur a préparées (autorisées ET activées).
  useEffect(() => {
    let alive = true;
    if (!media || !session || !media.audio.length) {
      stems.current = [];
      return;
    }
    void (async () => {
      const ctx = engine.current?.ctx ?? new AudioContext();
      engine.current ??= new AudioEngine(ctx);
      const out: LoadedStem[] = [];
      for (const a of media.audio) {
        if (!allowedAudio.includes(a.audioIndex)) continue; // jamais lue, même localement
        const res = await fetch(await session.url(a.id));
        if (!res.ok) continue;
        const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        out.push({
          audioIndex: a.audioIndex,
          srcStartMs: a.srcStartMs ?? 0,
          durationMs: buffer.duration * 1000,
          buffer,
        });
      }
      if (alive) {
        stems.current = out;
        setStemsFor(stemsKey(media, allowedAudio));
      }
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [media, session, allowedAudio]);

  const draw = useCallback(
    (t: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      compositor.current ??= new Compositor(canvas, makeCanvas);
      if (!sync.current && videoA.current && videoB.current) {
        sync.current = new VideoSync([videoA.current, videoB.current]);
      }
      const segs = segmentsV2(doc.segments);
      const scene = sceneAt(doc, t as EditMs, {
        src,
        out: PREVIEW_SIZE,
        allowedAudioIndexes: allowedAudio,
        allowedCaptionRoles: allowedRoles,
      });
      const placed = placeSegments(segs);
      const k = placed.findIndex((p) => p.editStartMs <= t && t < p.editEndMs);
      const proxyStart = media?.proxy?.srcStartMs ?? media?.window.srcStartMs ?? 0;
      const pos = editToSource(segs, t as EditMs);
      const target = pos?.kind === 'source' ? (pos.srcMs - proxyStart) / 1000 : null;
      const nextSeg = placed[k + 1]?.segment;
      const next =
        nextSeg?.kind === 'source'
          ? (nextSeg.srcStartMs - proxyStart) / 1000
          : nextSeg?.kind === 'freeze'
            ? (nextSeg.srcAtMs - proxyStart) / 1000
            : null;
      const v = sync.current;
      if (v) {
        v.update({
          segment: k,
          target,
          frozen: pos?.kind === 'source' && pos.frozen,
          playing: clock.playing,
          next,
        });
      }
      const el = v?.current() as HTMLVideoElement | undefined;
      const ready = el && el.readyState >= 2 && el.videoWidth > 0;
      const camZooms = scene.effects
        .filter((e) => e.type === 'reaction_hold')
        .map((e) => ({
          startS: e.startS,
          endS: e.endS,
          factor: Math.min(1.3, e.params['factor'] ?? 1.08),
        }));
      compositor.current.render({
        scene,
        video: ready ? el : null,
        videoSize: ready
          ? { width: el.videoWidth, height: el.videoHeight }
          : { width: 2, height: 2 },
        src,
        captions,
        overlays,
        globalStyle: doc.captions.style,
        facecamZoom: zoomFactorAt(camZooms, t / 1000),
      });
    },
    [doc, src, allowedAudio, allowedRoles, media, captions, overlays, clock],
  );

  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadEditorFonts().then(() => alive && setFontsReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // Boucle de lecture.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const c = clock;
      const t = c.now();
      draw(t);
      ui.getState().setPlayhead(t);
      if (c.ended()) {
        c.pause();
        engine.current?.stop();
        ui.getState().setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw, ui, clock]);

  // À l'arrêt : image redessinée à chaque changement (tête de lecture, document, textes).
  useEffect(() => {
    if (playing) return;
    clock.seek(playhead);
    draw(playhead);
    const el = sync.current?.current() as HTMLVideoElement | undefined;
    const onSeeked = () => draw(ui.getState().playheadMs);
    el?.addEventListener('seeked', onSeeked);
    el?.addEventListener('loadeddata', onSeeked);
    return () => {
      el?.removeEventListener('seeked', onSeeked);
      el?.removeEventListener('loadeddata', onSeeked);
    };
  }, [playing, playhead, draw, ui, proxyUrl, clock, fontsReady]);

  const toggle = useCallback(async () => {
    const c = clock;
    if (ui.getState().playing) {
      c.pause();
      engine.current?.stop();
      ui.getState().setPlaying(false);
      return;
    }
    c.seek(ui.getState().playheadMs >= durationMs - 1 ? 0 : ui.getState().playheadMs);
    const e = engine.current;
    if (e && stems.current.length) {
      await e.ctx.resume();
      // Horloge maître : l'audio.
      const from = c.now();
      const t0 = e.play(doc, allowedAudio, stems.current, from);
      ui.getState().setPlayingTracks(e.tracks);
      c.setSource({ now: () => e.ctx.currentTime });
      c.seek(from);
      c.startAt(t0);
    } else {
      c.setSource(browserTime);
      c.play();
    }
    ui.getState().setPlaying(true);
  }, [ui, durationMs, doc, allowedAudio, clock]);

  useEffect(() => {
    const onToggle = () => void toggle();
    window.addEventListener('acs-editor-toggle', onToggle);
    return () => window.removeEventListener('acs-editor-toggle', onToggle);
  }, [toggle]);

  // Le document change pendant la lecture : la lecture s'arrête (plan audio à recalculer).
  useEffect(() => {
    if (!ui.getState().playing) return;
    clock.pause();
    engine.current?.stop();
    ui.getState().setPlaying(false);
  }, [doc, ui, clock]);

  useEffect(() => () => engine.current?.stop(), []);

  // Révocation d'un accord (relue par le store, indépendamment du document) : toute piste qui
  // n'est plus autorisée est retirée de la mémoire, et une lecture qui l'utilise s'arrête
  // IMMÉDIATEMENT, même si le montage n'a pas changé.
  useEffect(() => {
    const revoked = stems.current.filter((x) => !allowedAudio.includes(x.audioIndex));
    if (revoked.length) {
      stems.current = stems.current.filter((x) => allowedAudio.includes(x.audioIndex));
    }
    const playingRevoked = ui.getState().playingTracks.some((i) => !allowedAudio.includes(i));
    if (ui.getState().playing && (playingRevoked || revoked.length)) {
      clock.pause();
      engine.current?.stop();
      ui.getState().setPlaying(false);
    }
  }, [allowedAudio, ui, clock]);

  const loadExact = async () => {
    setExactError(null);
    const at = ui.getState().playheadMs;
    try {
      const res = await fetch(editorApi.frameUrl(server.projectId, at));
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(b?.error?.message ?? `Erreur HTTP ${res.status}`);
      }
      const url = URL.createObjectURL(await res.blob());
      setExact((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { url, atMs: at };
      });
    } catch (err) {
      setExactError(err instanceof Error ? err.message : String(err));
    }
  };

  const frameMs = 1000 / fps;
  const step = (dir: number) => {
    if (ui.getState().playing) return;
    ui.getState().setPlayhead(Math.min(durationMs - 1, Math.max(0, playhead + dir * frameMs)));
  };

  return (
    <div className="editor-player">
      <div className="editor-stage" style={{ aspectRatio: '9 / 16' }}>
        <canvas
          ref={canvasRef}
          width={PREVIEW_SIZE.width}
          height={PREVIEW_SIZE.height}
          data-testid="editor-canvas"
          aria-label="Aperçu du clip"
        />
        {children}
        {!media?.proxy && <p className="editor-stage-note">Préparation du proxy…</p>}
      </div>
      {/* Proxy NON masqué : jamais affiché ; seul le canvas (aplats posés) est visible. */}
      <video
        ref={videoA}
        src={proxyUrl ?? undefined}
        muted
        playsInline
        preload="auto"
        hidden
        data-testid="proxy-a"
      />
      <video
        ref={videoB}
        src={proxyUrl ?? undefined}
        muted
        playsInline
        preload="auto"
        hidden
        data-testid="proxy-b"
      />
      <div className="editor-transport" role="group" aria-label="Lecture">
        <button type="button" onClick={() => step(-1)} aria-label="Image précédente">
          ◀︎|
        </button>
        <button type="button" onClick={() => void toggle()} data-testid="play-toggle">
          {playing ? 'Pause' : 'Lecture'}
        </button>
        <button type="button" onClick={() => step(1)} aria-label="Image suivante">
          |▶︎
        </button>
        <span className="mono" data-testid="playhead">
          {(playhead / 1000).toFixed(2)} s / {(durationMs / 1000).toFixed(2)} s
        </span>
        <span className="small muted">
          {audioState === 'ready'
            ? 'son : pistes autorisées'
            : audioState === 'loading'
              ? 'chargement du son…'
              : 'aperçu muet'}
        </span>
        <span className="small muted" data-testid="audio-playing">
          {playingTracks.length ? `pistes jouées : ${playingTracks.join(', ')}` : ''}
        </span>
        <button type="button" onClick={() => void loadExact()}>
          Image exacte
        </button>
      </div>
      {exactError && <p className="error">{exactError}</p>}
      {exact && (
        <figure className="editor-exact">
          <img
            src={exact.url}
            alt={`Image exacte de l’export à ${(exact.atMs / 1000).toFixed(2)} s`}
          />
          <figcaption className="small muted">
            Image exacte (FFmpeg) à {(exact.atMs / 1000).toFixed(2)} s : elle fait foi.
          </figcaption>
        </figure>
      )}
    </div>
  );
}
