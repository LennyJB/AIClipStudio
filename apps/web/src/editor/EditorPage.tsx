/**
 * Page de l'éditeur (étape 7) : ouverte depuis « Clips » (`#/editeur/<projet>`). Assemble l'état
 * (journal, file, brouillon, onglets), le lecteur (canvas avec aplats, Web Audio des pistes
 * autorisées), la timeline, les inspecteurs, l'historique et le rendu FFmpeg.
 *
 * Raccourcis (§4) : S couper, F arrêt sur image, Suppr (avec décalage), Maj+Suppr (sans décalage),
 * J / K / L, ← / → image par image, Ctrl+Z / Ctrl+Maj+Z (ou Ctrl+Y), + / − zoom de la timeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { segmentsV2, totalEditDuration } from '@acs/timeline';
import { clipsApi, type RenderRow } from '../api';
import { deleteSegment, freezeAt, GestureError, splitAt, type Gesture } from './actions';
import { editorApi, type EditorMedia } from './api';
import { openDrafts, memoryDrafts, type DraftStore } from './drafts';
import { Inspector } from './inspector/Inspector';
import { EditorMediaSession } from './player/media';
import { LayerHandles } from './player/LayerHandles';
import { Player } from './player/Player';
import { browserDeps, createEditorStore, entryLabel, isEditable, type EditorDeps } from './store';
import { Timeline } from './timeline/Timeline';
import { createUiStore } from './ui-store';

const uuid = () => crypto.randomUUID();

export interface EditorPageProps {
  projectId: string;
  onClose: () => void;
  /** Injection pour les tests (API simulée, brouillon en mémoire). */
  deps?: (Partial<EditorDeps> & { media?: boolean }) | undefined;
}

export function EditorPage({ projectId, onClose, deps }: EditorPageProps) {
  const [drafts, setDrafts] = useState<DraftStore | null>(deps?.drafts ?? null);
  useEffect(() => {
    if (drafts) return;
    let alive = true;
    void openDrafts()
      .catch(() => memoryDrafts())
      .then((d) => alive && setDrafts(d));
    return () => {
      alive = false;
    };
  }, [drafts]);
  if (!drafts) return <p>Ouverture de l’éditeur…</p>;
  return <Editor projectId={projectId} onClose={onClose} drafts={drafts} deps={deps} />;
}

