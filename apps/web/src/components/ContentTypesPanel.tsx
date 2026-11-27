import { useCallback, useEffect, useState } from 'react';
import {
  api,
  contentApi,
  type ContentSegment,
  type ContentTypesView,
  type Job,
  type Recording,
  type SegmentContentType,
} from '../api';
import { formatSourceMs, JOB_STATUS_LABELS } from '../format';

export const CONTENT_TYPE_LABELS: Record<SegmentContentType, string> = {
  gaming: 'Gaming',
  just_chatting: 'Just Chatting',
  reaction: 'Réaction',
  podcast: 'Podcast / Discussion',
  irl: 'IRL',
  unknown: 'Indéterminé',
};
const SUMMARY_LABELS: Record<string, string> = {
  ...CONTENT_TYPE_LABELS,
  mixed: 'Mixte (plusieurs formats)',
  unknown: 'Non conclu',
};
const BASIS_LABELS: Record<string, string> = {
  transcription: 'transcription',
  structure_audio: 'répartition des voix',
  visuel: 'activité de l’image',
};

/** « 1:02:03 », « 12:30 » ou « 45 » (secondes) → millisecondes ; null si invalide. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d+$/u.test(p))) return null;
  const n = parts.map(Number);
  const [h, m, s] = n.length === 3 ? n : n.length === 2 ? [0, n[0]!, n[1]!] : [0, 0, n[0]!];
  if ((n.length > 1 && s! >= 60) || (n.length === 3 && m! >= 60)) return null;
  return ((h! * 60 + m!) * 60 + s!) * 1000;
}

const confidenceLabel = (s: ContentSegment) =>
  s.type === 'unknown'
    ? 'non conclu'
    : s.source === 'manual'
      ? 'confirmé par vous'
      : s.confidence >= 0.75
        ? `probable (${Math.round(s.confidence * 100)} %)`
        : `incertain (${Math.round(s.confidence * 100)} %)`;

type Draft = { startMs: number; endMs: number; type: SegmentContentType }[];

interface Props {
  recording: Recording;
  pollMs?: number;
}

/**
 * Types de contenu de l'enregistrement (étape 9) : segments détectés localement, avec leur
 * confiance (ou « non conclu »), et correction par le créateur. La correction l'emporte
 * toujours et sert à l'analyse éditoriale.
 */
