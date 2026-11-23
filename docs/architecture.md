# Architecture et choix techniques

Ce document explique **pourquoi** le projet est organisé ainsi. Il complète le cahier des
charges (v1.2) et le plan technique du MVP (v1.0).

## 1. Principes

1. **Un monolithe modulaire, pas de microservices.** Un seul processus Node (API +
   orchestration) découpé en packages indépendants aux responsabilités claires.
2. **Les décisions de l'IA sont séparées de leur exécution.** Le package `editorial` produit
   des propositions validées (JSON strict) ; seul le code applicatif décide de ce qui est
   exécuté (FFmpeg, etc.), avec des paramètres contrôlés.
3. **Traitement local et différé.** Rien ne tourne pendant le stream ; FFmpeg et
   Faster-Whisper s'exécutent sur la machine du créateur.
4. **Jeu et créateur sont deux axes indépendants.** Le pipeline est commun ; les
   particularités vivent dans `profiles/games/*.json` et l'identité éditoriale dans
   `profiles/creator.json`.
5. **Les originaux sont en lecture seule.** Toute sortie va dans `storage/processing/` ou
   `storage/exports/`.

## 2. Correspondance avec le plan technique

| Brique du plan technique | Emplacement                                                       | Étape |
| ------------------------ | ----------------------------------------------------------------- | ----- |
| Importeur                | `services/api` (routes) + `packages/media`                        | 2     |
| Media Processor          | `packages/media`                                                  | 2     |
| Transcription Service    | `packages/transcription` (+ `python/`)                            | 3     |
| Candidate Detector       | `packages/editorial`                                              | 4     |
| Editorial Analyzer       | `packages/editorial`                                              | 4     |
| Validator                | schémas dans `packages/shared`, contrôles métier dans `editorial` | 4     |
| Review UI                | `apps/web`                                                        | 5     |

## 3. Écarts par rapport à l'arborescence indicative (et pourquoi)

