import { useEffect, useState } from 'react';
import { api, type Recording } from '../api';
import { formatDuration } from '../format';
import { warningLabel } from './media-warnings';
import { AnalysisPanel } from './AnalysisPanel';
import { ContentTypesPanel } from './ContentTypesPanel';
import { ClipsPanel } from './clips/ClipsPanel';
import { ReviewPanel } from './ReviewPanel';
import { TranscriptionPanel } from './TranscriptionPanel';

const ROLE_LABELS: Record<string, string> = {
  mix: 'Tout',
  mic: 'Micro',
  discord: 'Discord',
  game: 'Jeu',
  unknown: 'inconnu',
};

/**
 * Confirmation explicite des rôles supposés d'après l'ordre configuré (pistes sans nom) : tant
 * qu'elle n'est pas faite, ces pistes ne sont ni exportées ni sous-titrées (décision du serveur).
 */
function ConfirmRoles({
  recording: r,
  onChange,
}: {
  recording: Recording;
  onChange: (r: Recording) => void;
}) {
  const [roles, setRoles] = useState(() => r.audioTracks.map((t) => t.role));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange((await api.confirmTrackRoles(r.id, roles)).recording);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="warning small" data-testid="confirm-roles">
      <p>
        Rôles supposés d’après l’ordre des pistes (pistes sans nom) : ces pistes ne sont ni
        exportées ni sous-titrées tant que vous ne les avez pas confirmés.
      </p>
      {r.audioTracks.map((t, i) => (
        <label key={t.audioIndex}>
          Piste {t.audioIndex + 1}{' '}
          <select
            value={roles[i]}
            disabled={busy}
            onChange={(e) => setRoles(roles.map((x, k) => (k === i ? e.target.value : x)))}
          >
            {Object.entries(ROLE_LABELS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>{' '}
        </label>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => void confirm()}
        data-testid="confirm-roles-submit"
      >
        Confirmer ces rôles
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Pistes et état du fichier : un fichier incomplet n'est jamais présenté comme valide. */
export function RecordingHealth({
  recording: r,
  onChange,
}: {
  recording: Recording;
  onChange?: (r: Recording) => void;
}) {
  const degraded = r.health?.status === 'degraded';
  const single = r.audioTracks.length === 1;
  const assumed = r.audioTracks.some((t) => t.roleSource === 'config');
  return (
    <div className="small" data-testid="recording-health">
      <p className={degraded ? 'error' : 'muted'}>
        {degraded ? 'Fichier partiellement exploitable' : 'Fichier lisible'}
        {r.container ? ` · ${r.container.toUpperCase()}` : ''} · {r.audioTracks.length} piste(s)
        audio :{' '}
        {r.audioTracks
          .map((t) => `${ROLE_LABELS[t.role] ?? t.role}${t.title ? ` (« ${t.title} »)` : ''}`)
          .join(', ')}
      </p>
      {single && (
        <p className="muted">
          Piste unique : traitée comme « Tout » (son mixé d’origine, jamais séparé). Son export et
          ses sous-titres exigent la déclaration de sa composition et les accords des voix
          présentes.
        </p>
      )}
      {assumed && onChange && <ConfirmRoles key={r.id} recording={r} onChange={onChange} />}
      {(r.warnings ?? []).length > 0 && (
        <ul>
          {(r.warnings ?? []).map((w) => (
            <li key={w} className={r.health?.issues.includes(w) ? 'error' : 'muted'}>
              {warningLabel(w)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Import d'un fichier local par son chemin (rediffusion Twitch téléchargée, OBS…). */
function ImportForm({ onImported }: { onImported: (r: Recording, created: boolean) => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importRecording({ path: path.trim() });
      onImported(r.recording, r.created);
      setPath('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="import-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Chemin du fichier (MKV, MP4, MOV, M4V ou TS){' '}
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="D:\Rediffusions\stream.mp4"
          data-testid="import-path"
          disabled={busy}
        />
      </label>{' '}
      <button type="submit" disabled={busy || !path.trim()} data-testid="import-submit">
        {busy ? 'Contrôle du fichier…' : 'Importer'}
      </button>
      <p className="small muted">
        Le fichier est seulement lu, jamais modifié ni copié. Aucune connexion à Twitch.
      </p>
      {error && (
        <p className="error" role="alert" data-testid="import-error">
          {error}
        </p>
      )}
    </form>
  );
}

/** Enregistrements importés et leur transcription. */
export function Recordings() {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .recordings()
      .then((r) => setRecordings(r.recordings))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const onImported = (r: Recording, created: boolean) => {
    setRecordings((list) => [r, ...(list ?? []).filter((x) => x.id !== r.id)]);
    setSelected(r.id);
    setNotice(
      `${created ? 'Importé' : 'Déjà importé'} : ${r.fileName}${r.health?.status === 'degraded' ? ' — fichier partiellement exploitable, voir les anomalies' : ''}`,
    );
  };

  const current = recordings?.find((r) => r.id === selected) ?? null;

  return (
    <>
      <section className="card" aria-label="Enregistrements">
        <h2>Enregistrements</h2>
        <ImportForm onImported={onImported} />
        {notice && (
          <p className="small" role="status" data-testid="import-notice">
            {notice}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {recordings?.length === 0 && (
          <p className="muted">
            Aucun enregistrement. Importez-en un ci-dessus, ou avec{' '}
            <code>npm run import -- "chemin\vers\stream.mkv" --no-extract</code>.
          </p>
        )}
        {recordings && recordings.length > 0 && (
          <ul className="recordings">
            {recordings.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={r.id === selected}
                  onClick={() => setSelected(r.id)}
                >
                  {r.fileName}
                </button>{' '}
                <span className="muted">
                  {formatDuration(r.durationSec === null ? null : r.durationSec * 1000)} ·{' '}
                  {r.gameId}
                </span>
                {r.health?.status === 'degraded' && (
                  <span className="error small" data-testid="recording-degraded">
                    {' '}
                    · partiellement exploitable
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {current && (
          <RecordingHealth
            recording={current}
            onChange={(u) =>
              setRecordings((list) => (list ?? []).map((x) => (x.id === u.id ? u : x)))
            }
          />
        )}
      </section>
      {current && <TranscriptionPanel key={current.id} recording={current} />}
      {current && <ContentTypesPanel key={`content-${current.id}`} recording={current} />}
      {current && <AnalysisPanel key={`analysis-${current.id}`} recording={current} />}
      {current && <ReviewPanel key={`review-${current.id}`} recordingId={current.id} />}
      {current && <ClipsPanel key={`clips-${current.id}`} recordingId={current.id} />}
    </>
  );
}
