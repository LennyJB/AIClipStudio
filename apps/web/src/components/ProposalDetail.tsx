import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  REJECT_REASON_LABELS,
  reviewApi,
  type AudioPreparation,
  type ContextSegment,
  type DecisionRequest,
  type FeedbackEventView,
  type RejectReason,
  type ReviewDetail,
} from '../api';
import { formatSourceMs, ROLE_LABELS } from '../format';
import { RejectDialog } from './RejectDialog';

interface Props {
  proposalId: string;
  pollMs?: number;
  /** Une décision a changé : la liste doit être rechargée. */
  onChanged: () => void;
  /** Ouvrir une autre proposition (décision source), éventuellement d'une autre analyse. */
  onOpenProposal: (proposalId: string, runId: string) => void;
  /** Raccourcis clavier : la proposition affichée fournit ses actions au panneau. */
  registerShortcuts?: (h: { accept?: () => void; reject?: () => void }) => void;
}

export const STATE_LABELS: Record<string, string> = {
  to_review: 'À examiner',
  accepted: 'Acceptée',
  rejected: 'Refusée',
  already_reviewed: 'Déjà examinée',
  merged: 'Fusionnée',
};
const STATUS_LABELS: Record<string, string> = {
  accepted: 'acceptée',
  rejected: 'refusée',
  pending: 'à examiner',
};
const EVENT_LABELS: Record<FeedbackEventView['type'], string> = {
  proposal_accepted: 'Acceptée',
  proposal_rejected: 'Refusée',
  proposal_reset: 'Décision annulée',
};
const MARKER_LABELS = {
  setup: 'mise en place',
  punchline: 'chute',
  reaction_end: 'fin de la réaction',
};

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
const newRequestId = () => globalThis.crypto.randomUUID();

