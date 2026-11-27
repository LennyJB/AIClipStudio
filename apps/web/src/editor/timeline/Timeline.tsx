/**
 * Timeline de l'éditeur (docs/plan-etape-7.md §4) : éléments en DOM (accessibles, testables),
 * formes d'onde et vignettes dessinées. Un geste au pointeur = UNE opération envoyée au
 * relâchement (fusion du glissement) ; pendant le glissement, seul un aperçu local bouge.
 *
 * Pistes : Vidéo (segments, vides hachurés, arrêts sur image marqués, vignettes masquées),
 * Calques, Sous-titres, Effets, une piste par source audio (forme d'onde, gain, désactivation ;
 * une seule piste « Tout » pour un enregistrement à piste unique), Effets sonores.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  EFFECT_CATALOG,
  editToSource,
  placeSegments,
  segmentsV2,
  totalEditDuration,
  type ClipProjectV2,
  type EditMs,
  type Timing,
} from '@acs/timeline';
import type { EditorDocument, EditorMedia, EditorTexts } from '../api';
import { moveGesture, retimeCaption, setEffect, trimGesture, type Gesture } from '../actions';
import {
  moveTargetIndex,
  msToPx,
  pxToMs,
  snap,
  snapTargets,
  timingRanges,
  trimFields,
} from '../timeline-math';
import type { Selection, UiStore } from '../ui-store';
import type { LibraryState } from '../../library/useLibrary';
import {
  parseWaveform,
  waveformPeak,
  type EditorMediaSession,
  type Waveform,
} from '../player/media';

const ROLE_LABELS: Record<string, string> = {
  mic: 'Micro',
  discord: 'Discord',
  game: 'Jeu',
  mix: 'Tout',
  unknown: 'Tout',
};

type Drag =
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; x0: number; dx: number }
  | { kind: 'move'; id: string; x0: number; dx: number }
  | { kind: 'caption'; id: string; edge: 'start' | 'end'; x0: number; dx: number }
  | { kind: 'effect'; id: string; edge: 'start' | 'end' | 'body'; x0: number; dx: number }
  | { kind: 'scrub' };

interface Props {
  doc: ClipProjectV2;
  server: EditorDocument;
  ui: UiStore;
  editable: boolean;
  media: EditorMedia | null;
  session: EditorMediaSession | null;
  /** Textes affichés (pseudonymisés) du serveur : seuls textes montrés dans la timeline. */
  texts: EditorTexts | null;
  onGesture: (g: Gesture) => void;
  library?: Pick<LibraryState, 'assets'> | undefined;
}

const asTiming = (t: unknown) => t as Timing;

