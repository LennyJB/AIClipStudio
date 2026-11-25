/**
 * Aperçu et export final : demande, progression (consultée chaque seconde, arrêtée à la fin ou en
 * quittant le panneau), annulation, lecteur, téléchargements, historique. En lecture seule, aucun
 * nouveau rendu : les exports déjà produits restent consultables, avec un avertissement si la
 * décision a changé depuis l'export.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { clipsApi, type ProjectView, type RenderRow, type RenderView } from '../../api';
import { errorMessage, RENDER_STATUS_LABELS } from './messages';

export const RENDER_POLL_MS = 1000;
const ACTIVE = new Set(['queued', 'running', 'finalizing']);

function Player({ r, warn }: { r: RenderRow; warn: boolean }) {
  return (
    <div className="render-player" data-testid={`player-${r.id}`}>
      {warn && (
        <p className="warn" role="alert">
          ⚠ Décision modifiée depuis l’export : la proposition n’est plus acceptée.
        </p>
      )}
      <video controls preload="metadata" src={clipsApi.videoUrl(r.id)} width={270} />
      <div className="small">
        {r.kind === 'final' && (
          <a href={clipsApi.downloadUrl(r.id)} download>
            Télécharger la vidéo
          </a>
        )}{' '}
        {r.srtRelPath && (
          <a href={clipsApi.srtUrl(r.id)} target="_blank" rel="noreferrer">
            Sous-titres (.srt)
          </a>
        )}
      </div>
    </div>
  );
}

export function RenderSection({ view, saving }: { view: ProjectView; saving: boolean }) {
  const projectId = view.project.id;
  const [renders, setRenders] = useState<RenderRow[]>([]);
  const [active, setActive] = useState<RenderView | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const apply = useCallback(async (r: { renders: RenderRow[] }) => {
    if (!alive.current) return;
    setRenders(r.renders);
    // Avertissement calculé par le serveur pour chaque export final publié.
    const finals = r.renders.filter((x) => x.kind === 'final' && x.status === 'succeeded');
    const views = await Promise.all(finals.map((x) => clipsApi.render(x.id).catch(() => null)));
    if (!alive.current) return;
    setChanged(
      new Set(views.filter((v) => v?.decisionChangedSinceExport).map((v) => v!.render.id)),
    );
    const running = r.renders.find((x) => ACTIVE.has(x.status));
    if (running)
      setActive((a) => a ?? { render: running, progress: 0, decisionChangedSinceExport: false });
  }, []);
  const load = useCallback(
    async () => apply(await clipsApi.renders(projectId)),
    [apply, projectId],
  );

  useEffect(() => {
    alive.current = true;
    clipsApi.renders(projectId).then(apply, (err: unknown) => {
      if (alive.current) setError(errorMessage(err));
    });
    return () => {
      alive.current = false;
    };
  }, [apply, projectId, view.revision, view.editable]);

  // Progression : une requête par seconde tant que le rendu est actif ; arrêt en quittant.
  const activeId = active && ACTIVE.has(active.render.status) ? active.render.id : null;
  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => {
      clipsApi
        .render(activeId)
        .then((v) => {
          if (!alive.current) return;
          setActive(v);
          if (!ACTIVE.has(v.render.status)) void load();
        })
        .catch((err: unknown) => alive.current && setError(errorMessage(err)));
    }, RENDER_POLL_MS);
    return () => clearInterval(t);
  }, [activeId, load]);

  const request = async (kind: 'preview' | 'final') => {
    setBusy(true);
    setError(null);
    try {
      const r = await clipsApi.requestRender(projectId, { requestId: crypto.randomUUID(), kind });
      setActive({ render: r.render, progress: 0, decisionChangedSinceExport: false });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const blockers: string[] = [];
  if (saving) blockers.push('modifications en cours d’enregistrement');
  if (!view.durationAccepted) blockers.push('durée hors plage à confirmer');
  if (!view.document.audio.silent && !view.document.audio.tracks.some((t) => t.enabled))
    blockers.push('aucune piste audio active (ajoutez-en une ou choisissez l’export sans son)');

  const shown = renders.filter((r) => r.status === 'succeeded');
  return (
    <fieldset aria-label="Aperçu et export">
      <legend>Aperçu et export</legend>
      {view.editable ? (
        <div className="toolbar">
          <button
            type="button"
            disabled={busy || blockers.length > 0}
            onClick={() => void request('preview')}
          >
            Générer l’aperçu
          </button>
          <button
            type="button"
            disabled={busy || blockers.length > 0}
            onClick={() => void request('final')}
          >
            Exporter (1080×1920)
          </button>
          {blockers.length > 0 && (
            <span className="small warn">Indisponible : {blockers.join(' ; ')}</span>
          )}
        </div>
      ) : (
        <p className="muted small">Lecture seule : aucun nouveau rendu possible.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {active && ACTIVE.has(active.render.status) && (
        <div className="small" role="status">
          Rendu {active.render.kind === 'final' ? 'final' : 'd’aperçu'} :{' '}
          {RENDER_STATUS_LABELS[active.render.status]} — {Math.round(active.progress * 100)} %{' '}
          <progress value={active.progress} max={1} />{' '}
          <button
            type="button"
            onClick={() =>
              void clipsApi
                .cancelRender(active.render.id)
                .then(load)
                .catch((err: unknown) => setError(errorMessage(err)))
            }
          >
            Annuler le rendu
          </button>
        </div>
      )}
      {shown.length > 0 && <Player r={shown[0]!} warn={changed.has(shown[0]!.id)} />}
      {renders.length > 0 && (
        <details>
          <summary>Historique des rendus ({renders.length})</summary>
          <ul className="small">
            {renders.map((r) => (
              <li key={r.id}>
                {new Date(r.createdAt).toLocaleString('fr-FR')} —{' '}
                {r.kind === 'final' ? 'export final' : 'aperçu'} (révision {r.revision}) :{' '}
                {RENDER_STATUS_LABELS[r.status] ?? r.status}
                {r.errorMessage ? ` — ${r.errorMessage}` : ''}
                {r.status === 'succeeded' && r.width ? ` — ${r.width}×${r.height}` : ''}
                {changed.has(r.id) ? ' — ⚠ décision modifiée depuis l’export' : ''}
                {r.status === 'succeeded' && r !== shown[0] && (
                  <>
                    {' '}
                    <a href={clipsApi.videoUrl(r.id)} target="_blank" rel="noreferrer">
                      lire
                    </a>
                    {r.kind === 'final' && (
                      <>
                        {' '}
                        <a href={clipsApi.downloadUrl(r.id)} download>
                          télécharger
                        </a>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </fieldset>
  );
}
