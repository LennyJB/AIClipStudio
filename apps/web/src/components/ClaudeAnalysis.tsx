import { useCallback, useEffect, useState } from 'react';
import {
  api,
  claudeApi,
  type AnalysisPublicConfig,
  type CallsSummary,
  type ClaudeRun,
  type Job,
  type Proposal,
} from '../api';
import { formatSourceMs, formatUsd, JOB_STATUS_LABELS } from '../format';

interface Props {
  recordingId: string;
  pollMs?: number;
}

const RUN_STATUS: Record<string, string> = {
  pending: 'en attente',
  running: 'en cours',
  completed: 'terminée',
  budget_exhausted: 'arrêtée : plafond atteint (résultats conservés)',
  failed: 'en échec',
  interrupted: 'interrompue (relancer pour reprendre)',
  cancelled: 'annulée',
};

/**
 * Analyse PAYANTE avec Claude : confirmation obligatoire du plafond, suivi, résultats.
 * Les clips et les moments secondaires sont séparés ; pertinence et fiabilité distinctes.
 */
export function ClaudeAnalysis({ recordingId, pollMs = 1000 }: Props) {
  const [config, setConfig] = useState<AnalysisPublicConfig | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<ClaudeRun | null>(null);
  const [windows, setWindows] = useState<
    { id: string; status: string; origin: string; costUsd: number }[]
  >([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [calls, setCalls] = useState<CallsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([claudeApi.config(), claudeApi.runs(recordingId)]).then(
      ([c, r]) => {
        if (cancelled) return;
        setConfig(c);
        const last = r.runs.find((x) => x.mode === 'claude');
        if (last) setRunId(last.id);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [recordingId]);

  const load = useCallback(async (id: string) => {
    const [r, p, c] = await Promise.all([
      claudeApi.run(id),
      claudeApi.proposals(id),
      claudeApi.calls(id),
    ]);
    return { r, p, c };
  }, []);

  const busy = job !== null && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const refresh = () =>
      load(runId).then(
        ({ r, p, c }) => {
          if (cancelled) return;
          setRun(r.run);
          setWindows(r.windows);
          setProposals(p.proposals);
          setCalls(c);
        },
        (err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        },
      );
    void refresh();
    if (!busy)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(() => {
      if (job)
        api.job(job.id).then(
          (j) => !cancelled && setJob(j.job),
          () => undefined,
        );
      void refresh();
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, busy, job, pollMs, load]);

  const start = async () => {
    if (!config) return;
    setError(null);
    try {
      const res = await claudeApi.start(recordingId, config.budgetUsd);
      setRunId(res.run.id);
      setJob(res.job);
      setAccepted(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!config) return null;
  const clips = proposals.filter((p) => p.tier === 'clip');
  const secondary = proposals.filter((p) => p.tier === 'secondary');
  const count = (s: string) => windows.filter((w) => w.status === s).length;

  return (
    <div aria-label="Analyse avec Claude">
      <h3>Analyse avec Claude (payante)</h3>
      {!config.claudeConfigured ? (
        <p className="muted">
          Clé ANTHROPIC_API_KEY absente : seule la préparation locale est possible.
        </p>
      ) : (
        <>
          <p className="muted">
            Repérage {config.models.triage}, analyse {config.models.deep} (effort {config.effort}).
            Un clip exige une pertinence ≥ {config.minRelevance} et une fiabilité ≥{' '}
            {config.minReliability}. Zéro clip est un résultat normal.
          </p>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />{' '}
            J’accepte un plafond de réservation de {formatUsd(config.budgetUsd)} pour cette analyse
          </label>{' '}
          <p className="muted">
            Aucun appel n’est envoyé si son pire cas estimé ne tient pas sous ce plafond. Ce n’est
            pas une garantie absolue sur la facture : si le comptage des jetons ou les tarifs sont
            inexacts, le coût réel peut le dépasser légèrement ; l’analyse s’arrête alors et le
            dépassement est affiché.
          </p>
          <button type="button" disabled={!accepted || busy} onClick={() => void start()}>
            {busy ? 'Analyse en cours…' : 'Lancer l’analyse avec Claude'}
          </button>
        </>
      )}
      {job && (
        <p role="status" className="muted">
          Traitement : {JOB_STATUS_LABELS[job.status] ?? job.status} —{' '}
          {Math.round(job.progress * 100)} %
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {run && (
        <>
          <p>
            Analyse {RUN_STATUS[run.status] ?? run.status}
            {run.error && run.status !== 'completed' ? ` — ${run.error.message}` : ''}. Coût réel
            calculé : <strong>{formatUsd(calls?.costs.realCostUsd ?? run.totalCostUsd)}</strong>{' '}
            (plafond de réservation {formatUsd(run.budgetUsd)})
            {calls
              ? ` — ${calls.costs.calls} appel(s), ${calls.costs.reusedCalls} réutilisé(s) sans frais`
              : ''}
            .
          </p>
          {(calls?.costs.budgetExceeded ?? run.overrunUsd > 0) && (
            <p className="error" role="alert">
              Dépassement du plafond : le coût réel calculé le dépasse de{' '}
              {formatUsd(calls?.costs.overrunUsd ?? run.overrunUsd)}. L’analyse a été arrêtée.
            </p>
          )}
          {calls && calls.costs.aboveReservationCalls > 0 && !calls.costs.budgetExceeded && (
            <p className="muted">
              {calls.costs.aboveReservationCalls} appel(s) ont coûté plus que leur réservation (+
              {formatUsd(calls.costs.aboveReservationUsd)}), sans dépasser le plafond.
            </p>
          )}
          <p className="muted">
            Coûts calculés à partir des jetons et des tarifs versionnés ; la facture d’Anthropic
            fait foi.
          </p>
          <p className="muted">
            Fenêtres : {windows.length} ({count('analyzed')} analysée(s), {count('refused')}{' '}
            refusée(s), {count('truncated')} tronquée(s), {count('failed')} en échec,{' '}
            {count('skipped')} sautée(s) faute de budget ;{' '}
            {windows.filter((w) => w.origin !== 'signals').length} trouvée(s) par le repérage
            global).
          </p>
          <ProposalList title={`Clips (${clips.length})`} items={clips} />
          <ProposalList
            title={`Moments secondaires (${secondary.length}) — limites ou peu fiables, à vérifier`}
            items={secondary}
          />
          {run.status === 'completed' && proposals.length === 0 && (
            <p>
              Aucun moment retenu : c’est un résultat normal pour un stream sans moment marquant.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ProposalList({ title, items }: { title: string; items: Proposal[] }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="proposals">
        {items.map((p) => (
          <li key={p.id}>
            <strong>{p.title}</strong> — {formatSourceMs(p.srcStartMs)} →{' '}
            {formatSourceMs(p.srcEndMs)} ({Math.round((p.srcEndMs - p.srcStartMs) / 1000)} s) ·{' '}
            {p.categories.join(', ')}
            <br />
            <span>
              Pertinence {p.relevance}/100 · Fiabilité {p.reliability}/100
            </span>
            {(p.reliabilityDetail.reasons ?? []).length > 0 && (
              <span className="muted"> ({(p.reliabilityDetail.reasons ?? []).join(' ; ')})</span>
            )}
            <p>{p.explanation}</p>
            <ul>
              {p.evidence
                .filter((e) => e.kind === 'quote')
                .map((e, i) => (
                  <li key={i}>
                    ✓ #{e.segmentId} « {e.quote} »
                  </li>
                ))}
            </ul>
            {p.flags.length > 0 && <p className="muted">Alertes : {p.flags.join(', ')}</p>}
            {p.uncertainty && <p className="muted">Incertain : {p.uncertainty}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
