import { useEffect, useState } from 'react';
import { fetchHealth, type HealthResponse } from './api';
import { Recordings } from './components/Recordings';

type State =
  { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((health) => setState({ kind: 'ok', health }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="container">
      <h1>AI Clip Studio</h1>
      <p className="subtitle">Import, audio et transcription</p>
      <section className="card">
        <h2>État du serveur</h2>
        {state.kind === 'loading' && <p>Connexion à l’API…</p>}
        {state.kind === 'error' && <p className="error">{state.message}</p>}
        {state.kind === 'ok' && (
          <ul>
            <li>
              API : {state.health.status} (v{state.health.version})
            </li>
            <li>Base de données : {state.health.database}</li>
            <li>
              Claude API :{' '}
              {state.health.claudeConfigured
                ? 'clé configurée'
                : 'clé absente (requise à l’étape 4)'}
            </li>
          </ul>
        )}
      </section>
      <Recordings />
    </main>
  );
}
