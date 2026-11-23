# Migration 2 : dérivés, cache, file de traitements, espace disque

> **Statut : validée et implémentée** (migration `version 2` dans `services/api/src/db.ts`,
> testée sur des données v1 synthétiques et sur une base v1 réelle). Conception : `docs/architecture.md` § 7.

## 1. Changements de schéma

### 1.1 Nouvelle table `media_derivatives`

```sql
CREATE TABLE media_derivatives (
  id                   TEXT PRIMARY KEY,
  cache_key            TEXT NOT NULL UNIQUE,         -- sha256(empreinte, usage, piste, plage, paramètres, version)
  recording_id         TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  source_fingerprint   TEXT NOT NULL,                -- empreinte de l'original au moment de la production
  kind                 TEXT NOT NULL CHECK (kind IN
                         ('audio_transcription','audio_stem','waveform','video_proxy','thumbnail')),
  audio_index          INTEGER,                      -- NULL pour un dérivé vidéo
  src_start_ms         INTEGER,                      -- SourceMs ; NULL = tout l'enregistrement
  src_end_ms           INTEGER,
  params_json          TEXT NOT NULL,                -- ex. {"sampleRate":48000,"channels":2,"codec":"pcm_s16le"}
  generator_version    INTEGER NOT NULL,
  input_derivative_id  TEXT REFERENCES media_derivatives(id) ON DELETE SET NULL, -- ex. forme d'onde ← WAV
  rel_path             TEXT NOT NULL UNIQUE,         -- relatif à STORAGE_DIR
  size_bytes           INTEGER NOT NULL,
  duration_ms          INTEGER,
  retention            TEXT NOT NULL DEFAULT 'cache' CHECK (retention IN ('cache','keep')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((src_start_ms IS NULL) = (src_end_ms IS NULL)),
  CHECK (src_start_ms IS NULL OR (src_start_ms >= 0 AND src_start_ms < src_end_ms))
);
CREATE INDEX media_derivatives_lookup
  ON media_derivatives(recording_id, kind, audio_index, generator_version);
CREATE INDEX media_derivatives_lru ON media_derivatives(retention, last_used_at);
```

Une ligne n'est insérée **qu'une fois le fichier final écrit**, après le renommage du `.part`.
Il n'existe donc jamais de ligne pointant vers un fichier incomplet.

### 1.2 Table `jobs` reconstruite

SQLite ne permet pas de rendre `recording_id` facultatif sans reconstruire la table. La
reconstruction se fait en transaction : création, copie, suppression de l'ancienne, renommage.

```sql
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  lane           TEXT NOT NULL CHECK (lane IN ('heavy','interactive')),
  target_key     TEXT NOT NULL,                      -- unicité des traitements actifs
  recording_id   TEXT REFERENCES recordings(id) ON DELETE CASCADE,  -- désormais facultatif
  params_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL CHECK (status IN
                   ('queued','running','succeeded','failed','interrupted','cancelled')),
  progress       REAL NOT NULL DEFAULT 0,
  result_json    TEXT,                               -- ex. identifiants des dérivés produits
  error_code     TEXT,
  error_message  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at     TEXT,
  finished_at    TEXT
);
CREATE UNIQUE INDEX jobs_active_target ON jobs(target_key) WHERE status IN ('queued','running');
CREATE INDEX jobs_queue_idx ON jobs(lane, status, created_at);
CREATE INDEX jobs_recording_idx ON jobs(recording_id, created_at);
```

Reprise des données existantes : `type` `extract_audio` → `extract_transcription_audio`,
`lane` = `heavy`, `target_key` = `recording:<id>:transcription_audio`, `params_json` = `{}`.

### 1.3 Nouvelle table `job_files`

```sql
CREATE TABLE job_files (
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  rel_path  TEXT NOT NULL,                           -- relatif à STORAGE_DIR
  usage     TEXT NOT NULL CHECK (usage IN ('input','output')),
  PRIMARY KEY (job_id, rel_path)
);
CREATE INDEX job_files_path_idx ON job_files(rel_path);
```

Les fichiers sont déclarés **avant** le lancement de FFmpeg. Le nettoyage exclut tout
`rel_path` lié à un traitement `queued` ou `running`.

### 1.4 Table `audio_tracks` simplifiée

