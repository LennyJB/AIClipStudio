import { useEffect, useState } from 'react';
import { api, type Recording } from '../api';
import { formatDuration } from '../format';
import { AnalysisPanel } from './AnalysisPanel';
import { TranscriptionPanel } from './TranscriptionPanel';

/** Enregistrements importés (import : `npm run import -- "<chemin>"`) et leur transcription. */
export function Recordings() {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .recordings()
      .then((r) => setRecordings(r.recordings))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const current = recordings?.find((r) => r.id === selected) ?? null;

  return (
    <>
      <section className="card" aria-label="Enregistrements">
        <h2>Enregistrements</h2>
        {error && <p className="error">{error}</p>}
        {recordings?.length === 0 && (
          <p className="muted">
            Aucun enregistrement. Importez-en un avec{' '}
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
              </li>
            ))}
          </ul>
        )}
      </section>
      {current && <TranscriptionPanel key={current.id} recording={current} />}
      {current && <AnalysisPanel key={`analysis-${current.id}`} recording={current} />}
    </>
  );
}