| Changement                                                                         | Raison                                                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles/games/generic.json` ajouté                                               | Le cahier des charges demande un profil générique ; c'est aussi le profil de repli explicite.                                          |
| `packages/transcription/python/`                                                   | Le worker Faster-Whisper est en Python (pas de binding Node fiable). Il est rangé avec le package qui le pilote.                       |
| `storage/db/`                                                                      | Sépare la base SQLite des fichiers médias.                                                                                             |
| `scripts/doctor.ts`                                                                | Diagnostic reproductible, indispensable car la machine de production (Windows + RTX 5070) diffère de l'environnement de développement. |
| `docs/`                                                                            | Décisions d'architecture documentées.                                                                                                  |
| Tests unitaires **à côté du code** (`*.test.ts`), `tests/` réservé à l'intégration | Les tests restent proches de ce qu'ils vérifient ; `tests/` couvre ce qui traverse plusieurs packages.                                 |

## 4. Choix des outils

| Besoin                    | Choix                                                                                 | Justification                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo                  | **npm workspaces**                                                                    | Fourni avec Node, aucun outil supplémentaire à installer sous Windows.                                                                    |
| Langage                   | **TypeScript 6.0** (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | TypeScript 7 existe mais `typescript-eslint` ne le supporte pas encore (< 6.1).                                                           |
| Exécution TS              | **tsx**                                                                               | Exécute directement les sources ; les packages internes exportent leur `src/index.ts`, donc pas d'étape de build interne.                 |
| Serveur HTTP              | **Fastify 5**                                                                         | Logs JSON intégrés (pino), injection de requêtes pour les tests, performant.                                                              |
| Validation                | **Zod 4**                                                                             | Un seul schéma = type TypeScript + validation à l'exécution (config, profils, réponses Claude).                                           |
| Base de données           | **better-sqlite3**                                                                    | SQLite synchrone, mature, binaires précompilés pour Windows x64 (pas de compilation). `node:sqlite` est encore expérimental dans Node 22. |
| Logs                      | **pino** (via Fastify) + pino-pretty en dev                                           | JSON structuré exploitable, lisible en développement.                                                                                     |
| Interface                 | **React 19 + Vite 8**                                                                 | Démarrage rapide, proxy `/api` en dev (pas de CORS à ouvrir).                                                                             |
| Tests                     | **Vitest 5**                                                                          | Compatible TS/ESM sans configuration, projets `unit` et `integration`.                                                                    |
| Qualité                   | **ESLint 10 + typescript-eslint + Prettier**                                          | Règles standard, imports de types cohérents.                                                                                              |
| Variables d'environnement | `process.loadEnvFile` (natif Node)                                                    | Pas de dépendance `dotenv`.                                                                                                               |

### Dépendances prévues aux étapes suivantes (non installées)

| Paquet                                          | Étape     | Utilité                                                       |
| ----------------------------------------------- | --------- | ------------------------------------------------------------- |
| `faster-whisper` (Python)                       | 3         | Transcription locale horodatée (déjà dans `requirements.txt`) |
| `@anthropic-ai/sdk`                             | 4         | Appels Claude API (sorties structurées validées par Zod)      |
| `@fastify/multipart` ou import par chemin local | 2         | À décider : voir questions ouvertes                           |
| `remotion`, `@remotion/*`                       | Après MVP | Rendu des montages 9:16                                       |

## 5. Points de vigilance identifiés

- **RTX 5070 (Blackwell) + CTranslate2** : support CUDA à confirmer sur la machine réelle
  (`npm run doctor`). Repli possible en CPU `int8`.
- **VRAM 12 Go** : `large-v3` en `float16` tient en mémoire ; `int8_float16` en réserve.
- **Pistes audio OBS** : la séparation micro / audio du jeu / Discord dépend de la
  configuration OBS du créateur ; elle conditionne la qualité de la transcription et la
  distinction des intervenants.
- **Gros fichiers** : un enregistrement de plusieurs heures pèse plusieurs dizaines de Go ;
  l'import doit **référencer ou copier** sans charger le fichier en mémoire.
- **Coûts API** : ne jamais envoyer des heures de transcription brute ; découpage en fenêtres
  candidates et mesure des coûts dès l'étape 4.

## 6. Décisions de l'étape 2 (import et audio)

| Décision                                                                                                | Raison                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import par référence** (chemin + empreinte), pas de copie                                             | Fichiers de 20 à 40 Go ; demande du créateur. L'empreinte (sha256 de la taille + 1er/dernier Mo) détecte doublons et originaux modifiés en lisant 2 Mo seulement.                                                                                                                                                                |
| Les pistes **micro** et **Discord** sont transcrites séparément, la piste « tout » seulement en secours | Évite de transcrire deux fois les mêmes voix ; donne gratuitement la distinction créateur / coéquipiers.                                                                                                                                                                                                                         |
| `aresample=async=1:first_pts=0` à l'extraction                                                          | **Mesuré** : sans ce filtre, une piste démarrant à 2 s produit un WAV décalé de 2 s (timestamps faux). Avec, le silence initial est conservé et les trous comblés.                                                                                                                                                               |
| Durée inconnue acceptée, puis déduite de l'audio                                                        | **Mesuré** : un MKV non finalisé (OBS qui plante) n'expose aucune durée ; FFmpeg en extrait pourtant l'audio.                                                                                                                                                                                                                    |
| Extraction de toutes les pistes **en un seul passage** FFmpeg                                           | Le fichier source n'est lu qu'une fois (deux fois moins d'octets lus). Sur le disque rapide de développement, aucun gain de temps mesurable (≈ 5 s pour 10 min de vidéo 720p à 8 Mb/s, CPU limitant) ; le gain attendu concerne les disques lents et Google Drive, **non mesuré**. Sorties vérifiées identiques octet par octet. |
| Écriture dans `*.part` puis renommage                                                                   | Un traitement interrompu ne laisse jamais un fichier final incomplet ; la reprise se fonde sur les fichiers finaux présents.                                                                                                                                                                                                     |
| File de traitements en mémoire, persistée dans SQLite, **un traitement à la fois**                      | Pas de Redis/BullMQ pour un usage local mono-utilisateur ; FFmpeg et Whisper ne doivent pas se concurrencer. Au redémarrage, les traitements « en cours » deviennent « interrompus » (relançables).                                                                                                                              |
| Rôles des pistes : imposés > piste unique > nom OBS > `AUDIO_TRACK_ROLES`                               | L'ordre des pistes peut varier selon la configuration OBS ; les noms de pistes sont la source la plus fiable.                                                                                                                                                                                                                    |
