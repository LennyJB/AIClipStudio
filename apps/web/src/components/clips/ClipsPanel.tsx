/**
 * Section « Clips » d'un enregistrement (sous « Revue des propositions ») : audio exporté,
 * propositions acceptées et leur projet, projets en lecture seule (décision changée), état du
 * dernier rendu. Aucune publication : l'export s'arrête au fichier.
 */
import { useCallback, useEffect, useState } from 'react';
import { clipsApi, type ClipListItem } from '../../api';
import { formatDuration } from '../../format';
import { ClipEditor } from './ClipEditor';
import { ExportAudioPanel } from './ExportAudioPanel';
import { DECISION_LABELS, errorMessage, RENDER_STATUS_LABELS } from './messages';

export function ClipsPanel({ recordingId }: { recordingId: string }) {
  const [items, setItems] = useState<ClipListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [audioVersion, setAudioVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      setItems((await clipsApi.list(recordingId)).items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [recordingId]);
  /** Relit la liste (dernier rendu à jour) quand le panneau de rendu le signale. */
  const refreshList = useCallback(() => void load(), [load]);

  useEffect(() => {
    let alive = true;
    clipsApi.list(recordingId).then(
      (l) => alive && setItems(l.items),
      (err: unknown) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [recordingId]);

  const create = async (proposalId: string) => {
    setBusy(proposalId);
    setError(null);
    try {
      const v = await clipsApi.create(proposalId, crypto.randomUUID());
      await load();
      setOpen(v.project.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-label="Clips">
      <h2>Clips</h2>
      <p className="small muted">
        Montage simple des propositions acceptées. Aucune publication automatique : l’export
        s’arrête au fichier dans <code>storage/exports/</code>.
      </p>
      <ExportAudioPanel recordingId={recordingId} onChanged={() => setAudioVersion((n) => n + 1)} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items?.length === 0 && (
        <p className="muted">Aucune proposition acceptée : validez-en une dans la revue.</p>
      )}
      {items && items.length > 0 && (
        <ul className="clip-list">
          {items.map((i) => {
            const pid = i.project?.id ?? null;
            return (
              <li key={`${i.proposal.id}-${pid ?? ''}`} data-testid={`clip-${i.proposal.id}`}>
                <strong>« {i.proposal.title} »</strong>{' '}
                <span className="muted small">
                  {formatDuration(i.proposal.srcEndMs - i.proposal.srcStartMs)}
                </span>{' '}
                {i.readOnly && (
                  <span className="badge state-rejected">
                    lecture seule — décision {DECISION_LABELS[i.decision] ?? i.decision}
                  </span>
                )}{' '}
                {i.inherited && <span className="badge">décision héritée</span>}{' '}
                {i.project?.lastRender && (
                  <span className="small" data-testid={`last-render-${i.proposal.id}`}>
                    dernier rendu : {i.project.lastRender.kind === 'final' ? 'export' : 'aperçu'}{' '}
                    {RENDER_STATUS_LABELS[i.project.lastRender.status] ??
                      i.project.lastRender.status}
                  </span>
                )}{' '}
                {pid ? (
                  <button
                    type="button"
                    aria-pressed={open === pid}
                    onClick={() => setOpen(open === pid ? null : pid)}
                  >
                    {open === pid ? 'Fermer' : i.readOnly ? 'Consulter' : 'Ouvrir le projet'}
                  </button>
                ) : (
                  !i.readOnly && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void create(i.proposal.id)}
                    >
                      Créer le projet de clip
                    </button>
                  )
                )}
                {pid && open === pid && (
                  <ClipEditor
                    key={pid}
                    projectId={pid}
                    refreshKey={audioVersion}
                    onRenderChanged={refreshList}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
