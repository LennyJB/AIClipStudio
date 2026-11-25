# AI Clip Studio

[![CI](https://github.com/LennyJB/AIClipStudio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LennyJB/AIClipStudio/actions/workflows/ci.yml)

Assistant de montage vidéo assisté par IA. Il analyse les enregistrements OBS après le stream,
repère les moments intéressants (humour, interactions, absurde, malentendus, réactions…) et
propose des clips verticaux pour TikTok, YouTube Shorts et Instagram Reels.

> **Principe directeur :** AI Clip Studio est un assistant monteur. Le créateur garde le dernier mot.

**État actuel : étape 3 (transcription) en cours de validation.** Import d'enregistrements OBS,
fichiers audio dérivés et cache, file de traitements, espace disque, modèle temporel, et
**transcription locale avec Faster-Whisper** : blocs avec chevauchement, reprise, repli CPU,
comparaison des modèles, interface de consultation. L'analyse éditoriale (étape 4) n'est pas
commencée. Voir la [feuille de route](#feuille-de-route).

---

## Sommaire

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Commandes](#commandes)
- [Configuration](#configuration)
- [Importer un enregistrement](#importer-un-enregistrement)
- [Transcription](#transcription)
- [Architecture](#architecture)
- [Sécurité](#sécurité)
- [Workflow de développement](#workflow-de-développement)
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
`better-sqlite3` télécharge un binaire précompilé pour Windows x64 lors de `npm install` (accès
Internet requis) : **aucun outil de compilation C++ n'est nécessaire**. Ce point est vérifié à
chaque PR par le job Windows de la CI. La version 13 a été écartée : sous Windows, elle exige
Visual Studio à l'installation, même si son binaire est fourni.

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

GPU NVIDIA (facultatif) : bibliothèques cuBLAS et cuDNN 9, installées dans le même venv :

```bash
.venv\Scripts\python -m pip install -r packages/transcription/python/requirements-gpu.txt
```

> **GPU :** la compatibilité avec une RTX 50xx (Blackwell) **n'a pas pu être vérifiée** (aucun GPU
> dans l'environnement de développement ni dans la CI). Vérifiez-la avec une vraie inférence :
> `npm run doctor -- --gpu`. En cas d'échec, la transcription bascule sur CPU (plus lent) si
> `WHISPER_CPU_FALLBACK=true`. Détails : [`docs/transcription.md`](docs/transcription.md).

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

| Commande                               | Rôle                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run dev`                          | API (rechargement auto) + interface Vite en parallèle                                                 |
| `npm run dev:api`                      | API seule                                                                                             |
| `npm run dev:web`                      | Interface seule                                                                                       |
| `npm run start:api`                    | API sans rechargement                                                                                 |
| `npm run build:web`                    | Build de production de l'interface                                                                    |
| `npm run doctor`                       | Diagnostic de l'environnement                                                                         |
| `npm run import -- <f>`                | Importe un enregistrement et extrait ses pistes audio                                                 |
| `npm run storage`                      | Espace occupé ; `-- --clean` (simulation), `-- --clean --yes`                                         |
| `npm run transcribe -- <id \| chemin>` | Transcrit ; `--model`, `--force`, `--compare`                                                         |
| `npm run analyze -- <id> --dry-run`    | Prépare l'analyse localement (aucun appel à Claude)                                                   |
| `npm run analyze -- <id> --run`        | Analyse avec Claude : estimation, confirmation, plafond de réservation, pause de relecture avant Opus |
| `npm run analyze -- <id> --continue`   | Requêtes Opus relues : lance l'analyse approfondie mise en pause                                      |
| `npm run analyze -- <id> --requests`   | Requêtes réelles de la dernière analyse (`--window N` : contenu exact)                                |
| `npm run review -- <id>`               | Revue des propositions : liste, `--accept`, `--reject --reason`, `--reset`, `--detach`, `--export`    |
| `npm run render -- <propositionId> …`  | Projet de clip et rendu 9:16 : `--create`, `--preview`, `--final`, accords et déclarations audio      |
| `npm run doctor -- --claude`           | Clé et modèles Claude accessibles (aucune génération)                                                 |
| `npm run analysis-settings -- <id>`    | Confidentialité : accord Discord, facecam                                                             |
| `npm run framing -- <commande>`        | Cadrage des images : `list`, `preview`, `validate`, `clear`                                           |
| `npm run doctor -- --gpu`              | Vraie inférence sur le GPU (CUDA, cuBLAS, cuDNN)                                                      |
| `npm test`                             | Tous les tests (unitaires + intégration)                                                              |
| `npm run test:watch`                   | Tests en mode surveillance                                                                            |
| `npm run test:coverage`                | Tests avec couverture                                                                                 |
| `npm run typecheck`                    | Vérification TypeScript de tous les workspaces                                                        |
| `npm run lint`                         | ESLint                                                                                                |
| `npm run format`                       | Formatage Prettier                                                                                    |
| `npm run test:unit`                    | Tests unitaires (sans outil externe)                                                                  |
| `npm run test:integration`             | Tests d'intégration (FFmpeg réel)                                                                     |
| `npm run test:migrations`              | Migrations de base de données                                                                         |
| `npm run smoke`                        | Démarrage réel de l'API sur un stockage temporaire                                                    |
| `npm run check`                        | typecheck + lint + format + tests (à lancer avant un commit)                                          |

---

## Configuration

Toutes les variables sont lues **uniquement par le serveur** et validées au démarrage (Zod).
Une valeur invalide arrête le serveur avec un message qui nomme la variable, sans afficher sa
valeur.

| Variable                 | Défaut                               | Description                                         |
| ------------------------ | ------------------------------------ | --------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | _(vide)_                             | Clé Claude API (secrète)                            |
| `CLAUDE_MODEL`           | `claude-opus-5-5`                    | Modèle utilisé pour l'analyse                       |
| `API_HOST`               | `127.0.0.1`                          | Interface d'écoute (local uniquement)               |
| `API_PORT`               | `4000`                               | Port de l'API                                       |
| `LOG_LEVEL`              | `info`                               | Niveau de logs                                      |
| `STORAGE_DIR`            | `./storage`                          | Racine du stockage local                            |
| `DATABASE_PATH`          | `./storage/db/ai-clip-studio.sqlite` | Base SQLite                                         |
| `FFMPEG_PATH`            | `ffmpeg`                             | Binaire FFmpeg                                      |
| `FFPROBE_PATH`           | `ffprobe`                            | Binaire ffprobe                                     |
| `PYTHON_PATH`            | _(auto : `.venv`)_                   | Python du worker de transcription                   |
| `WHISPER_*`              | voir `docs/transcription.md`         | Transcription (modèle, GPU/CPU, langue, VAD, blocs) |
| `AUDIO_TRACK_ROLES`      | `mix,mic,discord`                    | Rôle des pistes OBS, dans l'ordre                   |
| `CACHE_MAX_GB`           | `30`                                 | Taille max du cache des dérivés                     |
| `CLIP_WINDOW_MARGIN_SEC` | `30`                                 | Marge autour d'un clip                              |
| `CLIP_WINDOW_GRID_SEC`   | `30`                                 | Alignement des fenêtres de clip                     |

---

## Importer un enregistrement

### Principe

- L'enregistrement est **référencé par son chemin**, jamais copié ni modifié. Une empreinte
  (taille + 1er et dernier Mo) est enregistrée : un fichier déplacé ou modifié est détecté avant
  tout traitement, et réimporter le même fichier ne crée pas de doublon.
- Formats acceptés : **MKV** (enregistrements OBS) et **MP4** (fichier de secours à piste
  unique, traité comme un mix).
- Le WAV est **aligné sur la timeline de la vidéo** : un décalage de départ ou un trou dans
  l'audio (images perdues par OBS) est comblé par du silence, pour que les timestamps de la
  transcription correspondent exactement à la vidéo. Écart mesuré entre l'extraction d'une
  portion et celle de l'enregistrement complet : **3,6 ms** (moins d'un quart d'image à 60 i/s).
- Un MKV d'un OBS qui a planté n'a souvent pas de durée lisible : il est accepté, et la durée est
  déduite de l'audio extrait.

### Fichiers dérivés (produits à la demande, mis en cache)

| Usage                   | Format                                          | Portée                   | Pistes                                               | Taille                |
| ----------------------- | ----------------------------------------------- | ------------------------ | ---------------------------------------------------- | --------------------- |
| Transcription (Whisper) | WAV 16 kHz mono                                 | Tout l'enregistrement    | micro + Discord (sinon le mix)                       | ≈ 115 Mo / h / piste  |
| Montage (futur éditeur) | WAV 48 kHz stéréo                               | Fenêtre autour d'un clip | micro + Discord + jeu si piste « Jeu », sinon le mix | ≈ 11 Mo / min / piste |
| Forme d'onde            | `.dat` (audiowaveform v1, 8 bits, 100 points/s) | Comme l'audio d'origine  | —                                                    | ≈ 0,7 Mo / h / piste  |

- Une demande déjà satisfaite (fichier identique, **ou fenêtre plus large déjà préparée**) est
  servie depuis le cache, sans traitement.
- Les fenêtres de clip sont élargies de `CLIP_WINDOW_MARGIN_SEC` puis alignées sur
  `CLIP_WINDOW_GRID_SEC` : deux clips proches partagent la même extraction.
- Chaque fichier est rattaché à l'empreinte de l'original : si l'original change, ses anciens
  dérivés ne sont plus jamais servis.

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

| Méthode | Route                                     | Rôle                                                        |
| ------- | ----------------------------------------- | ----------------------------------------------------------- |
| GET     | `/api/games`                              | Profils de jeu disponibles                                  |
| POST    | `/api/recordings`                         | Importer `{ path, gameId?, trackRoles? }`                   |
| GET     | `/api/recordings`                         | Liste des enregistrements                                   |
| GET     | `/api/recordings/:id`                     | Détail, fichiers dérivés et historique des traitements      |
| PATCH   | `/api/recordings/:id/tracks`              | Corriger les rôles `{ roles: [...] }`                       |
| POST    | `/api/recordings/:id/transcription-audio` | Audio pour Whisper (200 si prêt, 202 si en préparation)     |
| POST    | `/api/recordings/:id/audio-stems`         | Pistes de montage `{ srcStartMs, srcEndMs }` (200 / 202)    |
| POST    | `/api/derivatives/:id/waveform`           | Forme d'onde d'un fichier audio dérivé (200 / 202)          |
| GET     | `/api/jobs/:id`                           | État et progression d'un traitement                         |
| POST    | `/api/jobs/:id/cancel`                    | Annuler un traitement                                       |
| GET     | `/api/storage`                            | Espace occupé (par usage, par enregistrement, disque libre) |
| POST    | `/api/storage/clean`                      | Nettoyage `{ dryRun = true, evictAllCache = false }`        |

Traitements :

- **Deux files d'exécution**, une tâche à la fois dans chacune : `heavy` (transcription, plus
  tard le rendu) et `interactive` (préparation de clips). La préparation d'un clip n'attend donc
  pas une transcription d'une heure.
- **Déduplication** : deux demandes identiques partagent le même traitement. Plusieurs clips d'un
  même enregistrement sont préparés indépendamment.
- **Reprise** : à l'arrêt du serveur, un traitement en cours est marqué « interrompu ». Le
  redemander ne refait que ce qui manque.

### Espace disque

```bash
npm run storage
```

```bash
npm run storage -- --clean
```

```bash
npm run storage -- --clean --yes
```

- La première commande affiche le rapport. `--clean` **simule** le nettoyage ; `--yes` l'exécute ;
  `--all-cache` vide aussi tout le cache, qui est régénérable.
- Peuvent être supprimés : fichiers temporaires `.part`, fichiers orphelins de plus d'une heure,
  cache au-delà de `CACHE_MAX_GB`, du moins récemment utilisé au plus récent. L'éviction est aussi
  automatique après chaque traitement.
- Ne sont **jamais** supprimés : les enregistrements originaux, les projets et exports, la base de
  données, les dérivés épinglés, ni un fichier utilisé par un traitement en cours.
- Le nettoyage n'agit que dans `storage/processing/`.

### Fichiers sur Google Drive

Si les enregistrements sont dans Google Drive pour ordinateur en mode **streaming**, la lecture
complète d'un fichier de plusieurs dizaines de Go déclenche son téléchargement (lent, et le
cache Drive occupe de l'espace sur `C:`). Préférez rendre le dossier **disponible hors connexion**
(ou le mode « mise en miroir »), ou traiter les fichiers depuis un disque local.

---

## Transcription

Transcription **locale** (aucun audio envoyé à l'extérieur) des pistes micro et Discord, en temps
source, avec mots horodatés. Guide complet, compromis précision/VRAM/temps et limites :
[`docs/transcription.md`](docs/transcription.md).

```bash
npm run transcribe -- "D:\Enregistrements\stream.mkv" --game valorant
```

Interface : `npm run dev`, puis « Enregistrements », choisir le fichier, « Transcrire ».

---

## Analyse éditoriale (étape 4)

Repère les moments candidats à partir de **signaux locaux factuels** (échanges micro ↔ Discord,
questions, rires et interjections **transcrits**, niveau sonore), prépare **exactement** le
contenu qui serait transmis à Claude et estime son coût sous un plafond de 5 $.
La préparation ne fait **aucun appel** ; l'analyse avec Claude (repérage Haiku 5.5, analyse Opus 5.5)
exige une confirmation explicite du plafond. Ce plafond est un **plafond de réservation** : aucun
appel n'est envoyé si son pire cas estimé ne tient pas dessous, mais ce n'est **pas une garantie
absolue sur la facture** (le coût réel peut exceptionnellement le dépasser légèrement ; l'analyse
s'arrête alors et le dépassement est affiché). Guide complet : [`docs/analyse-editoriale.md`](docs/analyse-editoriale.md).

```bash
npm run analyze -- <id> --dry-run              # préparer, résumer, estimer
npm run analyze -- <id> --dry-run --window 1   # relire la requête exacte qui serait envoyée
npm run analyze -- <id> --run                  # analyse payante : « oui », repérage, PAUSE (requêtes Opus à relire)
npm run analyze -- <id> --requests --window 2  # relire une requête Opus réelle avant son envoi
npm run analyze -- <id> --continue             # second « oui » : analyse Opus
npm run analyze -- <id> --proposals            # clips puis moments secondaires
```

Par défaut, seul le texte du **micro** serait transmis (pseudonymisé) ; Discord et la piste
« tout » exigent un accord par enregistrement ; aucune image sans profil de cadrage validé ;
la facecam est masquée.

## Revue des propositions (étape 5)

Le panneau « Revue des propositions » permet d'accepter ou de refuser chaque proposition, avec un
ou plusieurs motifs, et d'écouter le passage sur la piste « tout ». Chaque décision est
enregistrée dans un journal éditorial, sans doublon, pour les statistiques de l'étape 6. Une
proposition déjà jugée dans une analyse précédente est signalée « Déjà examinée ». Rien n'est
envoyé à Claude et aucune préférence n'est activée. Guide :
[`docs/validation-propositions.md`](docs/validation-propositions.md).

```bash
npm run review -- <id>                                   # propositions à examiner
npm run review -- --reject <propositionId> --reason chute_coupee --comment "…"
npm run review -- --export > retours.jsonl               # journal pour l'étape 6
```

## Clips verticaux (étape 6)

Une proposition **acceptée** devient un projet de clip, puis un rendu vertical 9:16 (aperçu
basse définition ou export final 1080×1920) : cadrage gameplay / facecam, zones sensibles
masquées, sous-titres incrustés (corrigeables, noms pseudonymisés), volume normalisé à −14 LUFS
(désactivable), fréquence d'images de la source plafonnée à 60 i/s. Aucune voix de tiers n'est
exportée sans accord explicite de l'enregistrement, micro compris. Aucune publication : l'export
s'arrête au dossier `storage/exports/`. Plan et règles : [`docs/plan-etape-6.md`](docs/plan-etape-6.md).

```bash
npm run render -- --declare-mic <id> --creator-voice present --other-voices absent
npm run render -- <propositionId> --create --layout facecam_top
npm run render -- <propositionId> --preview --enable-allowed-audio   # aperçu (processing/)
npm run render -- <propositionId> --final                            # export (storage/exports/)
npm run doctor -- --render                                           # filtres, polices, intégrité
```

---

## Architecture

Voir [`docs/architecture.md`](docs/architecture.md) pour le détail des choix techniques, et
[`docs/proposition-editeur-memoire.md`](docs/proposition-editeur-memoire.md) pour l’évolution
prévue (éditeur vidéo, mémoire éditoriale), validée.

```
AIClipStudio/
├── apps/web/                  Interface React (Vite) — aucun secret, passe par /api
├── services/api/              Serveur Fastify : config, logs, SQLite, orchestration
├── packages/
│   ├── shared/                Schémas Zod et types communs (contrats de données), erreurs
│   ├── media/                 FFmpeg/ffprobe : métadonnées, pistes, extraction, formes d'onde
│   ├── timeline/              Modèle du montage : SourceMs / EditMs, segments, conversions
│   ├── transcription/         Blocs, reprise, déduplication ; worker Python Faster-Whisper
│   │   └── python/            Worker Python + requirements.txt (étape 3)
│   ├── editorial/             Profils, signaux, fenêtres, confidentialité, coûts, prompts, client Claude
│   └── memory/                Mémoire éditoriale : motifs, décisions, moments, décision effective
├── profiles/
│   ├── creator.json           Identité éditoriale du créateur (indépendante du jeu)
│   ├── games/                 valorant, fortnite, minecraft, generic
│   └── framing/               Profils de cadrage des images (gameplay, facecam, zones masquées)
├── storage/                   Données locales (ignorées par Git)
│   ├── originals/             Enregistrements importés — jamais modifiés
│   ├── processing/            Fichiers dérivés en cache (régénérables)
│   ├── analysis/              Contenu préparé pour l'analyse (consultable avant tout envoi)
│   ├── config/                privacy.json : pseudonymes (noms réels, jamais versionné)
│   ├── exports/               Rapports et futurs clips
│   └── db/                    Base SQLite
├── scripts/                   doctor, import, storage, transcribe, analyze, analysis-settings
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
- Les transcriptions sont traitées comme des **données non fiables** (neutralisées, encadrées) ;
  rien n'est transmis à l'extérieur sans être d'abord consultable (`npm run analyze -- --dry-run`).
- Les réponses d'erreur ne contiennent ni pile d'appel ni détail interne ; les logs masquent
  les en-têtes d'authentification.

---

## Workflow de développement

Branche de référence `main`, une branche et une Pull Request par étape, CI GitHub Actions
obligatoire, fusion par le créateur uniquement. Détails : [`docs/workflow.md`](docs/workflow.md).

```bash
npm run check
```

Cette commande reproduit en local les vérifications de la CI : types, lint, formatage, tests
unitaires et d'intégration, build et démarrage de l'API.

---

## Feuille de route

| Étape | Contenu                                                                              | État          |
| ----- | ------------------------------------------------------------------------------------ | ------------- |
| 1     | Analyse, architecture, squelette, outillage, documentation                           | ✅ Terminée   |
| 2     | Import OBS, extraction audio, dérivés et cache, file, espace disque, modèle temporel | ✅ Terminée   |
| 3     | Transcription Faster-Whisper horodatée, reprise, repli CPU, comparaison des modèles  | ✅ Terminée   |
| 4a    | Signaux locaux, fenêtres, confidentialité, cadrage, contenu préparé, coûts estimés   | ✅ Terminée   |
| 4b    | Appels Claude (repérage + analyse), vérifications, pertinence et fiabilité           | ✅ Terminée   |
| 5     | Validation (liste, contexte, écoute, accepter/refuser, motifs), mémoire v1 (capture) | En revue (PR) |
| 6     | Évaluation sur de vrais enregistrements, ajustement des prompts                      | À faire       |

Le moteur de montage (FFmpeg + Remotion, 9:16, sous-titres, effets) viendra après validation
du MVP.
