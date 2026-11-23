import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Le frontend ne lit AUCUN fichier .env de la racine (envDir = ce dossier) :
// aucune clé serveur ne peut fuiter dans le bundle. Les appels /api passent
// par le proxy de dev vers le serveur local.
const API_TARGET = process.env.ACS_API_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  envDir: '.',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
});
