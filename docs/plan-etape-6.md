# Plan d'implémentation — Étape 6 : moteur de rendu des clips

> Statut : **validé par le créateur le 24/11/2026** (v3). PR 6a : projet de clip et
> persistance (voir « Écarts de mise en œuvre » en fin de document).
> Base analysée : `main` à `895a8d6` (étape 5 fusionnée).

### Changements depuis la v2

- **Décision effective et export final** : publication du fichier final **sous le verrou
  d'écriture SQLite** (`BEGIN IMMEDIATE`), dans la même transaction que la revérification de la
  décision ; les décisions de revue prennent le même verrou ; protocole de **récupération** après
  un arrêt entre le renommage et la validation en base (§6.7).
- **Consentement audio** : `discord_voices` n'autorise plus jamais la piste `mix`. La `mix` exige
  une **déclaration de composition** et un consentement pour **chaque** catégorie de voix de
  tiers qu'elle contient ; même règle pour le **chat vocal du jeu** dans la piste jeu (§6.4,
  §7.5).
- **Intégrité** : `streamhash` abandonné après vérification (il ignore les horodatages et les
  métadonnées de pistes, et sa couverture dépend du GOP). Remplacé par une **empreinte SHA-256
  d'un ensemble d'octets exact** (structure du conteneur, en-têtes de clusters, clusters de la
  fenêtre, zone de détection initiale), vérifiée sans FFmpeg, dont la suffisance est **prouvée
  par un test** : tout le reste du fichier mis à zéro, le rendu reste identique (§6.5).

### Changements de la v1 à la v2

- Décisions du §14 tranchées et intégrées partout (§14 devient « Décisions validées »).
- **Consentement Discord par enregistrement** appliqué aux sous-titres **et à l'audio exporté** ;
  la piste `mix` ne peut plus contourner cette règle (§6.4, §7.5, migration 7).
- **Pseudonymisation** des informations personnelles affichées, tracée, sans modifier la
  transcription originale (§7.3).
- **Masquage opaque** des zones sensibles (même approche que `frames.ts`), désactivable par clip
  avec avertissement (§7.2).
- Effets fondés sur l'énergie audio requalifiés en **indices techniques** (§7.4).
- **Vérification d'intégrité réelle** de la source avant chaque rendu (§6.5).
- **Décision effective vérifiée côté serveur** à chaque étape du rendu, et annulation des rendus
  en cours quand la décision change (§6.7).
- **Nettoyage du cache** : garanties explicites pour les rendus actifs et les exports (§6.8).
- Corrections de sous-titres tracées, ajustement des bornes ±10 s, durée 5–180 s,
  −14 LUFS désactivable, 60 i/s max, trois PR successives.

---

## 1. Objectif et périmètre

Transformer une **proposition acceptée** (étape 5) en **clip vertical 9:16** prévisualisable et
exportable, avec sous-titres lisibles, cadrage gameplay / facecam et effets contextuels sobres.

**Dans le périmètre**

- Un **document de projet de clip** (`ClipProject` v1) créé à partir d'une proposition acceptée :
  la future source de vérité de l'éditeur de l'étape 7.
- Un **moteur de rendu FFmpeg** déterministe : découpe précise, recadrage 9:16, incrustation
  facecam, masquage opaque, sous-titres ASS (libass), effets du catalogue v1, normalisation du
  volume.
- **Aperçu** basse définition (même chaîne de rendu) et **export final** 1080×1920.
- Réglages simples par clip : disposition, point de recadrage, style des sous-titres, sources
  autorisées, effets proposés (activables / désactivables), ajustement des bornes ±10 s,
  correction manuelle du texte des sous-titres.
- Audio exporté : consentements par catégorie de voix de tiers et déclarations de composition,
  par enregistrement.
- API, CLI `npm run render`, interface « Clips », tests unitaires et d'intégration FFmpeg.

**Hors périmètre (étape 7 ou plus tard)**

- Timeline, découpe en plusieurs segments, réordonnancement, arrêt sur image, vitesse,
  transitions, inserts, effets sonores, mixage audio libre, suivi automatique de la caméra,
  aperçu interactif (Remotion réévalué à ce moment-là).
- Publication automatique (jamais), envoi réseau quelconque, appel à Claude (aucun dans cette
  étape).

**Invariants conservés**

| Règle                                     | Application à l'étape 6                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Original jamais modifié                   | Source lue en `-i` uniquement ; intégrité vérifiée avant et après rendu (§6.5).                                                               |
| `SourceMs` / `EditMs` jamais mélangés     | Le projet stocke segments, sous-titres et effets en temps source ; le plan de rendu convertit en `EditMs` via `packages/timeline` uniquement. |
| Migrations publiées intouchables          | Nouvelle **migration 7** + mise à jour de `migrations-lock.test.ts`.                                                                          |
| Aucune commande générée par l'IA exécutée | `editingHint.ideas` est affiché comme texte, jamais interprété. Seul `editingHint.mode` (enum validé) présélectionne fidèle / enrichi.        |
| Pas de dialogue inventé                   | Sous-titres = mots de la transcription ; seules les corrections manuelles du créateur modifient le texte affiché, tracées et réversibles.     |
| Consentement des tiers                    | Aucune voix ni aucun texte Discord exporté sans autorisation explicite de l'enregistrement concerné.                                          |
| Durée 20–80 s par défaut                  | `effectiveClipDuration(creator, game)` ; bornes absolues 5–180 s ; hors plage effective = avertissement + confirmation.                       |
| Configuration documentée                  | Toute variable `RENDER_*` ajoutée à `.env.example` (test existant).                                                                           |
| CI sans secret ni Claude                  | Aucune dépendance réseau ; FFmpeg seul.                                                                                                       |

---

## 2. Analyse de l'existant (ce qui est réutilisé)

| Existant                                                                                                                                                                              | Où                                                                                         | Usage à l'étape 6                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modèle temporel `SourceMs`/`EditMs`, `SourceSegment`, `FreezeSegment`, `Timing`, `resolveTiming`, `sourceRangeToEditRanges`, `validateSegments`                                       | `packages/timeline/src/time.ts`                                                            | Segments du projet, conversion des mots et des effets en temps de montage.                                                                                                                                                               |
| Propositions : `src_start_ms`/`src_end_ms` (calés sur les mots, contexte et réaction inclus), `setup/punchline/reaction_end_segment_id`, `punchline_ms`, `editing_hint_json`, `flags` | `clip_proposals`, `services/api/src/analysis/proposals.ts`                                 | Bornes initiales, repères éditoriaux, mode présélectionné.                                                                                                                                                                               |
| Décision effective par moment                                                                                                                                                         | `packages/memory` (`effectiveDecisions`), `ReviewService`                                  | Seules les propositions dont la décision effective est **acceptée** peuvent être rendues.                                                                                                                                                |
| Transcriptions avec mots horodatés et rôle de piste                                                                                                                                   | `transcript_segments`, `SegmentDto`                                                        | Sous-titres ; calage des bornes sur les mots.                                                                                                                                                                                            |
| Pseudonymisation (`createPseudonymizer` : noms du fichier de confidentialité, courriels, liens, téléphones, mentions)                                                                 | `packages/editorial/src/analysis/privacy.ts`                                               | Pseudonymisation du texte **affiché** dans les sous-titres et le `.srt`.                                                                                                                                                                 |
| Profils de cadrage (`gameplay`, `facecam`, `masks`) validés par enregistrement avec empreinte                                                                                         | `profiles/framing/*.json`, `FramingProfileSchema`, `recording_analysis_settings.framing_*` | Dispositions 9:16, masquage opaque.                                                                                                                                                                                                      |
| `toPixelRect`, `frameFilter` (aplats `drawbox … color=black@1:t=fill` **avant** recadrage), `extractFrame`                                                                            | `packages/media/src/frames.ts`                                                             | Même approche de masquage dans le rendu ; aperçu image fixe.                                                                                                                                                                             |
| Profils de jeu / créateur, `effectiveClipDuration`, `editingStyle`                                                                                                                    | `packages/shared/src/profiles.ts`, `profiles/creator.json`                                 | Plage de durée, mode par défaut.                                                                                                                                                                                                         |
| Rôles de pistes (`mic`, `discord`, `game`, `mix`, `unknown`)                                                                                                                          | `packages/media/src/tracks.ts`, `audio_tracks`                                             | Sélection de l'audio autorisé (§7.5).                                                                                                                                                                                                    |
| `fingerprintFile` (taille + 1er Mo + dernier Mo)                                                                                                                                      | `packages/media/src/fingerprint.ts`                                                        | Contrôle rapide préalable ; insuffisant seul (§6.5).                                                                                                                                                                                     |
| Transactions de revue (`db.transaction(...)`, mode différé par défaut) ; base en WAL, `busy_timeout = 5000`                                                                           | `services/api/src/review/service.ts`, `db.ts`                                              | Passage en `BEGIN IMMEDIATE` pour sérialiser décisions et publication des exports (§6.7).                                                                                                                                                |
| `recover()` au démarrage (travaux, transcriptions, analyses)                                                                                                                          | `services/api/src/services.ts`                                                             | Même modèle pour la récupération des rendus (§6.7).                                                                                                                                                                                      |
| `runProcess` (sans shell, annulation, lecture ligne à ligne)                                                                                                                          | `packages/media/src/process.ts`                                                            | FFmpeg et suivi `-progress pipe:1`.                                                                                                                                                                                                      |
| `assertSafeOutputPath`, `isInside`                                                                                                                                                    | `packages/media/src/safe-path.ts`                                                          | Chemins de sortie.                                                                                                                                                                                                                       |
| `JobRunner` (voies `heavy` / `interactive` / `analysis`, `targetKey` unique, `job_files` protégés, annulation, reprise)                                                               | `services/api/src/jobs/runner.ts`                                                          | Travaux de rendu. Colonne `type` sans `CHECK` : **aucune migration de la table des travaux**.                                                                                                                                            |
| `StorageService.clean()` (n'opère que dans `processing/`, protège les fichiers des travaux actifs, supprime `.part` et orphelins après 1 h)                                           | `services/api/src/storage/service.ts`                                                      | À étendre : sans cela, un aperçu serait vu comme « orphelin » (§6.8).                                                                                                                                                                    |
| `decideRange`, `rangeHeaders`, `openServableFile`                                                                                                                                     | `services/api/src/review/`                                                                 | Lecture vidéo avec Range / HEAD.                                                                                                                                                                                                         |
| Fixtures FFmpeg (`createColorVideo`, `pixelAt`, `pulseMkv`, `bestLagMs`, `createTalkVideo`, `createFixtures` avec pistes Tout/Micro/Discord/Jeu)                                      | `tests/helpers/media-fixtures.ts`                                                          | Géométrie, précision de coupe, synchronisation, sélection des pistes.                                                                                                                                                                    |
| `ffmpeg` local 6.1.1 : `libass`, `freetype`, `fontconfig`, `harfbuzz`, `libx264` ; filtres `subtitles`, `ass`, `drawbox`, `overlay`, `gblur`, `crop`, `scale`                         | vérifié dans ce conteneur                                                                  | Faisabilité confirmée sous Linux. Windows CI (build gyan « essentials ») : libass **à confirmer par un test CI dès la PR 6b** ; la preuve de suffisance de l'ensemble d'octets protégé (§6.5) tourne dès la PR 6a sous Linux et Windows. |

---

## 3. Décision d'architecture : rendu 100 % FFmpeg (validé)

FFmpeg est déjà requis et testé en CI (Linux + Windows), rapide pour des clips de 20 à 80 s, et
sans dépendance de licence supplémentaire. Le rendu passe par une représentation intermédiaire
pure (`RenderPlan`) : à l'étape 7, un aperçu interactif (Remotion, canvas ou WebCodecs, à
réévaluer) pourra lire **le même document et le même plan** ; l'export restera FFmpeg.