1. Les valeurs existantes de `extracted_path`, `extracted_duration_sec` et `extracted_at` sont
   converties en lignes `media_derivatives` (`kind = 'audio_transcription'`, chemin rendu
   relatif). Un chemin hors de `storage/` ou un fichier absent est ignoré.
2. Les trois colonnes sont ensuite supprimées (`ALTER TABLE … DROP COLUMN`, disponible depuis
   SQLite 3.35 ; la version embarquée est la 3.54).

Les autres colonnes (inventaire et rôles des pistes) sont inchangées.

### 1.5 Tables inchangées

`recordings` et `schema_migrations`.

### 1.6 Nouvelles variables de configuration

| Variable                 | Défaut | Rôle                                                     |
| ------------------------ | ------ | -------------------------------------------------------- |
| `CACHE_MAX_GB`           | `30`   | Au-delà, éviction LRU des dérivés `cache`                |
| `CLIP_WINDOW_MARGIN_SEC` | `30`   | Marge autour d'un clip pour les pistes de montage        |
| `CLIP_WINDOW_GRID_SEC`   | `30`   | Alignement des fenêtres, pour favoriser la réutilisation |

## 2. Conséquences sur les traitements existants

| Élément                    | Avant                                                          | Après                                                                                                                                                                                                                             | Impact                                                                                              |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Extraction pour Whisper    | `extract_audio`                                                | `extract_transcription_audio`                                                                                                                                                                                                     | **Même commande FFmpeg, fichiers identiques**. Seuls le nom et l'emplacement changent.              |
| Emplacement des WAV        | `processing/<id>/audio/track-2-mic.wav`, chemin absolu en base | `processing/<id>/<usage>/<clé courte>-track2.wav`, chemin relatif                                                                                                                                                                 | Les WAV existants sont repris par la migration, sans réextraction.                                  |
| Reprise après interruption | Colonnes `extracted_*`                                         | Cache des dérivés                                                                                                                                                                                                                 | Comportement identique : les pistes déjà produites ne sont pas refaites.                            |
| Doublons                   | Unicité par (enregistrement, type)                             | Unicité par clé de cible                                                                                                                                                                                                          | Plusieurs clips d'un même enregistrement peuvent être préparés en parallèle.                        |
| Exécution                  | 1 traitement à la fois                                         | 2 files (`heavy`, `interactive`), 1 traitement chacune                                                                                                                                                                            | La préparation d'un clip n'attend plus la transcription. Deux FFmpeg peuvent tourner en même temps. |
| Démarrage                  | Traitements actifs → interrompus                               | Idem, **plus** suppression des `*.part`                                                                                                                                                                                           | —                                                                                                   |
| Original modifié           | Erreur `MEDIA_SOURCE_CHANGED`                                  | Inchangé ; en plus, ses anciens dérivés ne sont plus servis                                                                                                                                                                       | —                                                                                                   |
| API                        | `POST /api/recordings/:id/extract-audio`                       | `POST /api/recordings/:id/transcription-audio`                                                                                                                                                                                    | **Changement incompatible**, sans client existant (l'interface n'utilise pas encore ces routes).    |
| API                        | `audioTracks[].extracted`                                      | `derivatives[]` (usage, piste, plage, taille, durée)                                                                                                                                                                              | Changement incompatible, même remarque.                                                             |
| Nouvelles routes           | —                                                              | `POST /api/recordings/:id/audio-stems` `{ srcStartMs, srcEndMs }`, `POST /api/derivatives/:id/waveform` (les formes d’onde sont aussi produites automatiquement avec chaque audio), `GET /api/storage`, `POST /api/storage/clean` | —                                                                                                   |
| CLI                        | `npm run import`                                               | Inchangée pour l'utilisateur ; ajout de `npm run storage`                                                                                                                                                                         | —                                                                                                   |
| Originaux                  | Lecture seule                                                  | Lecture seule, et **hors du périmètre du nettoyage**                                                                                                                                                                              | —                                                                                                   |
| Tests                      | 75                                                             | Tests d'API adaptés (routes, DTO) ; tests ajoutés : cache exact et englobant, déduplication, clips en parallèle, deux files, sécurité du nettoyage, rapport d'espace, migration des données de la version 1                       | —                                                                                                   |

Vous n'avez encore importé aucun enregistrement réel : la reprise de données ne concerne en
pratique que d'éventuels tests locaux. Elle est néanmoins écrite et testée.
