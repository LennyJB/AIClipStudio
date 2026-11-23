import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type ComparisonGroup,
  type Job,
  type Recording,
  type Segment,
  type Transcription,
  type TranscriptionConfig,
} from '../api';
import {
  describeDevices,
  formatDuration,
  formatSourceMs,
  ROLE_LABELS,
  JOB_STATUS_LABELS,
  STATUS_LABELS,
  SUSPICION_LABELS,
} from '../format';

interface Props {
  recording: Recording;
  /** Intervalle de rafraîchissement pendant un traitement (ms). */
  pollMs?: number;
}

const ACTIVE = new Set(['pending', 'running']);
const RESUMABLE = new Set(['interrupted', 'failed', 'cancelled']);

/**
 * Lancer une transcription, suivre sa progression, consulter les segments.
 * Volontairement minimal : pas d'édition.
 */
export function TranscriptionPanel({ recording, pollMs = 1000 }: Props) {
  const [config, setConfig] = useState<TranscriptionConfig | null>(null);
  const [model, setModel] = useState<string>('');
  const [runs, setRuns] = useState<Transcription[]>([]);
  const [comparisons, setComparisons] = useState<ComparisonGroup[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [hiddenTracks, setHiddenTracks] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const trackRole = useCallback(
    (audioIndex: number) =>
      recording.audioTracks.find((t) => t.audioIndex === audioIndex)?.role ?? 'unknown',
    [recording],
  );

  /** Lecture seule (aucune mise à jour d'état) : appliquée ensuite par apply(). */
  const load = useCallback(async () => {
    const [list, tr] = await Promise.all([
      api.transcriptions(recording.id),
      api.transcript(recording.id, { model }),
    ]);
    return { list, tr };
  }, [recording.id, model]);

  const apply = useCallback((data: Awaited<ReturnType<typeof load>>) => {
    setRuns(data.list.transcriptions);
    setComparisons(data.list.comparisons);
    setSegments(data.tr.segments);
  }, []);

  const showError = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const refresh = useCallback(async () => {
    if (!model) return;
    try {
      apply(await load());
    } catch (err) {
      showError(err);
    }
  }, [model, load, apply]);

  useEffect(() => {
    api
      .transcriptionConfig()
      .then((c) => {
        setConfig(c);
        setModel((m) => m || c.defaultModel);
      })
      .catch(showError);
  }, []);

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) apply(data);
      },
      (err: unknown) => {
        if (!cancelled) showError(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [model, load, apply]);

  const modelRuns = useMemo(() => {
    // Pour chaque piste : la transcription la plus récente du modèle choisi.
    const byTrack = new Map<number, Transcription>();
    for (const t of runs.filter((r) => r.model === model)) {
      const cur = byTrack.get(t.audioIndex);
      if (!cur || t.createdAt > cur.createdAt) byTrack.set(t.audioIndex, t);
    }
    return [...byTrack.values()].sort((a, b) => a.audioIndex - b.audioIndex);
  }, [runs, model]);

  const busy =
    (job !== null && (job.status === 'queued' || job.status === 'running')) ||
    modelRuns.some((t) => ACTIVE.has(t.status));

  // Rafraîchissement périodique pendant un traitement.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      void (async () => {
        if (job) {
          try {
            setJob((await api.job(job.id)).job);
          } catch {
            /* nouvel essai au prochain tour */
          }
        }
        await refresh();
      })();
    }, pollMs);
    return () => clearInterval(timer);
  }, [busy, job, pollMs, refresh]);

  const start = async () => {
    setError(null);
    try {
      const res = await api.startTranscription(recording.id, model);
      setJob(res.job);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const canResume = modelRuns.some((t) => RESUMABLE.has(t.status) && t.checkpointMs > 0);
  const allDone = modelRuns.length > 0 && modelRuns.every((t) => t.status === 'completed');
  const visible = segments.filter((s) => !hiddenTracks.has(s.audioIndex));
  const transcribedTracks = [...new Set(segments.map((s) => s.audioIndex))].sort((a, b) => a - b);

  return (
    <section className="card" aria-label="Transcription">
      <h2>Transcription — {recording.fileName}</h2>

      <div className="toolbar">
        <label>
          Modèle{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!config}>
            {config?.modelChoices.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void start()} disabled={!model || busy}>
          {busy
            ? 'Transcription en cours…'
            : canResume
              ? 'Reprendre la transcription'
              : allDone
                ? 'Transcrire à nouveau'
                : 'Transcrire'}
        </button>
        {config && (
          <span className="muted">
            Périphérique demandé : {config.device} · langue :{' '}
            {config.language === 'auto' ? 'détection automatique' : config.language}
          </span>
        )}
      </div>

      {job && (
        <p role="status" className="muted">
          Traitement : {JOB_STATUS_LABELS[job.status] ?? job.status}
          {' — '}
          <progress max={1} value={job.progress} aria-label="Progression" />{' '}
          {Math.round(job.progress * 100)} %
          {job.error && <span className="error"> {job.error.message}</span>}
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {modelRuns.length > 0 && (
        <table className="runs">
          <thead>
            <tr>
              <th>Piste</th>
              <th>État</th>
              <th>Avancement</th>
              <th>Langue</th>
              <th>Périphérique réel</th>
              <th>Segments</th>
              <th>Traitement</th>
              <th>Temps réel</th>
            </tr>
          </thead>
          <tbody>
            {modelRuns.map((t) => (
              <tr key={t.id}>
                <td>
                  <span className={`badge role-${trackRole(t.audioIndex)}`}>
                    {ROLE_LABELS[trackRole(t.audioIndex)] ?? 'Piste'}
                  </span>
                </td>
                <td>
                  {STATUS_LABELS[t.status] ?? t.status}
                  {t.error && t.status !== 'completed' && (
                    <div className="error small">{t.error.message}</div>
                  )}
                </td>
                <td>
                  {t.audioDurationMs
                    ? `${Math.round((t.checkpointMs / t.audioDurationMs) * 100)} %`
                    : '—'}
                </td>
                <td>
                  {t.language
                    ? `${t.language}${t.languageSource === 'forced' ? ' (imposée)' : ''}`
                    : '—'}
                </td>
                <td title={t.fallbackError ?? undefined}>
                  {describeDevices(t.devicesUsed, t.fallbackError)}
                </td>
                <td>{t.segmentCount}</td>
                <td>{formatDuration(t.processingMs || null)}</td>
                <td>{t.realtimeFactor ? `×${t.realtimeFactor}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {comparisons.length > 0 && (
        <details className="compare">
          <summary>Comparaison des modèles (même audio, mêmes paramètres)</summary>
          {comparisons.map((g) => (
            <table
              key={`${g.audioIndex}-${g.transcriptions[0]?.id}`}
              className="runs"
              aria-label={`Comparaison ${g.audioIndex}`}
            >
              <caption>
                {ROLE_LABELS[g.role ?? 'unknown'] ?? 'Piste'}
                {!g.sameDevices && (
                  <span className="warn small">
                    {' '}
                    — périphériques différents : durées non comparables
                  </span>
                )}
              </caption>
              <thead>
                <tr>
                  <th>Modèle</th>
                  <th>Périphérique réel</th>
                  <th>Durée de traitement</th>
                  <th>Facteur temps réel</th>
                  <th>Segments</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.transcriptions.map((t) => (
                  <tr key={t.id}>
                    <td>{t.model}</td>
                    <td>{describeDevices(t.devicesUsed, t.fallbackError)}</td>
                    <td>{formatDuration(t.processingMs || null)}</td>
                    <td>{t.realtimeFactor ? `×${t.realtimeFactor}` : '—'}</td>
                    <td>{t.segmentCount}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setModel(t.model)}
                        disabled={t.model === model}
                      >
                        Afficher
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </details>
      )}

      {segments.length > 0 && (
        <>
          <div className="toolbar" aria-label="Filtre des pistes">
            {transcribedTracks.map((i) => (
              <label key={i}>
                <input
                  type="checkbox"
                  checked={!hiddenTracks.has(i)}
                  onChange={() =>
                    setHiddenTracks((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />{' '}
                <span className={`badge role-${trackRole(i)}`}>
                  {ROLE_LABELS[trackRole(i)] ?? 'Piste'}
                </span>
              </label>
            ))}
            <span className="muted">
              {visible.length} segment(s) — temps de l'enregistrement original
            </span>
          </div>
          <ol className="segments">
            {visible.map((s) => (
              <li
                key={s.id}
                className={`segment role-${s.role ?? 'unknown'}${s.suspicionReasons.length ? ' suspect' : ''}`}
              >
                <time className="ts">
                  {formatSourceMs(s.srcStartMs)} → {formatSourceMs(s.srcEndMs)}
                </time>
                <span className={`badge role-${s.role ?? 'unknown'}`}>
                  {ROLE_LABELS[s.role ?? 'unknown'] ?? 'Piste'}
                </span>
                <span className="text">{s.text}</span>
                {s.suspicionReasons.length > 0 && (
                  <span
                    className="flag"
                    title={`Score de suspicion ${s.suspicionScore} : ${s.suspicionReasons
                      .map((r) => SUSPICION_LABELS[r] ?? r)
                      .join(', ')}`}
                  >
                    suspect
                  </span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {segments.length === 0 && !busy && modelRuns.length > 0 && (
        <p className="muted">Aucun segment transcrit.</p>
      )}
    </section>
  );
}
