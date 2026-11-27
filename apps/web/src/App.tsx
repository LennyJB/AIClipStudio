import { useEffect, useState } from 'react';
import { fetchHealth, type HealthResponse } from './api';
import { Recordings } from './components/Recordings';
import { EditorPage } from './editor/EditorPage';
import { LibraryPanel } from './library/LibraryPanel';

/** Route de l'éditeur : `#/editeur/<projet>` (aucun routeur : un seul écran supplémentaire). */
export function editorRoute(hash: string): string | null {
  const m = /^#\/editeur\/([A-Za-z0-9_-]{1,100})$/u.exec(hash);
  return m ? m[1]! : null;
}

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

type State =
  { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error'; message: string };

export function App() {
  const hash = useHash();
  const editing = editorRoute(hash);
  if (editing) {
    return (
      <main className="container editor-container">
        <EditorPage key={editing} projectId={editing} onClose={() => (window.location.hash = '')} />
      </main>
    );
  }
  return <Home />;
}

function Home() {
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
      <p className="subtitle">Import, transcription et préparation de l’analyse éditoriale</p>
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
                : 'clé absente (requise à l’étape 4b ; la préparation locale n’en a pas besoin)'}
            </li>
          </ul>
        )}
      </section>
      <Recordings />
      <LibraryPanel />
    </main>
  );
}