export function ProposalDetail({
  proposalId,
  pollMs = 1000,
  onChanged,
  onOpenProposal,
  registerShortcuts,
}: Props) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [segments, setSegments] = useState<ContextSegment[]>([]);
  const [history, setHistory] = useState<FeedbackEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [acceptComment, setAcceptComment] = useState('');
  // Demande en cours : le même requestId est renvoyé tant que la même action est réessayée.
  const pending = useRef<{ key: string; requestId: string } | null>(null);

  const fetchAll = useCallback(
    () =>
      Promise.all([
        reviewApi.detail(proposalId),
        reviewApi.context(proposalId).catch(() => ({ segments: [] as ContextSegment[] })),
        reviewApi.history(proposalId),
      ]),
    [proposalId],
  );
  const apply = useCallback(([d, c, h]: Awaited<ReturnType<typeof fetchAll>>) => {
    setDetail(d);
    setSegments(c.segments);
    setHistory(h.events);
  }, []);
  const load = useCallback(async () => apply(await fetchAll()), [fetchAll, apply]);

  // Le composant est recréé pour chaque proposition (clé) : un seul chargement suffit.
  useEffect(() => {
    let cancelled = false;
    fetchAll().then(
      (r) => !cancelled && apply(r),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [fetchAll, apply]);

  const decide = useCallback(
    async (body: Omit<DecisionRequest, 'requestId' | 'expectedVersion'>) => {
      if (!detail) return;
      const key = JSON.stringify({ ...body, v: detail.version });
      if (!pending.current || pending.current.key !== key)
        pending.current = { key, requestId: newRequestId() };
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const res = await reviewApi.decide(proposalId, {
          ...body,
          requestId: pending.current.requestId,
          expectedVersion: detail.version,
        });
        pending.current = null;
        setRejecting(false);
        setReevaluating(false);
        setAcceptComment('');
        if (res.outcome === 'noop') setInfo('Aucun changement : la décision était déjà celle-ci.');
        await load();
        onChanged();
      } catch (e) {
        if (e instanceof ApiError) {
          pending.current = null; // refus de l'API : un nouveau choix fera une nouvelle demande
          setError(
            e.code === 'VERSION_CONFLICT'
              ? 'La décision a été modifiée entre-temps : affichage actualisé.'
              : e.message,
          );
          await load().catch(() => undefined);
          onChanged();
        } else {
          setError('Connexion perdue : réessayez, la même demande sera renvoyée sans doublon.');
        }
      } finally {
        setBusy(false);
      }
    },
    [detail, load, onChanged, proposalId],
  );

  const inherited = detail?.effective.inherited ?? false;
  const canAct = detail !== null && detail.state !== 'merged' && (!inherited || reevaluating);

  // Raccourcis clavier relayés par le panneau (gestionnaires, pas d'état modifié dans l'effet).
  useEffect(() => {
    if (!registerShortcuts) return;
    registerShortcuts(
      canAct
        ? {
            accept: () =>
              void decide({ decision: 'accepted', ...(inherited ? { reevaluate: true } : {}) }),
            reject: () => setRejecting(true),
          }
        : {},
    );
    return () => registerShortcuts({});
  }, [registerShortcuts, canAct, inherited, decide]);

  if (!detail) return error ? <p className="error">{error}</p> : <p>Chargement…</p>;
  const p = detail.proposal;
  const eff = detail.effective;
  const reevaluate = inherited ? { reevaluate: true as const } : {};
  const reasons = (p.reliabilityDetail as { reasons?: string[] } | null)?.reasons ?? [];

  return (
    <article aria-label={`Proposition « ${p.title} »`} className="proposal-detail">
      <h4>
        {p.title}{' '}
        <span className="badge">{p.tier === 'clip' ? 'Clip proposé' : 'Moment secondaire'}</span>{' '}
        <span className={`badge state-${detail.state}`}>{STATE_LABELS[detail.state]}</span>
      </h4>
      <p>
        {formatSourceMs(p.srcStartMs)} → {formatSourceMs(p.srcEndMs)} (
        {Math.round((p.srcEndMs - p.srcStartMs) / 1000)} s) · Pertinence {p.relevance}/100 ·
        Fiabilité {p.reliability}/100 · {p.categories.join(', ')}
        {p.flags.length ? ` · alertes : ${p.flags.join(', ')}` : ''}
      </p>
      <p>{p.explanation}</p>
      {p.uncertainty && <p className="muted">Incertitude : {p.uncertainty}</p>}
      {reasons.length > 0 && <p className="muted">Fiabilité : {reasons.join(' ; ')}</p>}
      <ul aria-label="Preuves">
        {p.evidence
          .filter((e) => e.kind === 'quote')
          .map((e, i) => (
            <li key={i}>
              {e.verified ? '✓' : '✗ non vérifiée'} « {e.quote} »
            </li>
          ))}
      </ul>
      {p.editingHint && (
        <p className="muted">
          Piste de montage proposée (lecture seule) : {p.editingHint.mode}
          {p.editingHint.ideas?.length ? ` — ${p.editingHint.ideas.join(' ; ')}` : ''}
        </p>
      )}

      <AudioPlayer proposalId={proposalId} pollMs={pollMs} segments={segments} />

      <section aria-label="Décision actuelle">
        <h5>Décision actuelle</h5>
        {detail.state === 'merged' ? (
          <p>Fusionnée dans une autre proposition : jugez la proposition retenue.</p>
        ) : eff.status === 'pending' ? (
          <p>À examiner.</p>
        ) : inherited && eff.source ? (
          <div className="inherited" role="note">
            <p>
              Déjà examinée : {STATUS_LABELS[eff.status]}
              {eff.source.decidedAt ? ` le ${fmtDate(eff.source.decidedAt)}` : ''}, sur la
              proposition « {eff.source.title} ».
            </p>
            <button
              type="button"
              onClick={() => onOpenProposal(eff.source!.proposalId, eff.source!.runId)}
            >
              Ouvrir la proposition source
            </button>{' '}
            {!reevaluating && (
              <button type="button" onClick={() => setReevaluating(true)}>
                Réévaluer
              </button>
            )}
          </div>
        ) : (
          <p>
            {eff.status === 'accepted' ? 'Acceptée' : 'Refusée'}
            {eff.reasons.length
              ? ` — ${eff.reasons.map((r) => REJECT_REASON_LABELS[r]).join(', ')}`
              : ''}
            {eff.comment ? ` — « ${eff.comment} »` : ''}
          </p>
        )}
      </section>

      {canAct && (
        <div className="decision-actions">
          {reevaluating && (
            <p className="muted">
              Réévaluation : votre nouvelle décision remplacera la précédente.
            </p>
          )}
          <label>
            Commentaire (facultatif){' '}
            <input
              value={acceptComment}
              maxLength={2000}
              onChange={(e) => setAcceptComment(e.target.value)}
            />
          </label>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void decide({
                decision: 'accepted',
                ...(acceptComment.trim() ? { comment: acceptComment.trim() } : {}),
                ...reevaluate,
              })
            }
          >
            Accepter
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => setRejecting(true)}>
            Refuser
          </button>{' '}
          {!inherited && eff.status !== 'pending' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide({ decision: 'pending' })}
            >
              Annuler la décision
            </button>
          )}
        </div>
      )}
      {rejecting && canAct && (
        <RejectDialog
          busy={busy}
          onCancel={() => setRejecting(false)}
          onConfirm={(r: RejectReason[], comment) =>
            void decide({
              decision: 'rejected',
              reasons: r,
              ...(comment ? { comment } : {}),
              ...reevaluate,
            })
          }
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {info && <p className="muted">{info}</p>}

      <section aria-label="Transcription autour du moment">
        <h5>Contexte</h5>
        <ul className="context">
          {segments.map((s) => (
            <li key={s.id} className={s.inClip ? 'in-clip' : 'out-clip'}>
              <span className="muted">
                {formatSourceMs(s.srcStartMs)} {ROLE_LABELS[s.role ?? 'unknown'] ?? 'Piste'}
              </span>{' '}
              {s.marker && <strong>[{MARKER_LABELS[s.marker]}] </strong>}
              {s.text}
              {!s.sentToClaude && <span className="badge"> non transmis à Claude</span>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Historique des décisions">
        <h5>Historique</h5>
        {history.length === 0 ? (
          <p className="muted">Aucune décision pour ce passage.</p>
        ) : (
          <ol>
            {history.map((e) => (
              <li key={e.id}>
                {fmtDate(e.occurredAt)} — {EVENT_LABELS[e.type]}
                {e.reasons.length
                  ? ` (${e.reasons.map((r) => REJECT_REASON_LABELS[r]).join(', ')})`
                  : ''}
                {e.comment ? ` « ${e.comment} »` : ''}
                {e.proposalId !== proposalId ? ' — sur une autre proposition du passage' : ''}
                {e.current ? ' — décision actuelle' : ' — décision antérieure'}
              </li>
            ))}
          </ol>
        )}
      </section>

      {detail.moment && detail.moment.members.length > 1 && (
        <p>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              if (!globalThis.confirm('Détacher cette proposition des autres du même passage ?'))
                return;
              setBusy(true);
              reviewApi
                .detach(proposalId, { requestId: newRequestId() })
                .then(async () => {
                  await load();
                  onChanged();
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            Détacher du moment
          </button>{' '}
          <span className="muted">
            ({detail.moment.members.length} propositions désignent ce passage)
          </span>
        </p>
      )}
    </article>
  );
}

/** Écoute de la piste « tout » sur la fenêtre de la proposition (rien n'est envoyé à Claude). */
function AudioPlayer({
  proposalId,
  pollMs,
  segments,
}: {
  proposalId: string;
  pollMs: number;
  segments: ContextSegment[];
}) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'preparing' }
    | { kind: 'ready'; prep: AudioPreparation & { status: 'ready' } }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const audio = useRef<HTMLAudioElement | null>(null);

  const prepare = async () => {
    setState({ kind: 'preparing' });
    try {
      for (;;) {
        const prep = await reviewApi.prepareAudio(proposalId);
        if (prep.status === 'ready') return setState({ kind: 'ready', prep });
        if (prep.job) {
          const { job } = await api.job(prep.job.id);
          if (job.status === 'failed' || job.status === 'cancelled')
            throw new Error(job.error?.message ?? 'Extraction impossible');
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const markers = segments.filter((s) => s.marker);
  return (
    <section aria-label="Écoute du passage">
      {state.kind === 'idle' && (
        <button type="button" onClick={() => void prepare()}>
          Écouter le passage
        </button>
      )}
      {state.kind === 'preparing' && <p role="status">Préparation de l’extrait…</p>}
      {state.kind === 'error' && (
        <p className="error">
          {state.message}{' '}
          <button type="button" onClick={() => void prepare()}>
            Réessayer
          </button>
        </p>
      )}
      {state.kind === 'ready' && (
        <>
          <audio
            ref={audio}
            controls
            preload="metadata"
            src={reviewApi.audioUrl(proposalId, state.prep.derivativeId)}
            aria-label="Extrait audio (piste « tout »)"
          />
          <div>
            {markers.map((s) => (
              <button
                key={s.id}
                type="button"
                className="link"
                onClick={() => {
                  if (audio.current)
                    audio.current.currentTime = Math.max(
                      0,
                      (s.srcStartMs - state.prep.windowStartMs) / 1000,
                    );
                }}
              >
                {MARKER_LABELS[s.marker!]}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