function Editor({ projectId, onClose, drafts, deps }: EditorPageProps & { drafts: DraftStore }) {
  const store = useMemo(
    () => createEditorStore(projectId, { ...browserDeps(editorApi, drafts), ...deps, drafts }),
    [projectId, drafts, deps],
  );
  const ui = useMemo(() => createUiStore(), []);
  const s = useStore(store);
  const playhead = useStore(ui, (x) => x.playheadMs);
  const selection = useStore(ui, (x) => x.selection);
  const pxPerSec = useStore(ui, (x) => x.pxPerSec);
  const snapping = useStore(ui, (x) => x.snapping);
  const [media, setMedia] = useState<EditorMedia | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  // Session de médias (bail, jetons) : identifiant propre à cet onglet.
  const [session] = useState(() => new EditorMediaSession(projectId, uuid(), editorApi));

  useEffect(() => {
    void store.getState().load();
    return () => store.getState().dispose();
  }, [store]);

  // Médias de travail (bail, jetons) : seulement si la page n'est pas en test sans médias.
  useEffect(() => {
    if (deps?.media === false) return;
    const ctrl = new AbortController();
    const ses = session;
    ses
      .start(setMedia, ctrl.signal)
      .catch((err: unknown) => setMediaError(err instanceof Error ? err.message : String(err)));
    const release = () => void ses.stop();
    window.addEventListener('pagehide', release);
    return () => {
      ctrl.abort();
      window.removeEventListener('pagehide', release);
      void ses.stop();
    };
  }, [session, deps?.media]);

  // Décision d'audio exporté changée (accord donné ou révoqué) : médias de travail re-préparés,
  // pour les seules pistes autorisées aujourd'hui.
  // Clé de la DERNIÈRE décision vérifiée : pendant une panne de vérification (pistes bloquées),
  // aucune préparation n'est relancée ; au rétablissement, seulement si la décision a changé.
  const audioKey = useStore(store, (x) =>
    x.server && !x.audioUnverified
      ? x.server.audio.selected.map((t) => t.audioIndex).join(',')
      : null,
  );
  const seenAudioKey = useRef<string | null>(null);
  useEffect(() => {
    if (deps?.media === false || audioKey === null) return;
    const previous = seenAudioKey.current;
    seenAudioKey.current = audioKey;
    // Premier chargement : la préparation initiale suffit. Ensuite, toute différence (accord
    // retiré, y compris la dernière piste, ou accordé) relance la préparation.
    if (previous === null || previous === audioKey) return;
    void session.refresh(setMedia).catch(() => {});
  }, [audioKey, session, deps?.media]);

  const editable = isEditable(s);
  const doc = s.doc;
  const total = doc ? totalEditDuration(segmentsV2(doc.segments)) : 0;

  const gesture = useCallback(
    (g: Gesture) => {
      if (!g.ops.length) {
        store.setState({ notice: g.summary });
        return;
      }
      void store.getState().dispatch(g.ops, g.summary);
    },
    [store],
  );
  const tryGesture = useCallback(
    (f: () => Gesture) => {
      try {
        gesture(f());
      } catch (err) {
        store.setState({ notice: err instanceof GestureError ? err.message : String(err) });
      }
    },
    [gesture, store],
  );

  // Raccourcis clavier.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'))
        return;
      const d = store.getState().doc;
      if (!d) return;
      const t = ui.getState().playheadMs;
      const mod = e.ctrlKey || e.metaKey;
      const frame = 1000 / (store.getState().server?.recording.fps ?? 30);
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        void (e.shiftKey ? store.getState().redo() : store.getState().undo());
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        void store.getState().redo();
      } else if (!mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        tryGesture(() => splitAt(d, t, uuid));
      } else if (!mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        tryGesture(() => freezeAt(d, t, 1000, uuid));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = ui.getState().selection;
        if (sel?.kind === 'segment') {
          e.preventDefault();
          tryGesture(() => deleteSegment(d, sel.id, !e.shiftKey, uuid));
          ui.getState().select(null);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (!ui.getState().playing)
          ui.getState().setPlayhead(
            Math.max(0, Math.min(total - 1, t + (e.key === 'ArrowLeft' ? -frame : frame))),
          );
      } else if (e.key === 'k' || e.key === 'K' || e.key === ' ') {
        e.preventDefault();
        if (e.key === ' ' || ui.getState().playing)
          window.dispatchEvent(new Event('acs-editor-toggle'));
      } else if (e.key === 'l' || e.key === 'L') {
        if (!ui.getState().playing) window.dispatchEvent(new Event('acs-editor-toggle'));
      } else if (e.key === 'j' || e.key === 'J') {
        if (ui.getState().playing) window.dispatchEvent(new Event('acs-editor-toggle'));
        ui.getState().setPlayhead(Math.max(0, t - 1000));
      } else if (e.key === '+' || e.key === '=') {
        ui.getState().setZoom(ui.getState().pxPerSec * 1.25);
      } else if (e.key === '-') {
        ui.getState().setZoom(ui.getState().pxPerSec / 1.25);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, ui, total, tryGesture]);

  if (s.status === 'loading') return <p>Chargement du projet…</p>;
  if (s.status === 'error' || !s.server || !doc) {
    return (
      <div className="editor-page">
        <p className="error" role="alert">
          {s.error ?? 'Projet indisponible'}
        </p>
        <button type="button" onClick={onClose}>
          Retour
        </button>
      </div>
    );
  }

  const server = s.server;
  const undoLabel =
    server.history.undo !== null ? entryLabel(s.entries, server.history.undo, s.clientId) : null;
  const redoLabel =
    server.history.redo !== null ? entryLabel(s.entries, server.history.redo, s.clientId) : null;
  const pendingUndo = s.pending.at(-1);
  const disabledMasks = doc.masks.filter((m) => m.mode === 'off');
  const single = server.recording.audioTracks.length === 1;

  return (
    <div className="editor-page" data-testid="editor-page">
      <header className="editor-header">
        <button type="button" onClick={onClose}>
          ← Fermer l’éditeur
        </button>
        <h2>Éditeur de clip</h2>
        <span className="small muted" data-testid="editor-version">
          version {server.version}
          {s.pending.length ? ` · ${s.pending.length} geste(s) en attente` : ' · enregistré'}
          {s.offline ? ' · hors ligne' : ''}
        </span>
        <span className="editor-history">
          <button
            type="button"
            disabled={!editable || (!pendingUndo && !undoLabel)}
            onClick={() => void store.getState().undo()}
            title={
              pendingUndo
                ? `Annuler : ${pendingUndo.summary} (non envoyé)`
                : undoLabel
                  ? `Annuler : ${undoLabel}`
                  : ''
            }
            data-testid="undo"
          >
            ↶{' '}
            {pendingUndo
              ? `Annuler : ${pendingUndo.summary}`
              : undoLabel
                ? `Annuler : ${undoLabel}`
                : 'Annuler'}
          </button>
          <button
            type="button"
            disabled={!editable || !redoLabel || s.pending.length > 0}
            onClick={() => void store.getState().redo()}
            data-testid="redo"
          >
            ↷ {redoLabel ? `Rétablir : ${redoLabel}` : 'Rétablir'}
          </button>
          <button
            type="button"
            disabled={s.pending.length > 0}
            onClick={() =>
              void editorApi
                .checkpoint(projectId)
                .then(() => store.setState({ notice: 'Version enregistrée.' }))
            }
          >
            Enregistrer une version
          </button>
        </span>
      </header>

      {!server.editable && (
        <p className="warning" role="status" data-testid="read-only">
          Lecture seule : la proposition n’est plus acceptée. Aucune modification n’est possible.
        </p>
      )}
      {s.audioUnverified && (
        <p className="warning" role="alert" data-testid="audio-unverified">
          ⚠ Vérification des autorisations audio indisponible : toutes les pistes sont bloquées
          (aucune lecture du son) jusqu’à une nouvelle réponse du serveur.
        </p>
      )}
      {!s.draftsPersistent && (
        <p className="warning small" role="status">
          Brouillon local indisponible (navigation privée ?) : l’édition reste possible, mais une
          fermeture brutale perdrait les gestes pas encore enregistrés.
        </p>
      )}
      {disabledMasks.length > 0 && (
        <p className="warning" role="alert" data-testid="masks-disabled">
          ⚠ {disabledMasks.length} zone(s) masquée(s) désactivée(s) : des informations sensibles
          peuvent être visibles dans l’aperçu et dans l’export.
        </p>
      )}
      {single && (
        <p className="small muted">
          Enregistrement à piste unique « Tout » : un seul gain global, aucune séparation des
          sources.
        </p>
      )}
      {mediaError && <p className="error small">{mediaError}</p>}
      {s.textsError && <p className="warning small">Sous-titres non affichés : {s.textsError}</p>}
      {s.notice && (
        <p className="notice" role="status" data-testid="notice">
          {s.notice}{' '}
          <button type="button" onClick={() => store.getState().dismissNotice()}>
            ×
          </button>
        </p>
      )}
      {s.maskPrompt && (
        <div className="warning" role="alertdialog" aria-label="Confirmer le risque">
          <p>{s.maskPrompt.message}</p>
          <button type="button" onClick={() => void store.getState().confirmMaskPrompt()}>
            Je confirme le risque
          </button>
          <button type="button" onClick={() => store.getState().cancelMaskPrompt()}>
            Annuler
          </button>
        </div>
      )}
      {s.conflict && (
        <section className="warning" role="alert" aria-label="Conflit" data-testid="conflict">
          <p>{s.conflict.message}</p>
          <button type="button" onClick={() => void store.getState().reloadAfterConflict()}>
            Recharger (sans perte)
          </button>
          <ul>
            {s.conflict.batches.map((b) => (
              <li key={b.requestId}>
                {b.summary}{' '}
                <button type="button" onClick={() => void store.getState().reapply(b.requestId)}>
                  Réappliquer
                </button>
                <button type="button" onClick={() => void store.getState().discard(b.requestId)}>
                  Abandonner
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="editor-main">
        <Player doc={doc} server={server} texts={s.texts} media={media} session={session} ui={ui}>
          <LayerHandles
            doc={doc}
            playheadMs={playhead}
            editable={editable}
            selection={selection}
            onSelect={(x) => ui.getState().select(x)}
            onGesture={gesture}
          />
        </Player>
        <Inspector
          doc={doc}
          server={server}
          texts={s.texts}
          selection={selection}
          playheadMs={playhead}
          editable={editable}
          uuid={uuid}
          onGesture={gesture}
          onSelect={(x) => ui.getState().select(x)}
        />
      </div>

      <div className="editor-toolbar" role="toolbar" aria-label="Montage">
        <button
          type="button"
          disabled={!editable}
          onClick={() => tryGesture(() => splitAt(doc, playhead, uuid))}
          data-testid="split"
        >
          Couper (S)
        </button>
        <button
          type="button"
          disabled={!editable}
          onClick={() => tryGesture(() => freezeAt(doc, playhead, 1000, uuid))}
        >
          Arrêt sur image (F)
        </button>
        <button
          type="button"
          onClick={() => ui.getState().setZoom(pxPerSec / 1.25)}
          aria-label="Dézoomer la timeline"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => ui.getState().setZoom(pxPerSec * 1.25)}
          aria-label="Zoomer la timeline"
        >
          +
        </button>
        <label className="small">
          <input
            type="checkbox"
            checked={snapping}
            onChange={() => ui.getState().toggleSnapping()}
          />{' '}
          Aimantation
        </label>
        <span className="small muted">Durée : {(total / 1000).toFixed(2)} s</span>
      </div>
      <Timeline
        doc={doc}
        server={server}
        ui={ui}
        editable={editable}
        media={media}
        session={session}
        texts={s.texts}
        onGesture={gesture}
      />

      <details className="editor-journal">
        <summary>
          Historique ({s.entries.length} dernières entrées affichées ; le journal reste complet)
        </summary>
        <ol reversed>
          {[...s.entries].reverse().map((e) => (
            <li key={e.seq}>
              n° {e.seq} ·{' '}
              {e.kind === 'undo'
                ? 'annulation'
                : e.kind === 'redo'
                  ? 'rétablissement'
                  : entryLabel(s.entries, e.seq, s.clientId)}
            </li>
          ))}
        </ol>
      </details>
      <EditorRender
        projectId={projectId}
        editable={server.editable}
        saving={s.pending.length > 0}
      />
    </div>
  );
}

/** Rendu FFmpeg (aperçu et export), depuis la version enregistrée. */
function EditorRender({
  projectId,
  editable,
  saving,
}: {
  projectId: string;
  editable: boolean;
  saving: boolean;
}) {
  const [row, setRow] = useState<RenderRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!row || !['queued', 'running', 'finalizing'].includes(row.status)) return;
    const h = setInterval(() => {
      void clipsApi
        .render(row.id)
        .then((v) => setRow(v.render))
        .catch(() => {});
    }, 1000);
    return () => clearInterval(h);
  }, [row]);
  const request = async (kind: 'preview' | 'final') => {
    setError(null);
    try {
      setRow((await clipsApi.requestRender(projectId, { requestId: uuid(), kind })).render);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section className="card editor-render" aria-label="Rendu">
      <h3>Rendu FFmpeg</h3>
      <p className="small muted">
        Le rendu part de la dernière version enregistrée ; il fait foi pour l’export.
      </p>
      <button type="button" disabled={!editable || saving} onClick={() => void request('preview')}>
        Aperçu FFmpeg
      </button>{' '}
      <button type="button" disabled={!editable || saving} onClick={() => void request('final')}>
        Exporter
      </button>
      {error && <p className="error">{error}</p>}
      {row && (
        <p className="small" data-testid="render-status">
          {row.kind === 'final' ? 'Export' : 'Aperçu'} : {row.status}
          {row.errorMessage ? ` — ${row.errorMessage}` : ''}
        </p>
      )}
      {row?.status === 'succeeded' && (
        <video controls src={clipsApi.videoUrl(row.id)} width={270} />
      )}
    </section>
  );
}