La feuille de route est renumérotée (6 = moteur de rendu, 7 = éditeur complet) dans
`docs/proposition-editeur-memoire.md` et `docs/architecture.md` (PR 6a).

---

## 4. Architecture

```
                 étape 5                          étape 6
clip_proposals ──► décision effective = acceptée (revérifiée à chaque étape côté serveur)
transcript_segments (mots)          │
framing profile validé              ▼
état audio d'export         projectFromProposal()      (packages/timeline, pur)
profils créateur / jeu              │  ClipProject v1 (Zod, schemaVersion 1)
                                    ▼
                          clip_projects / clip_project_revisions   (migration 7)
                                    │  réglages du créateur (PATCH → nouvelle révision immuable)
                                    ▼
          buildRenderPlan(project, media, audioState, privacy, preset)   (packages/render, pur)
                                    │  RenderPlan : géométrie, masques, pistes autorisées,
                                    │  sous-titres pseudonymisés (EditMs), effets résolus
                         ┌──────────┴───────────┐
                         ▼                      ▼
                 buildAss(plan)         buildFfmpegArgs(plan)        (purs, testés unitairement)
                         └──────────┬───────────┘
                                    ▼
   job render_clip : intégrité (octets protégés) → ffmpeg → contrôle sortie → publication
                     sous verrou SQLite (décision + état audio revérifiés, renommage, COMMIT)
                                    │  zone d'attente → renommage atomique
                       ┌────────────┴─────────────┐
                       ▼                          ▼
     processing/renders/… (aperçu, cache)   exports/… (final + .srt + render.json)
                       │                          │
                       └──── API (Range/HEAD, téléchargement) ──► interface « Clips »
```

### 4.1 Packages et modules

- **`packages/timeline`** (étendu) : `project.ts` — schéma `ClipProject` v1, fonctions pures
  `projectFromProposal`, `applyRenderOptions`, `adjustBounds` (±10 s, calage sur les mots),
  `validateProject`, `migrateProject` (prévu dès la v1). Aucune dépendance FFmpeg.
- **`packages/render`** (nouveau, TS pur + un module d'exécution isolé) :
  - `presets.ts` : `preview` (540×960) et `final` (1080×1920), encodage ;
  - `layout.ts` : dispositions → rectangles pixels pairs ; masques opaques ;
  - `audio.ts` : sélection des pistes autorisées (§7.5) ;
  - `captions.ts` : regroupement des mots, timing `EditMs`, corrections, pseudonymisation ;
  - `ass.ts`, `srt.ts` : fichiers de sous-titres + échappement du texte non fiable ;
  - `effects/` : catalogue `defineEffect` (paramètres Zod), indices déterministes ;
  - `plan.ts` : `buildRenderPlan()` → `RenderPlan` sérialisable, empreinte stable ;
  - `ffmpeg-args.ts` : `RenderPlan` → arguments + `filter_complex` ;
  - `progress.ts`, `run.ts` (seul module qui lance un processus) ;
  - le manifeste d'intégrité vit dans `packages/media/src/integrity.ts` (nécessaire dès la PR 6a).
- **`services/api/src/clips/`** (nouveau) : `repository.ts`, `service.ts` (projets),
  `export-audio.ts` (consentements et déclarations), `render-service.ts` (rendus, travaux),
  `publish.ts` (publication sous verrou), `recovery.ts`, `guard.ts`, `naming.ts`.
- **`services/api/src/routes/clips.ts`**, **`scripts/render.ts`**.
- **`apps/web/src/components/ClipsPanel.tsx`, `ClipRenderEditor.tsx`, `ExportAudioPanel.tsx`**.

### 4.2 Préparation de l'étape 7

- Le moteur ne lit **que** le `ClipProject` (jamais la proposition) : l'éditeur modifiera le
  document, le moteur restera inchangé.
- Le document contient déjà les structures de l'étape 7 (segments multiples, sous-titres et
  effets ancrés en temps source, calques de disposition, pistes audio avec gain).
- Révisions immuables et concurrence optimiste (`baseRevision`) : base de l'annuler / rétablir.

---

## 5. Modèle de données

### 5.1 Document `ClipProject` v1 (Zod, `packages/timeline/src/project.ts`)

```ts
ClipProject = {
  schemaVersion: 1,
  origin: { proposalId, recordingId, runId, momentId, createdFrom: 'proposal',
            proposalBounds: { srcStartMs, srcEndMs } },          // référence pour le ±10 s
  source: { fingerprint, durationMs, width, height, fps, container,
            integrityManifestId },                                // §6.5 (manifeste en base)
  segments: Segment[],                    // v1 : un seul SourceSegment (speed 1)
  anchors: { setupStartMs, punchlineMs, reactionEndMs },          // SourceMs
  layout: {
    preset: 'facecam_top' | 'gameplay_crop' | 'blurred_fit',
    gameplayRect: NormRect, facecamRect: NormRect | null,
    framingProfile: { id, hash } | null,
    focusX: number,                       // 0..1
    facecamShare: number,                 // 0.25..0.45
    masks: { rect: NormRect, label, mode: 'opaque' | 'off' }[],   // 'opaque' par défaut
  },
  captions: {
    enabled: boolean,
    sources: ('mic' | 'discord')[],       // 'discord' refusé par le plan sans consentement
    style: CaptionStyle,                  // police ∈ {Montserrat ExtraBold, Inter}, taille, couleurs,
                                          // contour, position, casse, mots par ligne, mise en évidence
    pseudonymize: true,                   // toujours actif à l'étape 6 (voir §7.3)
    items: CaptionItem[],                 // { id, speakerRole, words: [{ text, timing }] }
    corrections: CaptionCorrection[],     // { itemId, originalText, correctedText, revision, at }
  },
  effects: EffectInstance[],              // { id, type, params, timing, enabled,
                                          //   origin: 'auto' | 'creator', reason, signals }
  audio: { tracks: [{ role, gainDb }], loudnorm: { enabled: true, targetLufs: -14 } },
  mode: 'fidele' | 'enrichi',
  durationPolicy: { minMs, maxMs, outOfRangeConfirmedForRevision: number | null },
}
```

