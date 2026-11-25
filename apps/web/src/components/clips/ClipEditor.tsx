/**
 * Panneau d'un clip (sans timeline) : cadrage, masques, audio, sous-titres, effets, durée,
 * aperçu et export. Lecture seule stricte si la décision effective n'est plus « acceptée ».
 */
import { useEffect, useState } from 'react';
import { reviewApi } from '../../api';
import { AudioSection } from './AudioSection';
import { CaptionsSection } from './CaptionsSection';
import { DurationSection } from './DurationSection';
import { EffectsSection } from './EffectsSection';
import { LayoutSection } from './LayoutSection';
import { MasksSection } from './MasksSection';
import { DECISION_LABELS } from './messages';
import { RenderSection } from './RenderSection';
import { useClipProject, type ClipProjectState } from './useClipProject';

function SaveStatus({ p }: { p: ClipProjectState }) {
  const failed = p.drafts.find((d) => d.status === 'network' || d.status === 'refused');
  return (
    <div className="save-status" aria-live="polite">
      {p.conflict && (
        <div className="warn" role="alert">
          <p>
            Le projet a été modifié ailleurs
            {p.conflict.currentRevision ? ` (révision ${p.conflict.currentRevision})` : ''}. Vos
            modifications locales non enregistrées sont conservées :
          </p>
          <ul>
            {p.drafts.map((d) => (
              <li key={d.requestId}>
                {d.label}{' '}
                <button type="button" className="link" onClick={() => p.discard(d.requestId)}>
                  abandonner
                </button>
              </li>
            ))}
          </ul>
          {!p.conflict.reloaded ? (
            <button type="button" onClick={() => void p.reload()}>
              Recharger
            </button>
          ) : (
            <button type="button" onClick={p.reapply}>
              Réappliquer mes modifications
            </button>
          )}
        </div>
      )}
      {!p.conflict && failed && (
        <div className={failed.status === 'network' ? 'warn' : 'error'} role="alert">
          « {failed.label} » non enregistré : {failed.message}{' '}
          <button type="button" onClick={p.retry}>
            Réessayer
          </button>{' '}
          <button type="button" onClick={() => p.discard(failed.requestId)}>
            Abandonner
          </button>
        </div>
      )}
      {!p.conflict && !failed && p.saving && <span className="muted small">Enregistrement…</span>}
    </div>
  );
}

export function ClipEditor({
  projectId,
  refreshKey,
}: {
  projectId: string;
  /** Change quand l'audio exporté change : la décision du serveur est relue. */
  refreshKey: number;
}) {
  const p = useClipProject(projectId);
  const [ideas, setIdeas] = useState<string[]>([]);
  const { reload } = p;
  const proposalId = p.view?.project.proposalId;

  useEffect(() => {
    if (refreshKey > 0) void reload();
  }, [refreshKey, reload]);

  useEffect(() => {
    if (!proposalId) return;
    let alive = true;
    reviewApi
      .detail(proposalId)
      .then((d) => alive && setIdeas(d.proposal.editingHint?.ideas ?? []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [proposalId]);

  if (p.loadError && !p.view) return <p className="error">{p.loadError}</p>;
  if (!p.view) return <p className="muted">Chargement du projet…</p>;
  const v = p.view;
  return (
    <div className="clip-editor" aria-label="Projet de clip">
      {!v.editable && (
        <p className="warn readonly-banner" role="alert">
          Projet non modifiable : la proposition n’est plus acceptée (décision{' '}
          {DECISION_LABELS[v.decision.status] ?? v.decision.status}). Les rendus déjà produits
          restent consultables.
        </p>
      )}
      <p className="small muted">
        Révision {v.revision}
        {v.decision.inherited ? ' · décision héritée d’une autre analyse' : ''}
      </p>
      <SaveStatus p={p} />
      {v.warnings
        .filter(
          (w) =>
            ![
              'DURATION_OUT_OF_RANGE',
              'CONTEXT_MAY_BE_CUT',
              'REACTION_MAY_BE_CUT',
              'WORD_CUT',
            ].includes(w.code),
        )
        .map((w) => (
          <p key={w.code} className="warn small">
            ⚠ {w.message}
          </p>
        ))}
      <LayoutSection view={v} p={p} />
      <MasksSection view={v} p={p} />
      <AudioSection view={v} p={p} />
      <CaptionsSection view={v} p={p} />
      <EffectsSection view={v} p={p} ideas={ideas} />
      <DurationSection view={v} p={p} />
      <RenderSection view={v} saving={p.saving} />
    </div>
  );
}