export function Timeline({
  doc,
  server,
  ui,
  editable,
  media,
  session,
  texts,
  onGesture,
  library,
}: Props) {
  const assetName = (id: string | null) =>
    (id && library?.assets?.find((a) => a.id === id)?.displayName) || null;
  const assetMissing = (id: string | null) =>
    !!id && !!library?.assets && library.assets.find((a) => a.id === id)?.status !== 'ok';
  const pxPerSec = useStore(ui, (s) => s.pxPerSec);
  const playhead = useStore(ui, (s) => s.playheadMs);
  const selection = useStore(ui, (s) => s.selection);
  const snapping = useStore(ui, (s) => s.snapping);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const segs = segmentsV2(doc.segments);
  const placed = placeSegments(segs);
  const total = totalEditDuration(segs);
  const width = Math.max(400, msToPx(total, pxPerSec) + 40);
  const targets = useMemo(() => snapTargets(doc, playhead), [doc, playhead]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [sprite, setSprite] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (media?.thumbnails && session)
      void session.url(media.thumbnails.id).then((u) => alive && setSprite(u));
    return () => {
      alive = false;
    };
  }, [media?.thumbnails, session]);

  const xToMs = (clientX: number) => {
    const r = rootRef.current?.getBoundingClientRect();
    return Math.max(0, Math.min(total, pxToMs(clientX - (r?.left ?? 0), pxPerSec)));
  };

  const select = (s: Selection) => ui.getState().select(s);

  /** Fin d'un geste : une opération (aimantation comprise), jamais pendant le glissement. */
  const finish = (d: Drag) => {
    setSnapAt(null);
    if (d.kind === 'scrub') return;
    const deltaMs = pxToMs(d.dx, pxPerSec);
    if (Math.abs(d.dx) < 2) return;
    try {
      if (d.kind === 'trim') {
        const p = placed.find((x) => x.segment.id === d.id)!;
        const edgeMs = (d.edge === 'start' ? p.editStartMs : p.editEndMs) + deltaMs;
        const snapped = snap(
          edgeMs,
          targets.filter((t) => t.ms !== (d.edge === 'start' ? p.editStartMs : p.editEndMs)),
          pxPerSec,
          snapping,
        );
        const fields = trimFields(
          p.segment as never,
          d.edge,
          snapped.ms - (d.edge === 'start' ? p.editStartMs : p.editEndMs),
          doc.source.editWindow,
        );
        if (fields) onGesture(trimGesture(doc, d.id, fields));
      } else if (d.kind === 'move') {
        const p = placed.find((x) => x.segment.id === d.id)!;
        const to = moveTargetIndex(doc, d.id, (p.editStartMs + p.editEndMs) / 2 + deltaMs);
        if (to !== doc.segments.findIndex((s) => s.id === d.id))
          onGesture(moveGesture(doc, d.id, to));
      } else if (d.kind === 'caption') {
        const it = doc.captions.items.find((x) => x.id === d.id)!;
        const ov = doc.captions.overrides.find((x) => x.id === d.id);
        const a = ov?.srcStartMs ?? it.srcStartMs;
        const b = ov?.srcEndMs ?? it.srcEndMs;
        onGesture(
          retimeCaption(
            doc,
            d.id,
            d.edge === 'start' ? a + deltaMs : a,
            d.edge === 'end' ? b + deltaMs : b,
          ),
        );
      } else if (d.kind === 'effect') {
        const e = doc.effects.find((x) => x.id === d.id)!;
        const tm = e.timing;
        const delta = Math.round(deltaMs);
        const timing =
          tm.anchor === 'source'
            ? {
                ...tm,
                srcStartMs: d.edge !== 'end' ? Math.max(0, tm.srcStartMs + delta) : tm.srcStartMs,
                srcEndMs: d.edge !== 'start' ? tm.srcEndMs + delta : tm.srcEndMs,
              }
            : tm.from === 'start'
              ? {
                  ...tm,
                  offsetMs: d.edge !== 'end' ? Math.max(0, tm.offsetMs + delta) : tm.offsetMs,
                  durMs: Math.max(
                    100,
                    tm.durMs + (d.edge === 'end' ? delta : d.edge === 'start' ? -delta : 0),
                  ),
                }
              : {
                  ...tm,
                  offsetMs: d.edge !== 'start' ? Math.max(0, tm.offsetMs - delta) : tm.offsetMs,
                  durMs: Math.max(
                    100,
                    tm.durMs + (d.edge === 'start' ? -delta : d.edge === 'end' ? delta : 0),
                  ),
                };
        onGesture(setEffect({ ...e, timing }, `effet déplacé : ${EFFECT_CATALOG[e.type].label}`));
      }
    } catch (err) {
      // Geste invalide : rien n'est envoyé (l'état reste celui d'avant).
      void err;
    }
  };

  const start = (e: React.PointerEvent, d: Drag) => {
    if (d.kind !== 'scrub' && !editable) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag(d);
    if (d.kind === 'scrub') ui.getState().setPlayhead(xToMs(e.clientX));
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'scrub') {
      ui.getState().setPlayhead(
        snap(
          xToMs(e.clientX),
          targets.filter((t) => t.kind !== 'playhead'),
          pxPerSec,
          snapping,
        ).ms,
      );
      return;
    }
    const dx = e.clientX - drag.x0;
    setDrag({ ...drag, dx });
    if (drag.kind === 'trim') {
      const p = placed.find((x) => x.segment.id === drag.id);
      if (p) {
        const edge = drag.edge === 'start' ? p.editStartMs : p.editEndMs;
        const s = snap(
          edge + pxToMs(dx, pxPerSec),
          targets.filter((t) => t.ms !== edge),
          pxPerSec,
          snapping,
        );
        setSnapAt(s.target ? s.ms : null);
      }
    }
  };
  const onUp = () => {
    if (drag) finish(drag);
    setDrag(null);
  };

  const ghost = (id: string, kind: Drag['kind']) =>
    drag && 'id' in drag && drag.id === id && drag.kind === kind ? drag : null;

  const isSel = (k: Selection['kind'], id: string) =>
    selection !== null && selection.kind === k && 'id' in selection && selection.id === id;

  const tracksByRole = doc.audio.tracks;
  const single = server.recording.audioTracks.length === 1;

  return (
    <div className="timeline" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className="timeline-labels">
        <div className="tl-label tl-ruler-label">Temps</div>
        <div className="tl-label">Vidéo</div>
        <div className="tl-label">Calques</div>
        <div className="tl-label">Sous-titres</div>
        <div className="tl-label">Effets</div>
        {tracksByRole.map((t) => (
          <div className="tl-label" key={t.audioIndex}>
            {ROLE_LABELS[t.role] ?? t.role}
            {single && <span className="small muted"> (piste unique)</span>}
          </div>
        ))}
        <div className="tl-label">Effets sonores</div>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-body" ref={rootRef} style={{ width }}>
          <div
            className="tl-row tl-ruler"
            data-testid="ruler"
            onPointerDown={(e) => start(e, { kind: 'scrub' })}
          >
            {Array.from({ length: Math.ceil(total / 1000) + 1 }, (_, s) => (
              <span key={s} className="tl-tick" style={{ left: msToPx(s * 1000, pxPerSec) }}>
                {s % 5 === 0 ? `${s}s` : ''}
              </span>
            ))}
          </div>

          <div className="tl-row" aria-label="Piste vidéo">
            {placed.map((p, i) => {
              const s = p.segment;
              const g = ghost(s.id, 'trim') as Extract<Drag, { kind: 'trim' }> | null;
              const mv = ghost(s.id, 'move') as Extract<Drag, { kind: 'move' }> | null;
              let left = msToPx(p.editStartMs, pxPerSec);
              let w = msToPx(p.editEndMs - p.editStartMs, pxPerSec);
              if (g?.edge === 'start') {
                left += g.dx;
                w -= g.dx;
              } else if (g?.edge === 'end') w += g.dx;
              const label =
                s.kind === 'gap'
                  ? 'Vide'
                  : s.kind === 'freeze'
                    ? 'Arrêt sur image'
                    : `Segment ${i + 1}`;
              return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  data-testid={`segment-${s.id}`}
                  data-kind={s.kind}
                  aria-label={`${label}, ${((p.editEndMs - p.editStartMs) / 1000).toFixed(2)} s`}
                  aria-pressed={isSel('segment', s.id)}
                  className={`tl-item tl-seg tl-${s.kind}${isSel('segment', s.id) ? ' selected' : ''}`}
                  style={{
                    left,
                    width: Math.max(4, w),
                    transform: mv ? `translateX(${mv.dx}px)` : undefined,
                  }}
                  onPointerDown={(e) => {
                    select({ kind: 'segment', id: s.id });
                    start(e, { kind: 'move', id: s.id, x0: e.clientX, dx: 0 });
                  }}
                >
                  {s.kind === 'source' && sprite && media?.thumbnails?.layout && (
                    <Thumbs
                      sprite={sprite}
                      layout={media.thumbnails.layout}
                      srcStartMs={s.srcStartMs}
                      srcEndMs={s.srcEndMs}
                      width={w}
                    />
                  )}
                  <span className="tl-text">
                    {s.kind === 'freeze' ? '❄ figé' : s.kind === 'gap' ? 'vide' : ''}
                  </span>
                  {editable && (
                    <>
                      <span
                        className="tl-handle start"
                        aria-label="Rogner le début"
                        onPointerDown={(e) =>
                          start(e, { kind: 'trim', id: s.id, edge: 'start', x0: e.clientX, dx: 0 })
                        }
                      />
                      <span
                        className="tl-handle end"
                        aria-label="Rogner la fin"
                        data-testid={`trim-end-${s.id}`}
                        onPointerDown={(e) =>
                          start(e, { kind: 'trim', id: s.id, edge: 'end', x0: e.clientX, dx: 0 })
                        }
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="tl-row" aria-label="Piste des calques">
            {doc.overlays.flatMap((o) =>
              timingRanges(doc, asTiming(o.timing)).map((r, k) => (
                <div
                  key={`${o.id}-${k}`}
                  role="button"
                  tabIndex={0}
                  className={`tl-item tl-overlay${isSel('overlay', o.id) ? ' selected' : ''}${assetMissing(o.assetId) ? ' missing' : ''}`}
                  style={{
                    left: msToPx(r.editStartMs, pxPerSec),
                    width: Math.max(4, msToPx(r.editEndMs - r.editStartMs, pxPerSec)),
                  }}
                  onPointerDown={() => select({ kind: 'overlay', id: o.id })}
                >
                  <span className="tl-text">
                    {o.kind === 'text'
                      ? `T ${o.text ?? ''}`
                      : `${o.kind === 'meme' ? 'Mème' : 'Image'} ${assetName(o.assetId) ?? ''}${assetMissing(o.assetId) ? ' (manquant)' : ''}`}
                  </span>
                </div>
              )),
            )}
          </div>

          <div className="tl-row" aria-label="Piste des sous-titres">
            {doc.captions.items
              // Sources choisies ET autorisées aujourd'hui : une voix non autorisée n'apparaît pas.
              .filter(
                (it) =>
                  doc.captions.sources.includes(it.speakerRole) &&
                  server.audio.captionRoles.includes(it.speakerRole),
              )
              .map((it) => {
                const ov = doc.captions.overrides.find((x) => x.id === it.id);
                const g = ghost(it.id, 'caption') as Extract<Drag, { kind: 'caption' }> | null;
                const ranges = timingRanges(doc, {
                  anchor: 'source',
                  srcStartMs: (ov?.srcStartMs ?? it.srcStartMs) as never,
                  srcEndMs: (ov?.srcEndMs ?? it.srcEndMs) as never,
                });
                return ranges.map((r, k) => {
                  let left = msToPx(r.editStartMs, pxPerSec);
                  let w = msToPx(r.editEndMs - r.editStartMs, pxPerSec);
                  if (g?.edge === 'start') {
                    left += g.dx;
                    w -= g.dx;
                  } else if (g?.edge === 'end') w += g.dx;
                  return (
                    <div
                      key={`${it.id}-${k}`}
                      role="button"
                      tabIndex={0}
                      data-testid={`caption-${it.id}`}
                      className={`tl-item tl-caption role-${it.speakerRole}${r.frozen ? ' frozen' : ''}${isSel('caption', it.id) ? ' selected' : ''}`}
                      style={{ left, width: Math.max(4, w) }}
                      onPointerDown={() => select({ kind: 'caption', id: it.id })}
                    >
                      <span className="tl-text">
                        {texts?.items.find((x) => x.itemId === it.id)?.text ?? '…'}
                      </span>
                      {editable && (
                        <>
                          <span
                            className="tl-handle start"
                            onPointerDown={(e) =>
                              start(e, {
                                kind: 'caption',
                                id: it.id,
                                edge: 'start',
                                x0: e.clientX,
                                dx: 0,
                              })
                            }
                          />
                          <span
                            className="tl-handle end"
                            onPointerDown={(e) =>
                              start(e, {
                                kind: 'caption',
                                id: it.id,
                                edge: 'end',
                                x0: e.clientX,
                                dx: 0,
                              })
                            }
                          />
                        </>
                      )}
                    </div>
                  );
                });
              })}
            {doc.captions.manual.flatMap((m) =>
              timingRanges(doc, {
                anchor: 'source',
                srcStartMs: m.srcStartMs as never,
                srcEndMs: m.srcEndMs as never,
              }).map((r, k) => (
                <div
                  key={`${m.id}-${k}`}
                  role="button"
                  tabIndex={0}
                  className={`tl-item tl-caption manual${isSel('caption', m.id) ? ' selected' : ''}`}
                  style={{
                    left: msToPx(r.editStartMs, pxPerSec),
                    width: Math.max(4, msToPx(r.editEndMs - r.editStartMs, pxPerSec)),
                  }}
                  onPointerDown={() => select({ kind: 'caption', id: m.id })}
                >
                  <span className="tl-text">✎ {texts?.manual[m.id] ?? '…'}</span>
                </div>
              )),
            )}
          </div>

          <div className="tl-row" aria-label="Piste des effets">
            {doc.effects.flatMap((e) => {
              const g = ghost(e.id, 'effect') as Extract<Drag, { kind: 'effect' }> | null;
              return timingRanges(doc, asTiming(e.timing)).map((r, k) => {
                let left = msToPx(r.editStartMs, pxPerSec);
                let w = msToPx(r.editEndMs - r.editStartMs, pxPerSec);
                if (g?.edge === 'body') left += g.dx;
                else if (g?.edge === 'start') {
                  left += g.dx;
                  w -= g.dx;
                } else if (g?.edge === 'end') w += g.dx;
                const def = EFFECT_CATALOG[e.type];
                return (
                  <div
                    key={`${e.id}-${k}`}
                    role="button"
                    tabIndex={0}
                    title={def.hint}
                    data-testid={`effect-${e.id}`}
                    className={`tl-item tl-effect ${def.category}${e.enabled ? '' : ' disabled'}${isSel('effect', e.id) ? ' selected' : ''}`}
                    style={{ left, width: Math.max(4, w) }}
                    onPointerDown={(ev) => {
                      select({ kind: 'effect', id: e.id });
                      start(ev, { kind: 'effect', id: e.id, edge: 'body', x0: ev.clientX, dx: 0 });
                    }}
                  >
                    <span className="tl-text">{def.label}</span>
                    {editable && (
                      <>
                        <span
                          className="tl-handle start"
                          onPointerDown={(ev) =>
                            start(ev, {
                              kind: 'effect',
                              id: e.id,
                              edge: 'start',
                              x0: ev.clientX,
                              dx: 0,
                            })
                          }
                        />
                        <span
                          className="tl-handle end"
                          onPointerDown={(ev) =>
                            start(ev, {
                              kind: 'effect',
                              id: e.id,
                              edge: 'end',
                              x0: ev.clientX,
                              dx: 0,
                            })
                          }
                        />
                      </>
                    )}
                  </div>
                );
              });
            })}
          </div>

          {tracksByRole.map((t) => {
            const allowed = server.audio.selected.some((x) => x.audioIndex === t.audioIndex);
            const wf = media?.waveforms.find((w) => w.audioIndex === t.audioIndex);
            const stem = media?.audio.find((a) => a.audioIndex === t.audioIndex);
            return (
              <div
                key={t.audioIndex}
                className={`tl-row tl-audio${t.enabled && allowed ? '' : ' muted-track'}`}
                aria-label={`Piste audio ${ROLE_LABELS[t.role] ?? t.role}`}
                onPointerDown={() => select({ kind: 'track', audioIndex: t.audioIndex })}
              >
                {allowed && t.enabled && wf && stem && session ? (
                  <WaveformCanvas
                    doc={doc}
                    session={session}
                    derivativeId={wf.id}
                    stemStartMs={stem.srcStartMs ?? 0}
                    width={width}
                    pxPerSec={pxPerSec}
                  />
                ) : (
                  <span className="tl-text small muted">
                    {!allowed
                      ? 'non autorisée à l’export : jamais lue'
                      : !t.enabled
                        ? 'désactivée'
                        : 'préparation…'}
                  </span>
                )}
              </div>
            );
          })}
          <div className="tl-row" aria-label="Piste des effets sonores">
            {doc.audio.sfx.flatMap((x) =>
              timingRanges(doc, asTiming(x.timing)).map((r, k) => (
                <div
                  key={`${x.id}-${k}`}
                  role="button"
                  tabIndex={0}
                  data-testid="tl-sfx"
                  className={`tl-item tl-sfx${isSel('sfx', x.id) ? ' selected' : ''}${assetMissing(x.assetId) ? ' missing' : ''}${doc.audio.silent ? ' muted' : ''}`}
                  style={{
                    left: msToPx(r.editStartMs, pxPerSec),
                    width: Math.max(4, msToPx(r.editEndMs - r.editStartMs, pxPerSec)),
                  }}
                  onPointerDown={() => select({ kind: 'sfx', id: x.id })}
                >
                  <span className="tl-text">
                    ♪ {assetName(x.assetId) ?? 'son'}
                    {assetMissing(x.assetId) ? ' (manquant)' : ''}
                  </span>
                </div>
              )),
            )}
          </div>

          <div
            className="tl-playhead"
            style={{ left: msToPx(playhead, pxPerSec) }}
            data-testid="tl-playhead"
          />
          {snapAt !== null && (
            <div className="tl-snap" style={{ left: msToPx(snapAt, pxPerSec) }} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Vignettes masquées (planche produite depuis l'image masquée) d'un segment source. */
function Thumbs(props: {
  sprite: string;
  layout: NonNullable<NonNullable<EditorMedia['thumbnails']>['layout']>;
  srcStartMs: number;
  srcEndMs: number;
  width: number;
}) {
  const { layout: l, sprite } = props;
  const h = 40;
  const k = h / l.tileHeight;
  const tw = l.tileWidth * k;
  const n = Math.max(1, Math.floor(props.width / tw));
  return (
    <span className="tl-thumbs" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const at = props.srcStartMs + ((props.srcEndMs - props.srcStartMs) * (i + 0.5)) / n;
        const idx = Math.min(
          l.count - 1,
          Math.max(0, Math.floor((at - l.windowStartMs) / l.intervalMs)),
        );
        const col = idx % l.columns;
        const row = Math.floor(idx / l.columns);
        return (
          <span
            key={i}
            style={{
              left: i * tw,
              width: tw,
              height: h,
              backgroundImage: `url(${sprite})`,
              backgroundSize: `${l.columns * tw}px ${l.rows * h}px`,
              backgroundPosition: `${-col * tw}px ${-row * h}px`,
            }}
          />
        );
      })}
    </span>
  );
}

/** Forme d'onde d'une piste en temps MONTAGE : rien pendant un arrêt sur image ni un vide. */
function WaveformCanvas(props: {
  doc: ClipProjectV2;
  session: EditorMediaSession;
  derivativeId: string;
  stemStartMs: number;
  width: number;
  pxPerSec: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [wf, setWf] = useState<Waveform | null>(null);
  useEffect(() => {
    let alive = true;
    void props.session
      .url(props.derivativeId)
      .then((u) => fetch(u))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('forme d’onde'))))
      .then((b) => alive && setWf(parseWaveform(b)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.session, props.derivativeId]);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !wf) return;
    const h = c.height;
    ctx.clearRect(0, 0, c.width, h);
    ctx.fillStyle = '#4a7bd0';
    const segs = segmentsV2(props.doc.segments);
    const msPerPx = 1000 / props.pxPerSec;
    for (let x = 0; x < c.width; x++) {
      const t = x * msPerPx;
      const p = editToSource(segs, t as EditMs);
      if (p?.kind !== 'source' || p.frozen) continue;
      const a = p.srcMs - props.stemStartMs;
      const peak = waveformPeak(wf, a, a + msPerPx);
      const bar = Math.max(1, peak * h);
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [wf, props.doc, props.pxPerSec, props.width, props.stemStartMs]);
  return <canvas ref={ref} width={Math.ceil(props.width)} height={40} className="tl-wave" />;
}