- Les mots d'origine de la transcription ne sont **jamais** modifiés : une correction est une
  entrée de `corrections` (texte d'origine conservé) ; la base `transcript_segments` n'est pas
  touchée.
- Durée : schéma borné à 5–180 s ; toute modification des bornes annule la confirmation hors
  plage (`outOfRangeConfirmedForRevision` doit égaler la révision courante).
- Sérialisation canonique (clés triées) → empreinte SHA-256 stable.

### 5.2 Migration 7 (nouvelle, aucune migration existante modifiée)

```sql
-- Consentements et déclarations d'export, distincts de l'accord « texte Discord envoyé à Claude »
-- (migration 4) : finalités différentes. Journal append-only, état = dernier événement par sujet.
CREATE TABLE export_audio_events (
  id            TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('consent','declaration')),
  subject       TEXT NOT NULL CHECK (subject IN (
                  -- consentements (catégories de voix de tiers)
                  'discord_voices','game_voice_chat','other_voices',
                  -- déclarations de composition (faits sur une piste)
                  'mix_composition','game_composition','mic_composition')),
  action        TEXT NOT NULL CHECK (action IN ('granted','revoked','declared')),
  payload_json  TEXT,                           -- déclarations : « tout » { discord, gameVoiceChat,
                                                -- otherVoices } ; jeu { gameVoiceChat } ;
                                                -- micro { creatorVoice, otherVoices }
                                                -- chaque valeur ∈ 'present' | 'absent' (jamais « inconnu »)
  note          TEXT,                           -- ex. « accord oral de A et B le 12/11 »
  request_id    TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL CHECK (source IN ('ui','cli')),
  created_at    TEXT NOT NULL,
  CHECK ((kind = 'consent' AND action IN ('granted','revoked') AND payload_json IS NULL)
      OR (kind = 'declaration' AND action = 'declared' AND payload_json IS NOT NULL))
);

-- Manifeste d'intégrité (§6.5) : ensemble d'octets protégé d'une fenêtre source.
CREATE TABLE source_integrity_manifests (
  id             TEXT PRIMARY KEY,
  recording_id   TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  method         TEXT NOT NULL CHECK (method IN ('byte_ranges','full_file')),
  container      TEXT NOT NULL,                  -- matroska | mp4 | autre (→ full_file)
  file_size      INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL, window_end_ms INTEGER NOT NULL,
  probe_bytes    INTEGER NOT NULL,               -- -probesize imposé au rendu
  ranges_json    TEXT NOT NULL,                  -- [[début, fin, rôle]], rôle ∈ structure|cluster_header|probe|window
  protected_bytes INTEGER NOT NULL,
  sha256         TEXT NOT NULL,                  -- SHA-256 de la concaténation ordonnée des plages
  algo_version   INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE clip_projects (
  id               TEXT PRIMARY KEY,
  proposal_id      TEXT NOT NULL UNIQUE REFERENCES clip_proposals(id),
  recording_id     TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  current_revision INTEGER NOT NULL,
  created_at, updated_at
);
-- Pas de colonne « statut de décision » : la décision effective est TOUJOURS recalculée depuis
-- proposal_reviews (source de vérité de l'étape 5), jamais copiée.

CREATE TABLE clip_project_revisions (            -- immuables
  project_id     TEXT NOT NULL REFERENCES clip_projects(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  document_json  TEXT NOT NULL,
  document_hash  TEXT NOT NULL,
  change_summary TEXT,                             -- ex. « sous-titre 4 corrigé »
  request_id     TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('ui','cli','system')),
  created_at,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, request_id)
);

CREATE TABLE clip_renders (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES clip_projects(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('preview','final')),
  status          TEXT NOT NULL CHECK (status IN
                    ('queued','running','finalizing','succeeded','failed','cancelled','evicted')),
  plan_hash       TEXT NOT NULL,                   -- document + état audio (consentements et
                                                   -- déclarations) + confidentialité + préréglage
                                                   -- + version du moteur
  job_id          TEXT,
  staging_rel_path TEXT,                           -- fichier complet en attente de publication
  output_rel_path TEXT,                            -- relatif à processing/ (aperçu) ou exports/ (final)
  output_sha256   TEXT,                            -- calculé sur le fichier en attente, avant publication
  srt_rel_path    TEXT,
  size_bytes, duration_ms, width, height,
  toolchain_json  TEXT,
  warnings_json   TEXT NOT NULL DEFAULT '[]',
  error_code      TEXT, error_message TEXT,
  last_served_at  TEXT,                            -- ordre LRU des aperçus
  created_at, finished_at,
  FOREIGN KEY (project_id, revision) REFERENCES clip_project_revisions(project_id, revision),
  CHECK (kind = 'preview' OR status <> 'evicted'),  -- un final n'est jamais évincé
  CHECK (status <> 'finalizing' OR (staging_rel_path IS NOT NULL AND output_rel_path IS NOT NULL
                                    AND output_sha256 IS NOT NULL)),
  CHECK (status <> 'succeeded' OR (output_rel_path IS NOT NULL AND output_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX ux_render_active ON clip_renders(plan_hash, kind)
  WHERE status IN ('queued','running','finalizing','succeeded');
```

- Tests `migration-7.test.ts` (contraintes : final jamais évincé, `finalizing` et `succeeded`
  complets, événements audio cohérents ; cascade ; idempotence) et entrée dans
  `migrations-lock.test.ts`.
- `media_derivatives.kind` n'est pas étendu (son `CHECK` imposerait une reconstruction).

---

## 6. Flux détaillés

### 6.1 Création d'un projet

1. `POST /api/proposals/:id/clip-project { requestId }`.
2. `guard.assertAccepted(proposalId)` : décision effective `accepted`, sinon
   `409 PROPOSAL_NOT_ACCEPTED`.
3. Chargement : proposition, transcription de l'analyse (mots + rôles), pistes audio, cadrage
   validé, état audio d'export courant (§6.4), profils créateur / jeu.
4. Intégrité : contrôle rapide (`fingerprintFile` comparé à l'import), puis construction du
   **manifeste d'intégrité** de la fenêtre ajustable `[début − 10 s, fin + 10 s]` (§6.5).
5. `projectFromProposal()` (pur) :
   - segment unique `[src_start_ms, src_end_ms]` ; repères `setupStartMs`, `punchlineMs`,
     `reactionEndMs` ;
   - disposition : `facecam_top` si facecam dans un profil **validé** et à jour (empreinte),
     sinon `blurred_fit` (+ avertissement `FRAMING_NOT_VALIDATED` si aucun profil validé) ;
   - masques du profil en mode `opaque` ;
   - sous-titres : source `mic` ; `discord` ajouté seulement si le consentement
     `discord_voices` est accordé **et** que le créateur l'active ;
   - mode : `editingHint.mode` si présent, sinon `creator.editingStyle.defaultMode` ;
   - effets : catalogue v1 évalué (§7.4) ;
   - durée : plage effective ; hors plage → avertissement `DURATION_OUT_OF_RANGE`.
6. Révision 1 enregistrée (transaction). Relance avec le même `requestId` → même résultat.

### 6.2 Réglages (sans timeline)

`PATCH /api/clip-projects/:id { requestId, baseRevision, changes }`, `changes` validé par un
schéma strict `RenderOptionsPatch` : disposition, `focusX`, `facecamShare`, masques (`off`
exige `acknowledgeMaskRisk: true`), style et sources des sous-titres, pistes audio, effets,
bornes, correction de texte, confirmation de durée, `loudnorm`. `baseRevision ≠
current_revision` → `409 VERSION_CONFLICT`. Chaque modification crée une révision immuable avec
un résumé lisible. Un projet dont la décision n'est plus acceptée reste consultable mais **non
modifiable** (vérification dans la transaction d'écriture, §6.7).

### 6.3 Ajustement des bornes (±10 s)

- Début et fin déplaçables d'au plus 10 s par rapport à `origin.proposalBounds`, sans sortir de
  l'enregistrement ni de la fenêtre couverte par le manifeste d'intégrité.
- Calage sur la frontière de mot la plus proche (tous les mots horodatés servent au **calage**,
  y compris Discord : le timing seul n'expose aucun contenu).
- Avertissements : `CONTEXT_MAY_BE_CUT` si `début > setupStartMs`, `REACTION_MAY_BE_CUT` si
  `fin < reactionEndMs`, `WORD_CUT` si aucune frontière de mot proche ; durée recontrôlée
  (5–180 s absolu, plage effective avec confirmation).

### 6.4 Audio exporté : consentements et déclarations

Deux notions distinctes, par **enregistrement**, explicites, tracées dans
`export_audio_events` (journal append-only : qui, quand, note, source ; révocable par un nouvel
événement, jamais de suppression) :

- **Consentements**, un par catégorie de voix de tiers :
  - `discord_voices` : voix des participants Discord ;
  - `game_voice_chat` : voix du chat vocal intégré au jeu (coéquipiers ou adversaires) ;
  - `other_voices` : toute autre voix de tiers (personne présente dans la pièce, voix de
    synthèse lisant des messages de spectateurs, etc.).
- **Déclarations de composition** (faits sur une piste, saisis par le créateur) :
  - `mix_composition` : pour la piste `mix` (ou la piste unique d'un MP4 de secours, ou une piste
    `unknown`) : `{ discord, gameVoiceChat, otherVoices }`, chaque valeur `present` ou `absent` ;
  - `game_composition` : pour la piste `game` : `{ gameVoiceChat }` ;
  - `mic_composition` : pour la piste `mic` : `{ creatorVoice, otherVoices }` — la voix du
    créateur (informative, jamais soumise à accord) est distinguée des voix de tiers captées par
    le micro (personne dans la pièce, retour des haut-parleurs, voix de synthèse).

Règles (fonction pure `allowedAudio()`, §7.5) :

1. **Une piste n'est exportable que si chaque catégorie de voix de tiers qu'elle peut contenir
   est soit déclarée `absent`, soit couverte par le consentement correspondant.** Une
   composition non déclarée est traitée comme « peut contenir toutes les catégories ».
2. `discord_voices` autorise la piste `discord` et les sous-titres Discord, **jamais** à lui seul
   la piste `mix` : la `mix` exige une déclaration `mix_composition` **et** un consentement pour
   chaque catégorie déclarée `present` (par exemple `discord: present, gameVoiceChat: present`
   exige `discord_voices` **et** `game_voice_chat`).
3. **Chat vocal du jeu** : la piste `game` est exclue tant que `game_composition` n'a pas été
   déclarée ; `gameVoiceChat: absent` l'autorise ; `present` exige `game_voice_chat`.
   L'interface propose de reprendre la déclaration du dernier enregistrement du même jeu, mais
   cela reste une action explicite et tracée pour l'enregistrement concerné.
4. **Micro** (correction de revue de la PR 6a) : la piste `mic` n'est **pas** présumée ne
   contenir que la voix du créateur. Elle est exclue tant que `mic_composition` n'a pas été
   déclarée ; `otherVoices: absent` l'autorise ; `otherVoices: present` exige l'accord
   `other_voices` (ni `discord_voices` ni `game_voice_chat` ne suffisent). Un projet créé avant
   la déclaration n'a ni audio ni sous-titres du micro ; une fois la piste autorisée, elle
   s'ajoute explicitement par un réglage (jamais automatiquement).
5. Les sous-titres suivent les mêmes règles que l'audio : aucune ligne issue d'une piste non
   exportable (par exemple une transcription faite sur la `mix`) n'est affichée.
6. Révoquer un consentement ou modifier une déclaration change `plan_hash` : un rendu antérieur
   n'est jamais réutilisé ; les exports existants sont conservés mais signalés.
7. Le consentement accordé pour l'analyse Claude (migration 4) **ne vaut pas** consentement
   d'export, et inversement.

### 6.5 Intégrité réelle de la source

#### Ce que `streamhash` garantit, et pourquoi il est abandonné

Vérification faite sur un MKV de type OBS (H.264, GOP de 2 s, deux pistes AAC titrées
« Micro » / « Discord ») avec FFmpeg 6.1.1 :

| Constat                                                                                                                                                                                                 | Mesure                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Déterministe pour un même fichier et une même version de FFmpeg                                                                                                                                         | deux calculs identiques                 |
| Avec `-ss 10.3` avant `-i` et `-c copy`, la copie commence à l'**image clé précédente** (10,0 s) : la couverture dépend du GOP, pas de la fenêtre demandée                                              | premier paquet vidéo à 10,000 s         |
| Un octet de données modifié dans la plage copiée est détecté ; hors de cette plage (y compris entre une image clé antérieure et la fenêtre) il ne l'est pas                                             | 12 s : modifié ; 9 s et 25 s : inchangé |
| Les **horodatages** ne sont pas couverts : tout le fichier décalé de 0,5 s donne la même empreinte, alors que la coupe serait décalée                                                                   | empreintes identiques                   |
| Les **métadonnées des pistes** ne sont pas couvertes : renommer la piste « Discord » en « Micro__ » (ce qui changerait la détection des rôles, donc le consentement appliqué) ne change pas l'empreinte | empreintes identiques                   |

`streamhash` garantit donc seulement « mêmes données de paquets, pour les flux copiés, à partir
de l'image clé choisie par cette version de FFmpeg ». Il ne détecte ni toute modification des
octets de la fenêtre, ni les changements de structure, et une mise à jour de FFmpeg pourrait
fausser la comparaison. Il n'est **pas** retenu.

#### Méthode retenue : SHA-256 d'un ensemble d'octets exact

À la création du projet, `buildIntegrityManifest()` calcule l'**ensemble d'octets protégé** de
la fenêtre ajustable et en stocke la liste de plages et l'empreinte (table
`source_integrity_manifests`) :

1. **Structure du conteneur** :
   - Matroska : en-tête EBML, en-tête du segment et **tous** les éléments de premier niveau
     autres que les clusters (SeekHead, Info, Tracks avec titres et données privées des codecs,
     Cues, Tags, Chapters…), plus l'**en-tête de chaque cluster** (identifiant et taille) ;
   - MP4 / MOV : toutes les boîtes de premier niveau sauf `mdat` (dont `moov` en entier : tables
     d'échantillons, horodatages, titres).
2. **Clusters de la fenêtre** (Matroska) : positions des paquets obtenues une fois par
   `ffprobe -show_packets` (`pos`, `size`), de l'image clé précédant `début − 10 s` (moins 1 s de
   marge) jusqu'à `fin + 10 s` (plus 1 s), **toutes pistes confondues**, puis **alignées sur les
   clusters entiers** qui les contiennent. L'alignement est indispensable : l'horodatage de
   référence d'un cluster est dans son en-tête, hors des paquets. En MP4 : plages d'octets des
   échantillons de la fenêtre (horodatages couverts par `moov`).
3. **Zone de détection initiale** : FFmpeg lit le début des données à l'ouverture pour détecter
   les flux. Les clusters (ou octets de `mdat`) des `probe_bytes` premiers octets sont protégés,
   et le rendu impose `-probesize <probe_bytes>` pour que cette zone soit fixe.
4. **Repli** : conteneur non reconnu, élément de taille inconnue (enregistrement OBS interrompu),
   positions de paquets absentes → méthode `full_file` (SHA-256 du fichier entier, avec
   progression et annulation ; plus lent, mais exact).

**Vérification avant chaque rendu** (aperçu et final), **sans FFmpeg** : taille du fichier
identique, puis relecture des plages enregistrées et recalcul du SHA-256 ; toute différence →
`MEDIA_SOURCE_CHANGED`. La date de modification n'est jamais utilisée comme preuve.

**Garantie, formulée exactement** : chaque octet de l'ensemble protégé est identique à celui
constaté à la création du projet. Le test de suffisance ci-dessous établit que, pour une version
donnée de FFmpeg et les options de rendu imposées (`-probesize`, `-ss` avant `-i`), **ces octets
sont les seuls qui influencent le rendu de la fenêtre**. Hors de cet ensemble, un octet modifié
n'est pas détecté, et c'est voulu : il ne peut pas changer le clip. La comparaison ne dépend pas
de FFmpeg ; seule la preuve de suffisance en dépend. Elle est donc rejouée en CI (Linux et
Windows) et par `doctor --render` sur la machine de l'utilisateur.

**Preuve de suffisance (vérifiée dans ce conteneur avec le prototype)** : on construit une copie
du fichier où **tous les octets hors de l'ensemble protégé sont mis à zéro**, puis on compare le
`framemd5` décodé de la fenêtre à celui de l'original.

- Avec structure + en-têtes de clusters + clusters de la fenêtre + zone de détection : le rendu
  est **identique** (8,3 Mo protégés sur 13,9 Mo, fenêtre de 6 s).
- Sans aligner sur les clusters ou sans la zone de détection, FFmpeg échoue : l'ensemble serait
  insuffisant, ce qui confirme que ces deux règles sont nécessaires.

Coût : relecture des clusters de la fenêtre. Ordre de grandeur pour 100 s : environ 75 Mo à
6 Mb/s, ou 625 Mo à 50 Mb/s, plus la structure. Une à quelques secondes sur SSD.

**Après rendu** : contrôle rapide recalculé (original inchangé), sortie sondée par `ffprobe`
(flux présents, 1080×1920 ou 540×960, durée attendue ± 1 image) ; erreurs de décodage relevées
dans stderr → avertissement `SOURCE_DECODE_WARNINGS`.

### 6.6 Rendu

1. `POST /api/clip-projects/:id/renders { kind, requestId }`.
2. Contrôles : décision effective (§6.7), durée valide / confirmée, `allowedAudio()` compatible
   avec les pistes et sources demandées, intégrité (§6.5), outils, espace disque (≈ débit ×
   durée × 1,5).
3. `buildRenderPlan()` → `plan_hash` ; rendu réussi existant pour ce `plan_hash` et ce `kind` →
   renvoyé sans re-rendu.
4. Travail `render_clip` : aperçu en voie `interactive`, final en voie `heavy` ;
   `targetKey = render:<plan_hash>:<kind>` ; fichiers temporaires et fichier en attente déclarés
   dans `job_files` (protégés du nettoyage).
5. Exécution : dossier `processing/renders/tmp/<renderId>/` (fichier `subs.ass`, police copiée) ;
   FFmpeg lancé avec `cwd` = ce dossier, des **noms relatifs fixes** dans le graphe de filtres
   (aucun chemin Windows `C:\…` à échapper) et `-probesize` du manifeste. Sortie `.part`
   (`-f mp4`), `-movflags +faststart`.
6. Progression via `-progress pipe:1`.
7. Annulation ou arrêt : FFmpeg stoppé, `.part` et dossier temporaire supprimés (chemins exacts
   issus de la base, jamais par motif) ; reprise au démarrage (§6.7).
8. Publication selon le protocole du §6.7. Destination finale :
   `exports/<AAAA-MM-JJ>_<titre-assaini>_<id court>/clip.mp4` + `clip.srt` (texte pseudonymisé
   et corrigé, identique à l'image) + `render.json` (identifiants, empreintes, état audio
   appliqué, nombre de corrections et de pseudonymisations, masques désactivés, avertissements ;
   ni chemin absolu, ni transcription, ni secret).

### 6.7 Décision effective : sérialisation et publication des exports

**Objectif** : une proposition dont la décision effective n'est pas `accepted` au moment de la
publication ne peut **jamais** faire apparaître un export final, même en cas de demandes
concurrentes (API, interface, CLI dans un autre processus) ou d'arrêt brutal.

**Point de sérialisation : le verrou d'écriture SQLite.**

- Toutes les écritures qui changent une décision effective (`ReviewService.decide`, `reset`,
  `detach`, recalcul de moment) passent de `db.transaction(...)` (mode différé) à
  `db.transaction(...).immediate()` (`BEGIN IMMEDIATE`). Cela prend le verrou d'écriture dès le
  début et évite aussi l'échec `SQLITE_BUSY_SNAPSHOT` d'une transaction différée qui lit puis
  écrit en mode WAL.
- La publication d'un rendu se fait dans une transaction `BEGIN IMMEDIATE`. SQLite n'autorise
  qu'un écrivain à la fois, y compris entre processus, et `busy_timeout = 5000` fait attendre
  l'autre partie. Une décision et une publication sont donc **totalement ordonnées**.

**Protocole de publication (final et aperçu, même code) :**

1. **Préparation (hors verrou)** : FFmpeg termine, la sortie est contrôlée (`ffprobe`), son
   SHA-256 calculé. Le fichier est déplacé dans une zone d'attente non publique **sur le même
   volume que la destination** : `exports/.staging/<renderId>.mp4` pour un final,
   `processing/renders/staging/` pour un aperçu.
2. **Transaction A** (courte) : `status = 'finalizing'`, `staging_rel_path`, `output_rel_path`
   (destination prévue) et `output_sha256` enregistrés. À partir d'ici, tout arrêt est
   récupérable, car les chemins exacts sont connus de la base.
3. **Transaction B** (`BEGIN IMMEDIATE`, sous verrou) :
   - recalcul de la décision effective depuis `proposal_reviews` ;
   - recalcul de l'état audio : `plan_hash` toujours valide ;
   - le projet est toujours à la révision rendue (pour un final) ;
   - **si tout est valide** : création du dossier de destination, puis **renommage** de la zone
     d'attente vers la destination, sans écrasement, **pendant que le verrou est tenu**. Ensuite
     `status = 'succeeded'`, `COMMIT` ;
   - **sinon** : `status = 'failed'` (`PROPOSAL_NOT_ACCEPTED` ou `EXPORT_CONSENT_REQUIRED`),
     `COMMIT`, puis suppression du fichier en attente.

   Une décision de refus ne peut donc être validée qu'**avant** la transaction B, qui la voit et
   refuse, ou **après** sa validation. Dans ce second cas, l'export a été publié alors que la
   proposition était acceptée : il est conservé et signalé « décision modifiée depuis
   l'export ». Aucun ordre ne permet à une proposition déjà refusée de faire apparaître un
   export. La transaction B ne contient qu'un `rename` : le verrou est tenu quelques
   millisecondes.

4. **Échec du renommage** (antivirus Windows, fichier verrouillé) : `ROLLBACK`, le rendu reste
   `finalizing`, nouvel essai borné (3 fois, avec délai), puis `failed` avec `RENDER_FAILED`.
   **Échec du `COMMIT` après le renommage** (erreur d'écriture) : renommage inverse vers la zone
   d'attente avant de propager l'erreur ; si ce renommage inverse échoue aussi, la récupération
   ci-dessous traite le cas au prochain démarrage.

**Définition d'un export** : un fichier est un export **si et seulement si** sa ligne
`clip_renders` est `succeeded`. L'API, l'interface et le CLI ne servent ni ne listent rien
d'autre. `exports/.staging/` n'est jamais servi.

**Récupération au démarrage** (`renders.recover()`, appelé comme les autres `recover()` dans
`services.ts`, après `runner.recover()`) :

- rendus `queued` / `running` sans travail actif → `failed` (`CANCELLED`), `.part` et dossier
  temporaire supprimés par leurs chemins exacts ;
- rendus `finalizing` (arrêt entre la transaction A et la fin de B), traités **chacun dans une
  transaction `BEGIN IMMEDIATE`** :

| État des fichiers                                                                   | Décision effective et `plan_hash` valides                                                                                                                                        | Sinon                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fichier en attente présent, destination absente (arrêt avant le renommage)          | Reprendre la transaction B                                                                                                                                                       | `failed`, fichier en attente supprimé                                                                                                                                 |
| Destination présente, attente absente (**arrêt entre le renommage et le `COMMIT`**) | SHA-256 de la destination = `output_sha256` → `succeeded` ; différent → `failed` et fichier mis en quarantaine (`exports/.staging/quarantine/`, jamais supprimé automatiquement) | Fichier retiré de la destination (renommé vers `exports/.staging/`, puis supprimé) et `failed`. Il n'a **jamais** été un export : sa ligne n'a jamais été `succeeded` |
| Les deux absents                                                                    | `failed` (`RENDER_FAILED`)                                                                                                                                                       | `failed`                                                                                                                                                              |
| Les deux présents (anomalie)                                                        | Destination traitée comme ci-dessus, fichier en attente supprimé                                                                                                                 | idem                                                                                                                                                                  |

**Autres garanties :**

- `guard.assertAccepted()` reste appelé à la création, à chaque `PATCH` (dans la transaction
  d'écriture), à la demande de rendu et au démarrage du travail. Ces contrôles évitent un
  travail inutile ; **la garantie, elle, repose sur la transaction B**.
- Dans la même transaction que la décision, `ReviewService` annule les rendus `queued` /
  `running` des projets du moment concerné (économie de calcul, pas une garantie).
- Les exports légitimement publiés ne sont jamais supprimés automatiquement.

### 6.8 Nettoyage du cache

`StorageService.clean()` est étendu ; garanties testées :

- **Exports finaux jamais concernés** : le nettoyage n'opère que dans `processing/` (contrôle
  `isInside` existant) ; `exports/` (y compris `.staging/`) n'est jamais parcouru par le
  nettoyage, seule la récupération du §6.7 y agit, par chemins exacts ; `CHECK` SQL : un final
  ne peut pas passer à `evicted`.
- **Rendus actifs jamais supprimés** : fichiers déclarés dans `job_files` (protection
  existante) **et** exclusion de tout chemin appartenant à un rendu `queued` / `running` /
  `finalizing`, même avec `evictAllCache`.
- Les aperçus réussis sont connus du nettoyage (plus jamais classés « orphelins ») et évincés par
  ordre LRU (`last_served_at`) dans le budget du cache. Le rendu passe à `evicted` dans une
  transaction, puis le fichier est supprimé. Un aperçu en cours de lecture qui ne peut pas être
  supprimé (Windows) est ignoré et retenté plus tard.
- Les `.part` et fichiers en attente d'un rendu actif ne sont jamais traités comme
  « temporaires abandonnés ».

### 6.9 Lecture et export

- `GET /api/renders/:id/video` (Range + HEAD) ; `GET /api/renders/:id/download` (final,
  `Content-Disposition` assaini) ; `GET /api/renders/:id/subtitles.srt`.
- **Aucune publication** : l'export s'arrête au fichier.

---

## 7. Rendu : détails techniques

### 7.1 Découpe précise

- `-ss <début> -i source -t <durée>` avec ré-encodage (recherche précise) ; jamais `-c copy`.
- Fréquence de sortie = fréquence source **plafonnée à 60 i/s** (`fps=` → fréquence constante,
  y compris pour les enregistrements OBS à fréquence variable).
- Même position de départ pour l'audio et la vidéo : synchronisation vérifiée en test.

### 7.2 Dispositions 9:16 et masquage

| Préréglage      | Composition                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `facecam_top`   | Facecam recadrée en haut (`facecamShare`, 0,33 par défaut), gameplay recadré dessous, centré sur `focusX`. |
| `gameplay_crop` | Gameplay recadré plein cadre 9:16 autour de `focusX`.                                                      |
| `blurred_fit`   | Gameplay entier au centre, fond = même image agrandie et floutée. Disposition de repli.                    |

- **Masquage opaque** des zones `masks` du profil, appliqué **sur l'image source avant tout
  recadrage**, exactement comme `frameFilter` (`drawbox … color=black@1:t=fill`) : la zone ne peut
  réapparaître dans aucun calque (y compris le fond flouté et la facecam). Le code de construction
  des aplats est mutualisé avec `frames.ts`.
- Désactivation clip par clip seulement avec `acknowledgeMaskRisk` ; avertissement visible dans
  l'interface, le CLI et `render.json`.
- Rectangles normalisés → pixels pairs via `toPixelRect`.
- Image fixe : `GET /api/clip-projects/:id/frame?atEditMs=` avec **le même graphe** (masques
  compris), pour régler la disposition sans rendu vidéo.

### 7.3 Sous-titres (ASS via libass)

- Lignes de 1 à 2, ≤ 32 caractères par défaut, coupure aux pauses (> 350 ms) et à la
  ponctuation, affichage 0,7–3,5 s, sans chevauchement ; mots en `SourceMs` → `EditMs` via
  `sourceRangeToEditRanges`.
- Sources : `mic` par défaut ; `discord` uniquement avec consentement `discord_voices` de
  l'enregistrement **et** activation par le créateur ; le plan de rendu refuse sinon
  (`EXPORT_CONSENT_REQUIRED`), quelle que soit l'origine de la demande.
- **Texte affiché** = texte d'origine → correction du créateur éventuelle → pseudonymisation
  (`createPseudonymizer` avec le fichier de confidentialité configuré : noms remplacés par leurs
  étiquettes, courriels, liens, téléphones, mentions masqués).
  - La transcription originale n'est jamais modifiée.
  - Rien n'est silencieux : chaque ligne modifiée est signalée dans l'interface (« 2 noms
    remplacés », « corrigé par le créateur ») avec le détail consultable ; les compteurs figurent
    dans `render.json`.
  - La pseudonymisation s'applique aussi au texte corrigé (une correction ne peut pas réintroduire
    un nom protégé sans avertissement).
  - Fichier de confidentialité invalide → `PRIVACY_CONFIG_INVALID`, rendu refusé (pas de repli
    silencieux sans pseudonymisation).
- **Corrections** : texte seulement (pas de timing), saisies par le créateur, jamais par l'IA ;
  texte d'origine conservé dans `corrections`, révision et date tracées, annulables.
- Style : polices fournies **Montserrat ExtraBold** et **Inter** (`assets/fonts/`, licences OFL
  jointes, passées par `fontsdir=`), taille, couleurs, contour, ombre, casse, mots par ligne,
  position (haut / milieu / bas-sûr, au-dessus des 20 % bas réservés aux interfaces TikTok /
  Shorts / Reels), mise en évidence du mot prononcé et de la ligne de la chute.
- `PlayResX/Y = 1080×1920` : rendu identique en aperçu (mise à l'échelle libass).
- **Texte non fiable** : caractères de contrôle supprimés, `\`, `{`, `}` échappés (aucune
  injection de balises ASS), le texte n'entre jamais dans le graphe de filtres.
- `.srt` livré avec le même texte affiché.

### 7.4 Effets contextuels (catalogue v1)

| Effet                                                | Ancrage (validé par l'acceptation) | Indice technique requis                               | Mode             |
| ---------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- | ---------------- |
| `caption_emphasis`                                   | ligne de la chute (`punchlineMs`)  | aucun                                                 | fidèle + enrichi |
| `punch_zoom` (1,00 → 1,12 puis retour, ≤ 1,5 s)      | `punchlineMs`                      | hausse d'énergie de la piste micro dans la réaction   | enrichi          |
| `reaction_hold` (léger zoom maintenu sur la facecam) | début de réaction                  | facecam présente + hausse d'énergie de la piste micro | enrichi          |

- Les mesures d'énergie (RMS) sont des **indices techniques**, jamais présentés comme une preuve
  de rire ou de réaction. Raison affichée, par exemple : « Zoom sur la chute (01:23) : le volume
  de ta voix augmente nettement juste après — indice technique, à vérifier ».
- Un effet n'est proposé que si **l'ancrage éditorial et l'indice** sont réunis ; jamais sur
  l'indice seul. Valeurs mesurées et seuils enregistrés dans `signals` (explicabilité, tests).
- Mode fidèle : seul `caption_emphasis`. Mode enrichi : au plus **2 effets automatiques**, sans
  chevauchement, aucun dans les 2 premières secondes. Chaque effet est désactivable ; une
  désactivation est conservée dans les révisions suivantes.
- Les idées libres de Claude restent du texte affiché, jamais exécutées ni converties.
- Aucun effet ne modifie l'audio, ne coupe de parole, n'ajoute de texte.
- Zoom FFmpeg : `scale` (`eval=frame`) + `crop` centré, expressions générées depuis des nombres
  validés. Risque technique validé tôt en PR 6b par un test de pixels ; repli : zoom par paliers.

### 7.5 Audio autorisé et encodage

Sélection par `allowedAudio(tracks, audioState)` (`packages/render/src/audio.ts`, pure, testée
de façon exhaustive), selon les règles du §6.4 :

| Piste                          | Catégories de tiers possibles                                            | Exportable si                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mic`                          | autres voix de tiers (la voix du créateur n'est jamais soumise à accord) | `mic_composition` déclarée **et** (`otherVoices: absent` **ou** consentement `other_voices`)                                                      |
| `discord`                      | Discord                                                                  | consentement `discord_voices`                                                                                                                     |
| `game`                         | chat vocal du jeu                                                        | `game_composition` déclarée **et** (`gameVoiceChat: absent` **ou** consentement `game_voice_chat`)                                                |
| `mix`, piste unique, `unknown` | Discord, chat vocal du jeu, autres voix                                  | `mix_composition` déclarée **et** consentement pour **chaque** catégorie déclarée `present` (`discord_voices`, `game_voice_chat`, `other_voices`) |

Choix de la combinaison :

1. Si des pistes individuelles existent, l'export est **construit à partir des pistes
   individuelles exportables** (`mic`, puis `discord` et `game` si autorisées), mélangées avec les
   gains du document. La `mix` n'est jamais superposée aux pistes individuelles (pas de voix
   doublées, règle existante de `tracks.ts`).
2. La `mix` n'est utilisée **que** s'il n'existe aucune piste individuelle exploitable **et**
   qu'elle est exportable selon le tableau.
3. Sinon, refus `EXPORT_CONSENT_REQUIRED`. Le message liste précisément la déclaration ou le
   consentement manquant, par exemple : « la piste Tout contient le chat vocal du jeu : accord
   requis ». Aucun repli silencieux vers une piste non autorisée, et aucun export muet implicite.
   Un export sans audio n'est possible qu'en le choisissant explicitement par clip.
4. Le créateur peut toujours **retirer** une piste autorisée (par exemple exclure `game`), jamais
   en ajouter une non autorisée. Le plan de rendu revérifie, quel que soit le document.
5. Les pistes réellement utilisées et la règle appliquée figurent dans `render.json` et dans
   l'interface.

Encodage :

- Normalisation `loudnorm` −14 LUFS, crête −1,5 dBTP, **activée par défaut et désactivable**.
- Vidéo H.264 `yuv420p` (final CRF 18 / `medium`, aperçu CRF 30 / `veryfast`), audio AAC 48 kHz
  stéréo 192 kb/s, MP4 `+faststart`.
- Variables : `RENDER_FINAL_CRF`, `RENDER_X264_PRESET`, `RENDER_PREVIEW_HEIGHT`,
  `RENDER_PROBE_BYTES` (`.env.example`, validées dans `config.ts`).

---

## 8. API

| Méthode  | Route                                    | Rôle                                                                    | Erreurs principales                                                              |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| GET      | `/api/recordings/:id/clips`              | Propositions acceptées + projet + derniers rendus                       | 404                                                                              |
| GET      | `/api/recordings/:id/export-audio`       | Consentements, déclarations, historique, pistes exportables et raisons  | 404                                                                              |
| POST     | `/api/recordings/:id/export-audio`       | `{ requestId, kind, subject, action, payload?, note? }` (schéma strict) | 400                                                                              |
| POST     | `/api/proposals/:id/clip-project`        | Crée (ou renvoie) le projet                                             | 409 `PROPOSAL_NOT_ACCEPTED`                                                      |
| GET      | `/api/clip-projects/:id`                 | Révision courante, avertissements, décision effective                   | 404                                                                              |
| GET      | `/api/clip-projects/:id/revisions`       | Historique (résumés, corrections)                                       | 404                                                                              |
| PATCH    | `/api/clip-projects/:id`                 | Réglages → nouvelle révision                                            | 400, 409 `VERSION_CONFLICT` / `PROPOSAL_NOT_ACCEPTED`, 422                       |
| GET      | `/api/clip-projects/:id/frame?atEditMs=` | Image fixe (JPEG)                                                       | 404, 422                                                                         |
| POST     | `/api/clip-projects/:id/renders`         | Aperçu / final                                                          | 409, 422 `DURATION_OUT_OF_RANGE` / `EXPORT_CONSENT_REQUIRED`, 503 `TOOL_MISSING` |
| GET      | `/api/renders/:id`                       | État, progression, avertissements                                       | 404                                                                              |
| POST     | `/api/renders/:id/cancel`                | Annule                                                                  | 409                                                                              |
| GET/HEAD | `/api/renders/:id/video`                 | Lecture avec Range                                                      | 404, 416                                                                         |
| GET      | `/api/renders/:id/download`              | Final en pièce jointe                                                   | 404, 409                                                                         |
| GET      | `/api/renders/:id/subtitles.srt`         | Sous-titres                                                             | 404                                                                              |

Entrées validées par Zod. Nouveaux codes (`packages/shared/src/errors.ts`) :
`PROPOSAL_NOT_ACCEPTED`, `DURATION_OUT_OF_RANGE`, `EXPORT_CONSENT_REQUIRED`, `RENDER_FAILED`,
`DISK_SPACE_LOW` (si absent) ; `RENDER_FAILED` couvre aussi l'échec de publication ;
avertissements : `FRAMING_NOT_VALIDATED`, `CONTEXT_MAY_BE_CUT`,
`REACTION_MAY_BE_CUT`, `WORD_CUT`, `MASKS_DISABLED`, `SOURCE_DECODE_WARNINGS`. Réutilisés :
`VERSION_CONFLICT`, `MEDIA_SOURCE_CHANGED`, `MEDIA_NOT_FOUND`, `TOOL_MISSING`, `CANCELLED`,
`UNSAFE_OUTPUT_PATH`, `IDEMPOTENCY_MISMATCH`, `PRIVACY_CONFIG_INVALID`.

---

## 9. CLI

```bash
npm run render -- --list <recordingId>
```

```bash
npm run render -- --audio <recordingId>
```

```bash
npm run render -- --consent <recordingId> --grant discord_voices|game_voice_chat|other_voices --note "accord de A et B"
```

```bash
npm run render -- --declare-mix <recordingId> --discord present|absent --game-voice-chat present|absent --other-voices present|absent
```

```bash
npm run render -- --declare-game <recordingId> --game-voice-chat present|absent
```

```bash
npm run render -- --declare-mic <recordingId> --creator-voice present|absent --other-voices present|absent
```

```bash
npm run render -- <proposalId> --create [--layout facecam_top|gameplay_crop|blurred_fit] [--captions on|off]
```

```bash
npm run render -- <proposalId> --preview|--final [--confirm-duration] [--wait]
```

Mêmes services que l'API (mêmes gardes). Codes de sortie : 0 succès, 1 erreur métier, 2 usage.
`doctor` étendu : filtres `subtitles`/`ass`/`drawbox`, encodeur `libx264`, polices fournies
lisibles ; `doctor --render` rejoue la preuve de suffisance de l'ensemble d'octets protégé (§6.5)
sur une fixture générée, avec le FFmpeg installé.

---

## 10. Interface (onglet « Clips »)

- Liste des propositions **acceptées** : titre, durée, état du projet et du dernier rendu ;
  projets dont la décision a changé affichés en lecture seule.
- Bloc « Audio exporté » de l'enregistrement : pour chaque piste, son statut (exportable ou non)
  et la raison ; déclarations de composition des pistes Tout, Jeu et Micro (choix
  « présent » / « absent » obligatoires, pas de valeur par défaut) ; consentements par catégorie
  (Discord, chat vocal du jeu, autres voix) avec note ; historique ; révocation.
- Panneau d'un clip (sans timeline) :
  - image fixe de la disposition, sélecteur de disposition, `focusX`, part de facecam ;
  - masques : liste, désactivation avec confirmation et avertissement permanent ;
  - audio : pistes réellement utilisées et règle appliquée, retrait possible d'une piste
    autorisée, rappel sur le retour des haut-parleurs dans le micro, normalisation −14 LUFS
    activable ;
  - sous-titres : activation, sources (Discord grisé sans consentement), style, liste des lignes
    avec correction, indicateurs « corrigé » / « noms remplacés » et texte d'origine consultable ;
  - effets proposés avec raison, valeurs mesurées et interrupteur ; idées de Claude en texte ;
  - durée (plage effective, bornes 5–180 s), ajustement ±10 s avec alertes contexte / réaction ;
  - « Générer l'aperçu » (progression, annulation) → lecteur ; « Exporter » → téléchargement +
    `.srt`.
- Conflit de révision → rechargement proposé. Mêmes règles de lint React que l'étape 5.

---

## 11. Sécurité et confidentialité

- Aucun shell ; chemins passés en arguments ; graphe de filtres construit uniquement depuis des
  nombres et enums validés et des noms de fichiers fixes.
- Texte de transcription traité comme non fiable (§7.3) ; noms d'export assainis (ASCII,
  longueur max, noms réservés Windows, pas de `..`) ; `assertSafeOutputPath` sur chaque sortie ;
  `Content-Disposition` encodé (RFC 5987).
- Original en lecture seule, intégrité vérifiée (§6.5).
- Consentements par catégorie de voix de tiers et déclarations de composition appliqués à
  l'audio et aux sous-titres, `mix` et chat vocal du jeu compris (§6.4, §7.5) ;
  masquage opaque par défaut (§7.2) ; pseudonymisation du texte affiché (§7.3).
- Aucun appel réseau, aucune clé, aucune publication.
- `render.json` sans chemin absolu, sans transcription, sans donnée personnelle.

---

## 12. Gestion des erreurs et cas limites

| Cas                                                                                                      | Comportement                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Proposition non acceptée / décision changée (même pendant un rendu)                                      | 409, aucun nouveau rendu ; publication refusée sous verrou (§6.7) ; exports publiés avant la décision conservés et signalés          |
| Arrêt entre le renommage et la validation en base                                                        | Récupération au démarrage (§6.7) : validé si décision toujours acceptée et SHA-256 identique, sinon retiré (jamais devenu un export) |
| Renommage impossible (fichier verrouillé)                                                                | 3 essais, puis `RENDER_FAILED` ; renommage inverse si la validation échoue                                                           |
| Source absente / modifiée (ensemble d'octets protégé)                                                    | `MEDIA_NOT_FOUND` / `MEDIA_SOURCE_CHANGED`                                                                                           |
| Structure non analysable (élément de taille inconnue, conteneur inconnu)                                 | Méthode `full_file` (plus lente) + avertissement                                                                                     |
| Pas de flux vidéo                                                                                        | `MEDIA_UNSUPPORTED`                                                                                                                  |
| Piste non exportable demandée ; `mix` ou `game` sans déclaration ; catégorie `present` sans consentement | `EXPORT_CONSENT_REQUIRED`, avec la déclaration ou le consentement manquant                                                           |
| Consentement révoqué / déclaration modifiée                                                              | Nouveau `plan_hash`, rendus antérieurs non réutilisés, exports signalés                                                              |
| Profil de cadrage non validé ou modifié                                                                  | Repli `blurred_fit` + avertissement                                                                                                  |
| Masques désactivés                                                                                       | Avertissement `MASKS_DISABLED` partout                                                                                               |
| Fichier de confidentialité invalide                                                                      | `PRIVACY_CONFIG_INVALID`, rendu refusé                                                                                               |
| Transcription absente                                                                                    | Projet sans sous-titres + avertissement                                                                                              |
| Durée hors plage effective / hors 5–180 s                                                                | 422 tant que non confirmée / refus                                                                                                   |
| FFmpeg sans libass ou libx264 ; preuve de suffisance en échec (`doctor --render`)                        | `TOOL_MISSING` / rendu refusé avec message explicite                                                                                 |
| Échec FFmpeg                                                                                             | `RENDER_FAILED` + fin de stderr (chemins absolus retirés), `.part` supprimé                                                          |
| Annulation / arrêt du serveur                                                                            | Temporaires supprimés par chemins exacts ; `renders.recover()` au démarrage                                                          |
| Espace disque insuffisant                                                                                | Refus avant lancement                                                                                                                |
| Double clic / relance                                                                                    | Idempotence `requestId` + `plan_hash` unique                                                                                         |

---

## 13. Tests

**Unitaires (sans FFmpeg)**

- `project.test.ts` : création réservée aux propositions acceptées ; bornes et repères ;
  `adjustBounds` (±10 s, calage, alertes contexte / réaction, 5–180 s, confirmation annulée par
  une nouvelle révision) ; corrections (texte d'origine conservé, annulation) ; empreinte stable.
- `audio.test.ts` : toutes les combinaisons pistes × consentements × déclarations (génération
  exhaustive) — en particulier : **`discord_voices` seul n'autorise jamais la `mix`** ; `mix`
  déclarée avec Discord et chat vocal du jeu exige les deux consentements ; composition non
  déclarée = refus ; `game` exclue sans déclaration ; `gameVoiceChat: present` sans consentement
  = exclue ; pistes individuelles préférées à la `mix` ; jamais de doublon ; retrait possible,
  ajout impossible ; sous-titres alignés sur les pistes exportables.
- `captions.test.ts` : regroupement, `SourceMs → EditMs` (dont un document à deux segments),
  Discord exclu sans consentement, pseudonymisation du texte affiché et du texte corrigé,
  transcription d'origine intacte, compteurs exacts.
- `ass.test.ts` : échappement (`{\pos(0,0)}`, `\N`, caractères de contrôle), styles bornés.
- `layout.test.ts` : pixels pairs, 1080×1920, `focusX` aux bords, facecam absente, masques
  appliqués avant recadrage (filtre identique à `frameFilter`).
- `effects.test.ts` : jamais d'effet sur l'indice seul, ni sans ancrage ; plafond de 2 ; fidèle =
  `caption_emphasis` seul ; raison et valeurs présentes ; déterminisme.
- `ffmpeg-args.test.ts`, `naming.test.ts`, `progress.test.ts`, `migration-7.test.ts`, verrou des
  migrations, `.env.example`, configuration.
- `guard.test.ts` : décision recalculée à chaque appel (pas de cache).
- `integrity.test.ts` : analyse EBML et MP4 de premier niveau, alignement sur les clusters,
  fusion des plages, repli `full_file` (taille inconnue, positions absentes), SHA-256 stable.

**Intégration FFmpeg (`*.integration.test.ts`, CI Linux + Windows)**

- Précision de coupe (`pulseMkv`, `bestLagMs` ≤ 1 image) ; durée ± 1 image ; synchronisation A/V
  (nouvelle fixture flash + bip, ≤ 1 image) ; fréquence source 60 → 60, 120 → 60.
- Géométrie (`createColorVideo`, `pixelAt`) : facecam en haut, gameplay dessous, fond flouté ;
  **zone masquée noire opaque dans toutes les dispositions, y compris le fond flouté**.
- Audio : fixture à tonalités distinctes par piste (Micro, Discord, Jeu, et Tout = somme des
  trois plus une tonalité « autre voix » propre à Tout). L'analyse spectrale de la sortie
  vérifie, pour chaque état de consentement et de déclaration, la présence ou l'absence exacte de
  chaque tonalité ; en particulier, avec `discord_voices` seul, **la tonalité propre à Tout
  n'apparaît jamais**. `loudnorm` désactivé / activé change le niveau mesuré.
- Sous-titres : zone modifiée seulement pendant l'intervalle attendu ; polices fournies.
- Zoom : bords modifiés pendant la fenêtre de l'effet uniquement.
- Intégrité, sur des fixtures MKV de type OBS (H.264 avec GOP de 2 s et de 10 s, plusieurs
  pistes AAC titrées) et MP4 de secours :
  - **preuve de suffisance** : octets hors de l'ensemble protégé mis à zéro → `framemd5` de la
    fenêtre identique à l'original ; même vérification avec `-ss` à 0,3 s après une image clé
    (copie démarrant à l'image clé précédente) et aux deux extrémités de la marge ±10 s ;
  - **nécessité** : contre-épreuves sans alignement sur les clusters ou sans zone de détection →
    rendu différent ou en échec (documente pourquoi ces règles existent) ;
  - détection : octet modifié dans un paquet de la fenêtre, dans un en-tête de bloc
    (horodatage), dans l'en-tête d'un cluster, dans `Tracks` (titre « Discord » renommé), dans
    `Cues` → `MEDIA_SOURCE_CHANGED`, **taille et date de modification restaurées** ; troncature
    → refus ; octet modifié hors de l'ensemble → non détecté et rendu inchangé (comportement
    attendu, vérifié) ;
  - repli `full_file` sur un MKV à cluster de taille inconnue ;
  - original identique après rendu ; annulation → aucun `.part`.
- Chemins Windows avec espaces et accents dans `STORAGE_DIR`.
- Clips courts (3–6 s) et préréglage basse définition pour garder la CI rapide.

**API / CLI / Web**

- Flux complet : acceptation → projet → aperçu → Range/HEAD → final → téléchargement.
- **Décision changée sans passer par l'interface** : refus via `ReviewService` directement →
  `POST renders` 409 ; refus pendant un rendu en file / en cours → aucun fichier final, rendu
  `failed`/`cancelled`.
- **Concurrence de publication**, avec des points d'arrêt injectables dans le service
  (`beforePublishLock`, `afterRename`, `beforeCommit`) :
  - refus validé entre la préparation et la transaction B → aucun fichier dans `exports/`, rendu
    `failed` ;
  - transaction B tenue pendant qu'un **autre processus** (CLI `npm run review -- --reject`)
    tente un refus → le refus attend le verrou puis réussit ; l'export publié est signalé
    « décision modifiée » ; l'ordre est cohérent ;
  - aucun entrelacement (boucle sur les points d'arrêt) ne produit un rendu `succeeded` dont la
    décision effective, au moment de son `COMMIT`, n'était pas `accepted`.
- **Récupération** : arrêt simulé après le renommage et avant le `COMMIT` → redémarrage avec
  décision acceptée → `succeeded` ; avec décision refusée entre-temps (par le CLI) → fichier
  retiré, `failed` ; SHA-256 différent → quarantaine ; fichier en attente seul → reprise de la
  transaction B ; échec simulé du `COMMIT` → renommage inverse.
- **Nettoyage** : `clean({ evictAllCache: true, dryRun: false })` pendant un rendu en cours →
  fichiers du rendu intacts ; exports finaux intacts ; aperçus réussis évincés en LRU et passés à
  `evicted` ; aperçus non classés orphelins.
- Audio exporté : consentements, déclarations, révocation, historique, effet sur `plan_hash`.
- CLI dans un processus séparé ; composants React (API simulée).

**Tests manuels différés (campagne finale sur ton PC)** : vrai enregistrement OBS multipiste,
lisibilité sur téléphone, import TikTok / Shorts / Reels, profil OBS réel, performances,
absence de retour des haut-parleurs dans le micro, contenu réel de tes pistes Tout et Jeu,
`doctor --render` sur ton FFmpeg.

Je n'affirmerai aucun résultat de test non exécuté ; chaque PR indiquera les tests réellement
lancés (local + CI).

---

## 14. Décisions validées

| #   | Sujet                            | Décision                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Moteur                           | FFmpeg seul pour l'étape 6 ; Remotion réévalué pour l'aperçu interactif de l'étape 7.                                                                                                                                                                                                                                                                   |
| 2   | Numérotation                     | 6 = moteur de rendu, 7 = éditeur complet ; feuille de route et architecture mises à jour (PR 6a).                                                                                                                                                                                                                                                       |
| 3   | Voix de tiers et confidentialité | Micro par défaut ; Discord (sous-titres **et audio exporté**) uniquement avec autorisation explicite de l'enregistrement ; `mix` et piste jeu soumises à une déclaration de composition et à un consentement par catégorie de voix présente (§6.4) ; pseudonymisation des informations personnelles affichées, tracée, transcription originale intacte. |
| 4   | Zones sensibles                  | Masquage **opaque** par défaut (approche `frames.ts`), désactivable par clip avec avertissement.                                                                                                                                                                                                                                                        |
| 5   | Polices                          | Montserrat ExtraBold et Inter, licences OFL jointes.                                                                                                                                                                                                                                                                                                    |
| 6   | Durée                            | 20–80 s par défaut (ou profil) ; bornes absolues 5–180 s ; hors plage effective = avertissement + confirmation explicite.                                                                                                                                                                                                                               |
| 7   | Bornes                           | Ajustement ±10 s, calé sur les mots, alertes contexte / réaction.                                                                                                                                                                                                                                                                                       |
| 8   | Sous-titres                      | Correction manuelle du texte, original conservé, corrections tracées.                                                                                                                                                                                                                                                                                   |
| 9   | Volume                           | −14 LUFS par défaut, désactivable.                                                                                                                                                                                                                                                                                                                      |
| 10  | Images par seconde               | Fréquence source plafonnée à 60 i/s.                                                                                                                                                                                                                                                                                                                    |
| 11  | Découpage                        | Trois PR successives (6a, 6b, 6c), chacune relue, validée et fusionnée avant la suivante.                                                                                                                                                                                                                                                               |

Corrections de relecture intégrées :

- v2 : `mix` sans contournement du consentement, RMS = indice technique (§7.4), masquage opaque
  (§7.2), intégrité réelle, décision effective garantie côté serveur, nettoyage sûr (§6.8) ;
- v3 : publication sous verrou d'écriture et récupération (§6.7) ; consentement par catégorie de
  voix, `discord_voices` n'autorisant jamais la `mix`, chat vocal du jeu (§6.4, §7.5) ;
  `streamhash` remplacé par un ensemble d'octets protégé, avec preuve de suffisance (§6.5).

---

## 15. Découpage en PR

Chaque PR part de `main` à jour, passe `npm run check` et la CI complète (Windows compris), suit
le modèle de PR, et attend ta relecture, ta validation et ta fusion avant le début de la
suivante. Aucune PR n'est fusionnée par moi.

| PR     | Branche                            | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | FFmpeg                                                                 |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **6a** | `feature/etape-6a-projet-clip`     | Schéma `ClipProject` v1, `projectFromProposal`, `adjustBounds`, sous-titres (regroupement, `EditMs`, corrections, pseudonymisation), `allowedAudio()` pure, migration 7 + verrou, audio exporté (consentements, déclarations : service, routes, CLI), garde de décision, passage des transactions de revue en `BEGIN IMMEDIATE`, manifeste d'intégrité (`packages/media/src/integrity.ts`) avec preuve de suffisance, routes projets, CLI `--list/--create/--audio/--consent/--declare-*`, docs (renumérotation, architecture §12, ce plan) | `ffprobe` (positions des paquets) et preuve de suffisance (`framemd5`) |
| **6b** | `feature/etape-6b-rendu-ffmpeg`    | `packages/render` (dispositions, masques, ASS/SRT, effets v1, plan, arguments, progression, exécution), travaux `render_clip`, contrôles avant / après rendu, **protocole de publication sous verrou et `renders.recover()`** avec tests de concurrence et de récupération, extension du nettoyage, routes rendu / vidéo / téléchargement / image fixe, polices OFL, `doctor`, variables `RENDER_*`, CLI `--preview/--final`, tests d'intégration FFmpeg (Linux + Windows)                                                                  | oui                                                                    |
| **6c** | `feature/etape-6c-interface-clips` | Onglet « Clips », bloc « Audio exporté », réglages, aperçu, export, tests composants, `docs/rendu-clips.md`, compte rendu de l'étape                                                                                                                                                                                                                                                                                                                                                                                                        | non                                                                    |

---

## 16. Fichiers concernés (prévision)

**Nouveaux**

- `packages/timeline/src/project.ts` + tests
- `packages/media/src/integrity.ts` (analyse EBML / MP4 de premier niveau, manifeste, vérification) + tests unitaires et `integrity.integration.test.ts`
- `packages/render/{package.json,tsconfig.json}`, `src/{index,presets,layout,audio,captions,ass,srt,plan,ffmpeg-args,progress,run,publish}.ts`, `src/effects/{catalog,signals}.ts` + tests unitaires et `render.integration.test.ts`
- `services/api/src/clips/{repository,service,export-audio,render-service,publish,recovery,guard,naming}.ts` + tests
- `services/api/src/routes/clips.ts`, `clips.integration.test.ts`, `migration-7.test.ts`
- `scripts/render.ts`, `tests/render-cli.test.ts`
- `apps/web/src/components/{ClipsPanel,ClipRenderEditor,ExportAudioPanel}.tsx` + tests
- `assets/fonts/` (Montserrat ExtraBold, Inter, `OFL-Montserrat.txt`, `OFL-Inter.txt`)
- `docs/rendu-clips.md`

**Modifiés**

- `services/api/src/db.ts` (migration 7 ajoutée à la suite), `migrations-lock.test.ts`
- `services/api/src/{config,services,app,context}.ts`, `storage/service.ts` (nettoyage),
  `review/service.ts` (transactions `BEGIN IMMEDIATE`, annulation des rendus à un changement de
  décision)
- `packages/media/src/frames.ts` (extraction de la construction des aplats opaques, sans
  changement de comportement, pour la partager avec le rendu)
- `packages/shared/src/errors.ts`
- `scripts/doctor.ts`, `package.json` (script `render`, workspace `packages/render`),
  `.env.example`
- `tests/helpers/media-fixtures.ts` (fixtures flash + bip, pistes à tonalités distinctes dont
  une propre à Tout, MKV de type OBS à GOP 2 s / 10 s, MKV à cluster de taille inconnue, MP4)
- `apps/web/src/{App.tsx,api.ts}`
- `docs/architecture.md` (§12), `docs/proposition-editeur-memoire.md` (feuille de route)
- `.github/workflows/*.yml` uniquement si une vérification explicite de libass sous Windows
  s'avère utile

---

## 17. Écarts de mise en œuvre (PR 6a)

Précisions apportées pendant l'implémentation de la PR 6a, sans changer les décisions du § 14 :

- **Effets** : le document prévoit la liste `effects`, mais le catalogue (`defineEffect`, indices
  techniques) est livré avec le moteur de rendu en 6b ; un projet créé en 6a a `effects: []`.
- **Sous-titres** : le regroupement des mots en lignes et le texte affiché (corrections puis
  pseudonymisation, temps montage) sont dans `@acs/timeline` (`captions.ts`), car la création du
  projet en a besoin et `@acs/timeline` ne peut pas dépendre de `@acs/render`. La génération
  ASS / SRT reste dans `@acs/render` (6b).
- **Pseudonymisation** : la fonction existante de l'étape 4 est réutilisée telle quelle ; un nom
  protégé s'affiche donc entre crochets (« [Coéquipier 1] »), ce qui rend le remplacement visible.
- **Enregistrement à piste unique** : ses sous-titres ont le rôle `mix` et suivent exactement la
  règle de la piste « tout » (déclaration + accords).
- **Export muet** : champ `audio.silent` du document, uniquement par choix explicite (jamais un
  repli) ; utilisé au rendu (6b).
- **Zone de détection** : 5 Mo par défaut (constante) ; la variable `RENDER_PROBE_BYTES` arrive en
  6b avec les autres variables de rendu, la valeur utilisée étant de toute façon enregistrée dans
  chaque manifeste.
- **Annulation des rendus depuis la revue** et `doctor --render` : en 6b, avec les rendus.

---

## 18. Écarts de mise en œuvre (PR 6b)

Précisions apportées pendant l'implémentation de la PR 6b, sans changer les décisions du § 14 :

- **Chemins en base** : `staging_rel_path`, `output_rel_path` et `srt_rel_path` sont relatifs au
  dossier `storage/` (comme les autres chemins de la base), par exemple
  `exports/2026-11-25_titre_3f2a9c1e/clip.mp4` ou `processing/renders/previews/<id>/clip.mp4`.
- **Effets** : proposés à la demande (`POST /api/clip-projects/:id/effects/suggest`,
  `npm run render -- <id> --suggest-effects`) dans une révision « système » ; jamais ajoutés sans
  cette action. L'indice d'énergie est calculé localement sur la piste micro, même non exportée :
  rien n'en sort du poste.
- **Zoom** : filtre `zoompan` (une image par image d'entrée) avec montée et descente de 0,25 s ;
  testé au pixel.
- **Idempotence des rendus** : par empreinte du plan (document, accords, confidentialité,
  intégrité, version du moteur) ; la même demande renvoie le rendu existant.
- **Annulation par la revue** : après la transaction de décision (et non dans la même), car
  l'annulation d'un processus n'est pas transactionnelle ; la garantie reste la publication sous
  verrou.
- **CLI** : `--enable-allowed-audio` ajoute explicitement les pistes et sous-titres autorisés au
  moment de la commande (projet créé avant une déclaration) ; le CLI attend la fin du rendu
  (Ctrl+C l'annule).
- **Image fixe** : renvoyée directement (JPEG), sans être stockée.
- **Sorties** : `render.json` ne contient ni chemin absolu, ni texte de transcription.
- **Récupération des rendus `finalizing` (correctif de revue)** : avant toute publication au
  redémarrage, le plan est recalculé à partir de l'état ACTUEL (document, accords et
  déclarations audio, fichier de confidentialité, intégrité, version du moteur) et doit avoir
  exactement l'empreinte du rendu ; puis, sous le verrou, décision, révision et état audio sont
  revérifiés. Un accord retiré, une déclaration modifiée, des sous-titres devenus non autorisés
  ou un fichier de confidentialité changé empêchent la publication : les fichiers sont supprimés
  (ils n'ont jamais été un export) et la ligne passe à `failed` avec la raison
  (`EXPORT_CONSENT_REQUIRED`, `VERSION_CONFLICT`, `PROPOSAL_NOT_ACCEPTED`) ; un contenu altéré
  alors que tout est valide est mis en quarantaine. Cette récupération est attendue au démarrage
  du serveur et du CLI avant tout autre travail.
- **Confidentialité relue sous le verrou (correctif de revue)** : dans la récupération comme dans
  la publication normale, l'empreinte du fichier de confidentialité est relue de façon synchrone
  DANS la transaction, juste avant tout renommage, et comparée à celle du rendu. Un fichier
  modifié entre le recalcul du plan et la publication ⇒ fichier retiré et `VERSION_CONFLICT`.

## 19. Écarts de mise en œuvre (PR 6c)

Précisions validées avant l'implémentation de la PR 6c (interface) :

- **Section « Clips »** sous « Revue des propositions », sans système d'onglets.
- **API** : `GET /api/recordings/:id/clips` renvoie aussi les projets dont la décision n'est plus
  « acceptée » (`readOnly: true`, `decision`) et le dernier rendu de chaque projet
  (`project.lastRender`). Aucune migration.
- **Audio** : ajout et retrait des pistes depuis l'interface. L'ajout ou la réactivation n'est
  proposé que pour une piste de `audio.selected` (décision du serveur) ; le serveur le revérifie
  sous verrou (`EXPORT_CONSENT_REQUIRED` sinon). Aucun changement d'API n'était nécessaire.
- **Effets proposés** (correction de la 6b) : un nouveau type d'effet arrive **désactivé** ;
  l'état des effets déjà présents (créateur ou automatiques) n'est jamais modifié, un effet
  automatique proposé de nouveau ne voit changer que ses instants et mesures, un effet plus
  proposé est conservé tel quel. Les révisions existantes ne sont jamais réécrites : les effets
  actifs créés en 6b restent actifs.
- **Image fixe** : trois mécanismes distincts.
  1. Client : debounce, abandon de la requête précédente (`AbortController`).
  2. Serveur : FFmpeg reçoit l'ordre d'arrêt si le client se déconnecte ou si une demande plus
     récente arrive pour le même projet (`409 CANCELLED` pour la précédente) ; au plus 2
     générations simultanées, refus immédiat au-delà (`409 CONFLICT`), sans file d'attente.
     Non garanti : l'arrêt n'est pas instantané (brève coexistence possible) ; la préparation du
     plan, qui ne lance aucun processus, n'est pas interrompue.
  3. Réponses obsolètes ignorées par numéro de séquence, même si l'annulation n'a pas eu lieu.
- **Sauvegarde** : file en série, brouillons locaux, même `requestId` au nouvel essai, conflit
  `409` → rechargement sans perte puis « Réappliquer » explicite.
- **Lecture seule** : aucun réglage, aucun nouveau rendu, aucune proposition d'effets ; exports
  antérieurs consultables avec l'avertissement `decisionChangedSinceExport`.
- **Style des sous-titres** limité aux champs du schéma `CaptionStyle`.