export function ContentTypesPanel({ recording, pollMs = 1000 }: Props) {
  const id = recording.id;
  const [view, setView] = useState<ContentTypesView | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cutAt, setCutAt] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const reload = useCallback(
    () =>
      contentApi.view(id).then((v) => {
        setView(v);
        if (v.job) setJob(v.job);
      }),
    [id],
  );

  useEffect(() => {
    reload().catch(fail);
  }, [reload]);

  const busy = job !== null && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!busy || !job) return;
    const timer = setInterval(() => {
      api.job(job.id).then(
        (j) => {
          setJob(j.job);
          if (j.job.status !== 'queued' && j.job.status !== 'running') reload().catch(fail);
        },
        () => undefined,
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [busy, job, pollMs, reload]);

  const detect = async (force: boolean) => {
    setError(null);
    try {
      const r = await contentApi.detect(id, force);
      setView(r.view);
      setJob(r.job);
    } catch (err) {
      fail(err);
    }
  };

  const save = async (segments: Draft | null) => {
    setError(null);
    setSaving(true);
    try {
      setView(await contentApi.correct(id, crypto.randomUUID(), segments));
      setDraft(null);
      setCutAt({});
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  const eff = view?.effective ?? null;
  const duration = view?.durationMs ?? eff?.segments.at(-1)?.endMs ?? null;
  const detected = view?.detection?.detection ?? null;

  const startEditing = () => {
    if (!duration) return;
    setDraft(
      eff
        ? eff.segments.map(({ startMs, endMs, type }) => ({ startMs, endMs, type }))
        : [{ startMs: 0, endMs: duration, type: 'unknown' }],
    );
  };
  const setType = (i: number, type: SegmentContentType) =>
    setDraft((d) => d && d.map((s, k) => (k === i ? { ...s, type } : s)));
  const split = (i: number) => {
    const at = parseClock(cutAt[i] ?? '');
    const seg = draft?.[i];
    if (!seg || at === null || at <= seg.startMs || at >= seg.endMs) {
      setError('Instant de coupe invalide : il doit se trouver à l’intérieur du segment.');
      return;
    }
    setError(null);
    setDraft(
      (d) =>
        d && [...d.slice(0, i), { ...seg, endMs: at }, { ...seg, startMs: at }, ...d.slice(i + 1)],
    );
    setCutAt({});
  };
  const mergeNext = (i: number) =>
    setDraft(
      (d) => d && [...d.slice(0, i), { ...d[i]!, endMs: d[i + 1]!.endMs }, ...d.slice(i + 2)],
    );

  const shown: (ContentSegment | Draft[number])[] = draft ?? eff?.segments ?? [];

  return (
    <section className="card" aria-label="Types de contenu" data-testid="content-types">
      <h2>Types de contenu</h2>
      <p className="muted small">
        Détection locale (aucun service externe) : transcription, répartition des voix et activité
        de l’image. Elle peut ne pas conclure ; vos corrections l’emportent toujours et orientent
        l’analyse éditoriale.
      </p>
      {error && <p className="error">{error}</p>}

      {!eff && !busy && (
        <p className="muted" data-testid="content-none">
          Aucune segmentation : l’analyse considère l’enregistrement comme du gaming.
        </p>
      )}
      {busy && (
        <p role="status" data-testid="content-job">
          Détection {JOB_STATUS_LABELS[job.status]} ({Math.round(job.progress * 100)} %)
        </p>
      )}
      {job?.status === 'failed' && job.error && (
        <p className="error">Détection impossible : {job.error.message}</p>
      )}

      {eff && (
        <p data-testid="content-summary">
          <strong>{SUMMARY_LABELS[eff.summary.kind]}</strong>{' '}
          <span className="muted small">
            · {eff.source === 'manual' ? 'segmentation corrigée par vous' : 'détection automatique'}
          </span>
        </p>
      )}
      {view?.detection?.stale && (
        <p className="warning small">
          La transcription ou les profils ont changé depuis la détection : relancez-la.
        </p>
      )}
      {eff?.source === 'manual' &&
        view?.detection &&
        view.correction &&
        view.detection.createdAt > view.correction.createdAt && (
          <p className="muted small" data-testid="content-newer-detection">
            Une détection plus récente existe : votre correction reste appliquée.
          </p>
        )}

      {duration !== null && shown.length > 0 && (
        <div className="content-bar" aria-hidden="true">
          {shown.map((s) => (
            <span
              key={`${s.startMs}-${s.type}`}
              className={`content-${s.type}`}
              style={{ width: `${((s.endMs - s.startMs) / duration) * 100}%` }}
              title={`${CONTENT_TYPE_LABELS[s.type]} ${formatSourceMs(s.startMs)} – ${formatSourceMs(s.endMs)}`}
            />
          ))}
        </div>
      )}

      {!draft && eff && (
        <ol className="content-segments" data-testid="content-segments">
          {eff.segments.map((s) => {
            const auto = detected?.segments.find(
              (d) => d.startMs === s.startMs && d.endMs === s.endMs,
            );
            return (
              <li key={s.startMs}>
                {formatSourceMs(s.startMs)} – {formatSourceMs(s.endMs)} :{' '}
                <strong>{CONTENT_TYPE_LABELS[s.type]}</strong>{' '}
                <span className="muted small">({confidenceLabel(s)})</span>
                {s.source === 'auto' && auto && (
                  <span className="muted small">
                    {auto.basis.length > 0 &&
                      ` · indices : ${auto.basis.map((b) => BASIS_LABELS[b]).join(', ')}`}
                    {s.type === 'unknown' &&
                      auto.candidates.length > 0 &&
                      ` · pistes : ${auto.candidates
                        .map((c) => CONTENT_TYPE_LABELS[c.type])
                        .join(', ')}`}
                    {auto.reason && ` · ${auto.reason}`}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!draft && eff?.source === 'auto' && detected && detected.limits.length > 0 && (
        <ul className="muted small" data-testid="content-limits">
          {detected.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}

      {draft && (
        <div data-testid="content-editor">
          <ol className="content-segments">
            {draft.map((s, i) => (
              <li key={`${s.startMs}-${i}`}>
                {formatSourceMs(s.startMs)} – {formatSourceMs(s.endMs)}{' '}
                <select
                  aria-label={`Type du segment ${i + 1}`}
                  value={s.type}
                  onChange={(e) => setType(i, e.target.value as SegmentContentType)}
                >
                  {Object.entries(CONTENT_TYPE_LABELS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>{' '}
                <input
                  aria-label={`Couper le segment ${i + 1} à`}
                  placeholder="mm:ss"
                  size={8}
                  value={cutAt[i] ?? ''}
                  onChange={(e) => setCutAt({ [i]: e.target.value })}
                />{' '}
                <button type="button" onClick={() => split(i)}>
                  Couper
                </button>{' '}
                {i < draft.length - 1 && (
                  <button type="button" onClick={() => mergeNext(i)}>
                    Fusionner avec le suivant
                  </button>
                )}
              </li>
            ))}
          </ol>
          <button type="button" disabled={saving} onClick={() => void save(draft)}>
            Enregistrer la correction
          </button>{' '}
          <button type="button" disabled={saving} onClick={() => setDraft(null)}>
            Annuler
          </button>
        </div>
      )}

      {!draft && (
        <p>
          <button type="button" disabled={busy} onClick={() => void detect(Boolean(detected))}>
            {detected ? 'Relancer la détection' : 'Détecter les types de contenu'}
          </button>{' '}
          {duration !== null && (
            <button type="button" disabled={busy} onClick={startEditing}>
              Corriger
            </button>
          )}{' '}
          {eff?.source === 'manual' && detected && (
            <button type="button" disabled={saving} onClick={() => void save(null)}>
              Revenir à la détection automatique
            </button>
          )}
        </p>
      )}
    </section>
  );
}
