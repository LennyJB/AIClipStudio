# AI Clip Studio

Assistant de montage vidéo assisté par IA. Il analyse les enregistrements OBS après le stream,
repère les moments intéressants (humour, interactions, absurde, malentendus, réactions…) et
propose des clips verticaux pour TikTok, YouTube Shorts et Instagram Reels.

> **Principe directeur :** AI Clip Studio est un assistant monteur. Le créateur garde le dernier mot.

**État actuel : étape 2 terminée.** Import d'enregistrements OBS (par référence), lecture des
métadonnées, identification et extraction des pistes audio. La transcription et l'analyse ne sont
pas encore implémentées. Voir la [feuille de route](#feuille-de-route).

---

## Sommaire

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Commandes](#commandes)
- [Configuration](#configuration)
- [Importer un enregistrement](#importer-un-enregistrement)
- [Architecture](#architecture)
- [Sécurité](#sécurité)
- [Feuille de route](#feuille-de-route)

---

## Prérequis

| Outil         | Version            | Utilité                                          |
| ------------- | ------------------ | ------------------------------------------------ |
| Node.js       | ≥ 22.12 (LTS 22)   | Backend, orchestration, interface                |
| npm           | ≥ 10               | Gestion des dépendances (workspaces)             |
| FFmpeg        | ≥ 6 (avec ffprobe) | Métadonnées, extraction audio, rendu (plus tard) |
| Python        | 3.10 à 3.13        | Worker Faster-Whisper (étape 3)                  |
| Pilote NVIDIA | récent             | Transcription GPU (RTX 5070)                     |

Configuration cible : Ryzen 7 7700, RTX 5070 12 Go, 32 Go de RAM. Tous les traitements lourds
s'exécutent **après** le stream, en local.

### Windows (machine de production)

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install Gyan.FFmpeg
```

```bash
winget install Python.Python.3.13
```

Rouvrez le terminal après installation pour que `ffmpeg`, `node` et `py` soient dans le `PATH`.
`better-sqlite3` fournit un binaire précompilé pour Windows x64 : **aucun outil de compilation
C++ n'est requis**.

---

## Installation

### 1. Dépendances Node

```bash
npm install
```

### 2. Fichier de configuration

Copiez `.env.example` vers `.env` (Windows : `copy .env.example .env`, macOS/Linux :
`cp .env.example .env`), puis renseignez au minimum `ANTHROPIC_API_KEY` (nécessaire
seulement à partir de l'étape 4).

### 3. Environnement Python pour Faster-Whisper

Le venv est créé à la racine du projet dans `.venv/` (ignoré par Git). C'est l'emplacement
détecté automatiquement ; sinon renseignez `PYTHON_PATH` dans `.env`.

Windows (PowerShell) :

```bash
py -3.13 -m venv .venv
```

```bash
.venv\Scripts\python -m pip install -r packages/transcription/python/requirements.txt
```

macOS / Linux :

```bash
python3 -m venv .venv
```

```bash
.venv/bin/python -m pip install -r packages/transcription/python/requirements.txt
```

> **GPU :** les wheels de CTranslate2 incluent le support CUDA, mais Faster-Whisper a aussi
> besoin des bibliothèques **cuBLAS (CUDA 12) et cuDNN 9** côté système. Sur une RTX 50xx
> (architecture Blackwell), le bon fonctionnement GPU doit être **vérifié sur votre machine**
> avec `npm run doctor` puis lors de l'étape 3. En cas d'échec, `WHISPER_DEVICE=cpu` et
> `WHISPER_COMPUTE_TYPE=int8` permettent de continuer (plus lent).

### 4. Vérifier l'environnement

```bash
npm run doctor
```

Le diagnostic contrôle Node, FFmpeg/ffprobe, les encodeurs, SQLite, le dossier de stockage,
le venv Python, Faster-Whisper, CUDA, le GPU et la présence de la clé Claude. Il ne modifie rien.

### 5. Lancer l'application

```bash
npm run dev
```

- Interface : <http://127.0.0.1:5173>
- API : <http://127.0.0.1:4000/api/health>

---

## Commandes

| Commande                | Rôle                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `npm run dev`           | API (rechargement auto) + interface Vite en parallèle        |
| `npm run dev:api`       | API seule                                                    |
| `npm run dev:web`       | Interface seule                                              |
| `npm run start:api`     | API sans rechargement                                        |
| `npm run build:web`     | Build de production de l'interface                           |
| `npm run doctor`        | Diagnostic de l'environnement                                |
| `npm run import -- <f>` | Importe un enregistrement et extrait ses pistes audio        |
| `npm test`              | Tous les tests (unitaires + intégration)                     |
| `npm run test:watch`    | Tests en mode surveillance                                   |
| `npm run test:coverage` | Tests avec couverture                                        |
| `npm run typecheck`     | Vérification TypeScript de tous les workspaces               |
| `npm run lint`          | ESLint                                                       |
| `npm run format`        | Formatage Prettier                                           |
| `npm run check`         | typecheck + lint + format + tests (à lancer avant un commit) |

---

## Configuration

Toutes les variables sont lues **uniquement par le serveur** et validées au démarrage (Zod).
Une valeur invalide arrête le serveur avec un message qui nomme la variable, sans afficher sa
valeur.

| Variable               | Défaut                               | Description                           |
| ---------------------- | ------------------------------------ | ------------------------------------- |
| `ANTHROPIC_API_KEY`    | _(vide)_                             | Clé Claude API (secrète)              |
| `CLAUDE_MODEL`         | `claude-opus-5-5`                    | Modèle utilisé pour l'analyse         |
| `API_HOST`             | `127.0.0.1`                          | Interface d'écoute (local uniquement) |
| `API_PORT`             | `4000`                               | Port de l'API                         |
| `LOG_LEVEL`            | `info`                               | Niveau de logs                        |
| `STORAGE_DIR`          | `./storage`                          | Racine du stockage local              |
| `DATABASE_PATH`        | `./storage/db/ai-clip-studio.sqlite` | Base SQLite                           |
| `FFMPEG_PATH`          | `ffmpeg`                             | Binaire FFmpeg                        |
| `FFPROBE_PATH`         | `ffprobe`                            | Binaire ffprobe                       |
| `PYTHON_PATH`          | _(auto : `.venv`)_                   | Python du worker de transcription     |
| `WHISPER_MODEL`        | `large-v3`                           | Modèle Faster-Whisper                 |
| `WHISPER_DEVICE`       | `cuda`                               | `cuda` ou `cpu`                       |
| `WHISPER_COMPUTE_TYPE` | `float16`                            | `float16`, `int8_float16`, `int8`     |
| `WHISPER_LANGUAGE`     | `fr`                                 | Langue principale des sessions        |
| `AUDIO_TRACK_ROLES`    | `mix,mic,discord`                    | Rôle des pistes OBS, dans l'ordre     |

---

## Importer un enregistrement

### Principe

- L'enregistrement est **référencé par son chemin**, jamais copié ni modifié. Une empreinte
  (taille + 1er et dernier Mo) est enregistrée : un fichier déplacé ou modifié est détecté avant
  tout traitement, et réimporter le même fichier ne crée pas de doublon.
- Formats acceptés : **MKV** (enregistrements OBS) et **MP4** (fichier de secours à piste
  unique, traité comme un mix).
- Les pistes **micro** et **Discord** sont extraites séparément (WAV mono 16 kHz, format
  attendu par Faster-Whisper) dans `storage/processing/<id>/audio/`. La transcription séparée
  distingue naturellement le créateur de ses coéquipiers. La piste « tout » n'est utilisée qu'en
  l'absence de pistes de voix séparées.
- Le WAV est **aligné sur la timeline de la vidéo** : un décalage de départ ou un trou dans
  l'audio (images perdues par OBS) est comblé par du silence, pour que les timestamps de la
  transcription correspondent exactement à la vidéo.
- Un MKV d'un OBS qui a planté n'a souvent pas de durée lisible : il est accepté, et la durée est
  déduite de l'audio extrait.

Espace disque : environ **115 Mo par heure et par piste** extraite (≈ 1,8 Go pour un stream de
8 h avec micro + Discord).

### Rôle des pistes audio

Par ordre de priorité :

1. rôles imposés à l'import (`--roles` ou champ `trackRoles` de l'API) ;
2. fichier à piste unique → `mix` ;
3. **nom de la piste dans OBS** (Paramètres → Sortie → Audio → Nom) : un nom contenant
   « Micro », « Discord », « Tout »/« Mix » ou « Jeu » est reconnu ;
4. ordre défini par `AUDIO_TRACK_ROLES` dans `.env`.

Le plus fiable est de **nommer les pistes dans OBS** (« Tout », « Micro », « Discord ») : les
futurs enregistrements seront alors reconnus quel que soit l'ordre des pistes.

### En ligne de commande (tests sur de vrais enregistrements)

```bash
npm run import -- "D:\Enregistrements\2026-11-20 21-03-11.mkv" --game valorant
```

Options : `--game <id>` (valorant, fortnite, minecraft, generic), `--roles mix,mic,discord`,
`--no-extract` (métadonnées seulement). `Ctrl+C` interrompt proprement ; relancer la commande
reprend là où elle s'était arrêtée.

### API

| Méthode | Route                               | Rôle                                         |
| ------- | ----------------------------------- | -------------------------------------------- |
| GET     | `/api/games`                        | Profils de jeu disponibles                   |
| POST    | `/api/recordings`                   | Importer `{ path, gameId?, trackRoles? }`    |
| GET     | `/api/recordings`                   | Liste des enregistrements                    |
| GET     | `/api/recordings/:id`               | Détail, pistes et historique des traitements |
| PATCH   | `/api/recordings/:id/tracks`        | Corriger les rôles `{ roles: [...] }`        |
| POST    | `/api/recordings/:id/extract-audio` | Lancer l'extraction (asynchrone, 202)        |
| GET     | `/api/jobs/:id`                     | État et progression d'un traitement          |
| POST    | `/api/jobs/:id/cancel`              | Annuler un traitement                        |

Les traitements s'exécutent un par un. À l'arrêt du serveur, un traitement en cours est marqué
« interrompu » ; le relancer ne refait pas les pistes déjà extraites.

### Fichiers sur Google Drive

Si les enregistrements sont dans Google Drive pour ordinateur en mode **streaming**, la lecture
complète d'un fichier de plusieurs dizaines de Go déclenche son téléchargement (lent, et le
cache Drive occupe de l'espace sur `C:`). Préférez rendre le dossier **disponible hors connexion**
(ou le mode « mise en miroir »), ou traiter les fichiers depuis un disque local.

---

## Architecture

Voir [`docs/architecture.md`](docs/architecture.md) pour le détail des choix techniques, et
[`docs/proposition-editeur-memoire.md`](docs/proposition-editeur-memoire.md) pour l’évolution
prévue (éditeur vidéo, mémoire éditoriale) — en attente de validation.

```
AIClipStudio/
├── apps/web/                  Interface React (Vite) — aucun secret, passe par /api
├── services/api/              Serveur Fastify : config, logs, SQLite, orchestration
├── packages/
│   ├── shared/                Schémas Zod et types communs (contrats de données), erreurs
│   ├── media/                 FFmpeg/ffprobe : métadonnées, pistes, extraction (étape 2)
│   ├── transcription/         Pont Node ↔ Faster-Whisper
│   │   └── python/            Worker Python + requirements.txt (étape 3)
│   └── editorial/             Profils, fenêtres candidates, prompts, Claude (étape 4)
├── profiles/
│   ├── creator.json           Identité éditoriale du créateur (indépendante du jeu)
│   └── games/                 valorant, fortnite, minecraft, generic
├── storage/                   Données locales (ignorées par Git)
│   ├── originals/             Enregistrements importés — jamais modifiés
│   ├── processing/            Fichiers de travail (audio extrait, images, JSON)
│   ├── exports/               Rapports et futurs clips
│   └── db/                    Base SQLite
├── scripts/doctor.ts          Diagnostic de l'environnement
├── tests/                     Tests d'intégration transverses
├── .env.example
└── README.md
```

Pipeline du MVP : **Import → Préparation → Transcription → Pré-analyse → Analyse IA → Validation.**

---

## Sécurité

- La clé Claude reste côté serveur. Le frontend ne lit aucun `.env` (`envDir` Vite limité à
  `apps/web/`) et l'API ne renvoie qu'un booléen `claudeConfigured`.
- `.env`, `storage/`, `.venv/` et tous les fichiers médias/SQLite sont exclus de Git.
- Le serveur écoute sur `127.0.0.1` par défaut : il n'est pas exposé sur le réseau local.
- Les profils et la configuration sont validés par des schémas stricts (champs inconnus refusés).
- Les outils externes sont lancés avec `execFile` (sans shell) et des arguments contrôlés.
  Aucune commande produite par l'IA n'est exécutée.
- Les réponses d'erreur ne contiennent ni pile d'appel ni détail interne ; les logs masquent
  les en-têtes d'authentification.

---

## Feuille de route

| Étape | Contenu                                                                | État        |
| ----- | ---------------------------------------------------------------------- | ----------- |
| 1     | Analyse, architecture, squelette, outillage, documentation             | ✅ Terminée |
| 2     | Import OBS, ffprobe, inventaire et extraction des pistes audio         | ✅ Terminée |
| 3     | Transcription Faster-Whisper horodatée                                 | À faire     |
| 4     | Profils éditoriaux, prompts, appel Claude, validation JSON, clips      | À faire     |
| 5     | Interface de validation (liste, timestamps, lecture, accepter/refuser) | À faire     |
| 6     | Évaluation sur de vrais enregistrements, ajustement des prompts        | À faire     |

Le moteur de montage (FFmpeg + Remotion, 9:16, sous-titres, effets) viendra après validation
du MVP.
