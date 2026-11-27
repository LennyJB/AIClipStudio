/** Constantes partagées par le serveur d'API e2e, la configuration Playwright et les tests. */
import { tmpdir } from 'node:os';
import path from 'node:path';

export const E2E = {
  apiPort: 4610,
  webPort: 5199,
  /** Origine de l'interface (Vite) : seule origine autorisée pour les médias de l'éditeur. */
  origin: 'http://127.0.0.1:5199',
  /** Autre origine locale (même Vite, autre nom d'hôte) : refusée par l'API. */
  otherOrigin: 'http://localhost:5199',
  stateFile: path.join(tmpdir(), 'acs-e2e-state.json'),
  /** Zone sensible BLANCHE de la vidéo (pixels de la source 320×180). */
  sensitive: { x: 220, y: 10, w: 80, h: 50 },
} as const;
