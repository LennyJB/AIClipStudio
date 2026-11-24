import { useCallback, useEffect, useState } from 'react';
import {
  analysisApi,
  api,
  type AnalysisManifest,
  type AnalysisRun,
  type AnalysisSettings,
  type AnalysisWindow,
  type FramingPreview,
  type FramingProfile,
  type Job,
  type Recording,
} from '../api';
import {
  FRAMING_STATUS_LABELS,
  formatSourceMs,
  formatUsd,
  JOB_STATUS_LABELS,
  ROLE_LABELS,
  SIGNAL_LABELS,
} from '../format';

interface Props {
  recording: Recording;
  pollMs?: number;
}

/**
 * Analyse éditoriale, étape 4a : réglages de confidentialité, cadrage, préparation LOCALE
 * et relecture du contenu qui serait transmis. Aucun appel à Claude API.
 */
export function AnalysisPanel({ recording, pollMs = 1000 }: Props) {
  const id = recording.id;
  const [settings, setSettings] = useState<AnalysisSettings | null>(null);
  const [profiles, setProfiles] = useState<FramingProfile[]>([]);
  const [note, setNote] = useState('');
  const [profileId, setProfileId] = useState('');
  const [previewAt, setPreviewAt] = useState('');
  const [preview, setPreview] = useState<FramingPreview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<{ run: AnalysisRun; windows: AnalysisWindow[] } | null>(null);
  const [manifest, setManifest] = useState<AnalysisManifest | null>(null);
  // (null tant que la préparation n'est pas terminée)
  const [shown, setShown] = useState<{ title: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      fail(err);
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      analysisApi.settings(id),
      analysisApi.framingProfiles(),
      analysisApi.runs(id),
    ]).then(
      ([s, p, r]) => {
        if (cancelled) return;
        setSettings(s.settings);
        setProfiles(p.profiles);
        setProfileId(s.settings.framingProfileId ?? '');
        const last = r.runs.find((x) => x.status === 'completed');
        if (last) setRunId(last.id);
      },
      (err: unknown) => {
        if (!cancelled) fail(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loadRun = useCallback(async (rid: string) => {
    const r = await analysisApi.run(rid);
    // Le manifeste n'existe que pour une préparation terminée.
    const m = r.run.status === 'completed' ? await analysisApi.manifest(rid) : { manifest: null };
    return { r, m };
  }, []);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    loadRun(runId).then(
      ({ r, m }) => {
        if (cancelled) return;
        setRun(r);
        setManifest(m.manifest);
      },
      (err: unknown) => {
        if (!cancelled) fail(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, loadRun]);

  const busy = job !== null && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!busy || !job) return;
    const timer = setInterval(() => {
      api.job(job.id).then(
        (j) => setJob(j.job),
        () => undefined,
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [busy, job, pollMs]);

  // Fin du traitement : afficher la préparation (ou son erreur).
  const finished = job !== null && !busy;
  useEffect(() => {
    if (!finished || !runId) return;
    let cancelled = false;
    loadRun(runId).then(
      ({ r, m }) => {
        if (cancelled) return;
        setRun(r);
        setManifest(m.manifest);
      },
      (err: unknown) => {
        if (!cancelled) fail(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [finished, runId, loadRun]);

  const update = (patch: Record<string, unknown>) =>
    act(async () => setSettings((await analysisApi.updateSettings(id, patch)).settings));

  const prepare = (force: boolean) =>
    act(async () => {
      const res = await analysisApi.prepare(id, force);
      setShown(null);
      setRun(null);
      setRunId(res.run.id);
      setJob(res.job);
    });

  const est = run?.run.estimate ?? null;

  return (
    <section className="card" aria-label="Analyse éditoriale">
      <h2>Analyse éditoriale — préparation locale</h2>
      <p className="muted">
        Étape 4a : aucun appel à Claude API. La préparation repère les moments candidats et montre
        exactement ce qui serait transmis, avec le coût estimé.
      </p>
      {error && <p className="error">{error}</p>}

      {settings && (
        <fieldset>
          <legend>Confidentialité</legend>
          <p>
            Micro : texte transmis. Discord et piste « tout » :{' '}
            <strong>{settings.discordTextAllowed ? 'texte transmis' : 'texte non transmis'}</strong>
            {settings.discordTextAllowed && settings.discordConsentNote && (
              <span className="muted"> (accord : {settings.discordConsentNote})</span>
            )}
          </p>
          {settings.discordTextAllowed ? (
            <button type="button" onClick={() => void update({ discordTextAllowed: false })}>
              Retirer l’accord Discord
            </button>
          ) : (
            <span className="toolbar">
              <input
                aria-label="Note d’accord Discord"
                placeholder="Qui a donné son accord, et quand"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                disabled={note.trim().length < 3}
                onClick={() => void update({ discordTextAllowed: true, discordConsentNote: note })}
              >
                Autoriser le texte Discord pour cet enregistrement
              </button>
            </span>
          )}
          <p>
            <label>
              <input
                type="checkbox"
                checked={settings.facecamAllowed}
                onChange={(e) => void update({ facecamAllowed: e.target.checked })}
              />{' '}
              Envoyer aussi des images de la facecam (sinon elle est masquée)
            </label>
          </p>
        </fieldset>
      )}

      {settings && (
        <fieldset>
          <legend>Cadrage des images</legend>
          <p role="status">Cadrage : {FRAMING_STATUS_LABELS[settings.framingStatus]}</p>
          <div className="toolbar">
            <select
              aria-label="Profil de cadrage"
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                setPreview(null);
                void update({ framingProfileId: e.target.value || null });
              }}
            >
              <option value="">Aucun (aucune image)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <input
              aria-label="Instant de l’aperçu (secondes)"
              placeholder="instant (s)"
              size={8}
              value={previewAt}
              onChange={(e) => setPreviewAt(e.target.value)}
            />
            <button
              type="button"
              disabled={!profileId}
              onClick={() =>
                void act(async () =>
                  setPreview(
                    await analysisApi.preview(
                      id,
                      profileId,
                      previewAt ? Math.round(Number(previewAt) * 1000) : undefined,
                    ),
                  ),
                )
              }
            >
              Aperçu
            </button>
            <button
              type="button"
              disabled={!preview || !profileId}
              onClick={() =>
                void act(async () =>
                  setSettings((await analysisApi.validateFraming(id, profileId)).settings),
                )
              }
            >
              Valider ce cadrage
            </button>
          </div>
          {preview && (
            <div className="previews">
              {preview.files.map((f) => (
                <figure key={f.name}>
                  <img src={f.url} alt={f.kind} width={Math.min(480, f.width)} />
                  <figcaption>
                    {f.kind === 'annotated'
                      ? 'Annotée : jaune = gameplay, bleu = facecam, rouge = masqué'
                      : `Telle qu’envoyée (${f.kind})`}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <div className="toolbar">
        <button type="button" disabled={busy} onClick={() => void prepare(false)}>
          {busy ? 'Préparation en cours…' : 'Préparer l’analyse (sans appel API)'}
        </button>
        {run && (
          <button type="button" disabled={busy} onClick={() => void prepare(true)}>
            Refaire la préparation
          </button>
        )}
        {job && (
          <span role="status" className="muted">
            {JOB_STATUS_LABELS[job.status] ?? job.status} — {Math.round(job.progress * 100)} %
            {job.error && <span className="error"> {job.error.message}</span>}
          </span>
        )}
      </div>

      {run?.run.error && run.run.status !== 'completed' && (
        <p className="error">
          Préparation {run.run.status} : {run.run.error.message}
        </p>
      )}

      {run && manifest && (
        <>
          <h3>Ce qui serait transmis</h3>
          <ul>
            {manifest.tracks.map((t) => (
              <li key={t.audioIndex}>
                Piste {t.audioIndex + 1} ({ROLE_LABELS[t.role] ?? t.role}) :{' '}
                {t.textTransmitted ? 'texte transmis' : 'texte non transmis'} — {t.reason}
              </li>
            ))}
            <li>
              Images :{' '}
              {manifest.privacy.imagesSent
                ? 'gameplay recadré, zones sensibles masquées'
                : `aucune (${manifest.privacy.noImagesReason})`}
            </li>
            <li>
              Repérage global : {manifest.triage.scope}, {manifest.triage.chunks.length} tranche(s){' '}
              {manifest.triage.chunks.map((c) => (
                <button
                  key={c.index}
                  type="button"
                  className="link"
                  onClick={() =>
                    void act(async () =>
                      setShown({
                        title: `Repérage — tranche ${c.index}`,
                        text: (await analysisApi.triageChunk(run.run.id, c.index)).text,
                      }),
                    )
                  }
                >
                  {c.index}
                </button>
              ))}
            </li>
          </ul>

          {est && (
            <p>
              Coût estimé : ~{formatUsd(est.totals.typicalUsd)} (pire cas{' '}
              {formatUsd(est.totals.maxUsd)}) — plafond {formatUsd(est.budgetUsd)}. Sous le plafond
              : {est.fit.typicalWindows}/{est.fit.windowCount} fenêtre(s) au coût typique,{' '}
              {est.fit.worstCaseWindows}/{est.fit.windowCount} dans le pire cas.
            </p>
          )}

          <h3>Fenêtres candidates ({run.windows.length})</h3>
          {run.windows.length === 0 && (
            <p className="muted">
              Aucune zone ne ressort des signaux locaux. Le repérage global sur le texte (étape 4b)
              pourra encore trouver des remarques dites calmement.
            </p>
          )}
          {run.windows.length > 0 && (
            <table className="runs">
              <thead>
                <tr>
                  <th>Rang</th>
                  <th>Zone d’intérêt</th>
                  <th>Score local</th>
                  <th>Signaux</th>
                  <th>Images</th>
                  <th>Coût estimé</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {run.windows.map((w) => (
                  <tr key={w.id}>
                    <td>{w.rank}</td>
                    <td>
                      {formatSourceMs(w.coreStartMs)} → {formatSourceMs(w.coreEndMs)}
                    </td>
                    <td>{w.localScore.toFixed(2)}</td>
                    <td>
                      {[...new Set(w.signals.map((s) => SIGNAL_LABELS[s.kind] ?? s.kind))]
                        .slice(0, 4)
                        .join(', ')}
                    </td>
                    <td>{w.frames.length}</td>
                    <td>
                      {w.estimate?.typicalUsd !== undefined
                        ? `~${formatUsd(w.estimate.typicalUsd)} (max ${formatUsd(w.estimate.maxUsd ?? 0)})`
                        : '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          void act(async () =>
                            setShown({
                              title: `Fenêtre ${w.rank}`,
                              text: (await analysisApi.windowPayload(run.run.id, w.rank)).text,
                            }),
                          )
                        }
                      >
                        Voir le contenu
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shown && (
            <div aria-label="Contenu qui serait transmis">
              <h4>{shown.title} — contenu qui serait transmis</h4>
              <pre className="payload">{shown.text}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}
