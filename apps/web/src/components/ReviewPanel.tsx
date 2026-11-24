import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reviewApi, type ReviewList } from '../api';
import { formatSourceMs } from '../format';
import { ProposalDetail, STATE_LABELS } from './ProposalDetail';

interface Props {
  recordingId: string;
  pollMs?: number;
}

const FILTERS = [
  ['to_review', 'À examiner'],
  ['accepted', 'Acceptées'],
  ['rejected', 'Refusées'],
  ['already_reviewed', 'Déjà examinées'],
  ['all', 'Toutes'],
] as const;

/**
 * Revue des propositions d'une analyse avec Claude (par défaut la dernière terminée) :
 * clips proposés et moments secondaires séparés, filtres par état, décision, écoute.
 * Raccourcis : J / K (suivante / précédente), A (accepter), R (refuser).
 */
export function ReviewPanel({ recordingId, pollMs = 1000 }: Props) {
  const [tier, setTier] = useState<'clip' | 'secondary'>('clip');
  const [status, setStatus] = useState<(typeof FILTERS)[number][0]>('to_review');
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [data, setData] = useState<ReviewList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shortcuts = useRef<{ accept?: () => void; reject?: () => void }>({});
  const registerShortcuts = useCallback((h: { accept?: () => void; reject?: () => void }) => {
    shortcuts.current = h;
  }, []);

  const fetchList = useCallback(
    () => reviewApi.list(recordingId, { ...(runId ? { runId } : {}), tier, status }),
    [recordingId, runId, tier, status],
  );
  const onLoaded = (l: ReviewList) => {
    setData(l);
    setError(null);
  };
  const onFailed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const reload = useCallback(() => {
    fetchList().then(onLoaded, onFailed);
  }, [fetchList]);

  useEffect(() => {
    let cancelled = false;
    fetchList().then(
      (l) => !cancelled && onLoaded(l),
      (e: unknown) => !cancelled && onFailed(e),
    );
    return () => {
      cancelled = true;
    };
  }, [fetchList]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const index = items.findIndex((i) => i.proposal.id === selected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j' && items.length)
        setSelected(items[Math.min(items.length - 1, index + 1)]!.proposal.id);
      else if (k === 'k' && items.length) setSelected(items[Math.max(0, index - 1)]!.proposal.id);
      else if (k === 'a') shortcuts.current.accept?.();
      else if (k === 'r') shortcuts.current.reject?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, index]);

  return (
    <section className="card" id="revue" aria-label="Revue des propositions">
      <h2>Revue des propositions</h2>
      {error && <p className="error">{error}</p>}
      {data && !data.run && <p className="muted">Aucune analyse avec Claude terminée.</p>}
      {data?.run && (
        <>
          <p className="muted">
            Analyse{' '}
            <select
              aria-label="Analyse"
              value={data.run.id}
              onChange={(e) => {
                setRunId(e.target.value);
                setSelected(null);
              }}
            >
              {data.runs.map((r, i) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.createdAt).toLocaleString('fr-FR')}
                  {i === 0 ? ' (dernière)' : ''}
                </option>
              ))}
            </select>{' '}
            — {data.counts.to_review} à examiner, {data.counts.accepted} acceptée(s),{' '}
            {data.counts.rejected} refusée(s), {data.counts.already_reviewed} déjà examinée(s).
          </p>
          <div role="tablist" aria-label="Type de proposition">
            {(['clip', 'secondary'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tier === t}
                onClick={() => setTier(t)}
              >
                {t === 'clip' ? 'Clips proposés' : 'Moments secondaires'}
              </button>
            ))}
          </div>
          <div aria-label="Filtre d’état">
            {FILTERS.map(([value, label]) => (
              <label key={value} className="filter">
                <input
                  type="radio"
                  name={`review-status-${recordingId}`}
                  checked={status === value}
                  onChange={() => setStatus(value)}
                />{' '}
                {label}
              </label>
            ))}
          </div>
          {items.length === 0 ? (
            <p className="muted">Aucune proposition pour ce filtre.</p>
          ) : (
            <ul className="review-list" aria-label="Propositions">
              {items.map((i) => (
                <li key={i.proposal.id}>
                  <button
                    type="button"
                    aria-pressed={i.proposal.id === selected}
                    onClick={() => setSelected(i.proposal.id)}
                  >
                    {formatSourceMs(i.proposal.srcStartMs)} — « {i.proposal.title} » · pertinence{' '}
                    {i.proposal.relevance} · fiabilité {i.proposal.reliability} ·{' '}
                    {STATE_LABELS[i.state]}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {selected && (
        <ProposalDetail
          key={selected}
          proposalId={selected}
          pollMs={pollMs}
          onChanged={reload}
          onOpenProposal={(pid, rid) => {
            setRunId(rid);
            setStatus('all');
            setSelected(pid);
          }}
          registerShortcuts={registerShortcuts}
        />
      )}
      <p className="muted">
        Raccourcis : J / K (suivante / précédente), A (accepter), R (refuser).
      </p>
    </section>
  );
}
