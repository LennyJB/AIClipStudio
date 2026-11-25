import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AUDIO_GENERATOR_VERSION, AUDIO_PROFILES, isInside } from '@acs/media';
import { canonicalJson, derivativeCacheKey } from './derivatives/cache-key';

export type Db = Database.Database;

export interface MigrationContext {
  /** Dossier de stockage (pour convertir les chemins absolus en chemins relatifs). */
  storageDir?: string | undefined;
}

export interface Migration {
  version: number;
  name: string;
  /** SQL exécuté avant `up`. */
  sql?: string;
  /** Étape en code (reprise de données), dans la même transaction. */
  up?: (db: Db, ctx: MigrationContext) => void;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Migration 2 : reprise des WAV de transcription de la v1 (colonnes extracted_*)
 * en lignes media_derivatives. Un fichier absent ou hors du stockage est ignoré.
 */
function migrateExtractedTracks(db: Db, ctx: MigrationContext) {
  const rows = db
    .prepare(
      `SELECT t.recording_id, t.audio_index, t.extracted_path, t.extracted_duration_sec, r.fingerprint
       FROM audio_tracks t JOIN recordings r ON r.id = t.recording_id
       WHERE t.extracted_path IS NOT NULL`,
    )
    .all() as {
    recording_id: string;
    audio_index: number;
    extracted_path: string;
    extracted_duration_sec: number | null;
    fingerprint: string;
  }[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO media_derivatives (id, cache_key, recording_id, source_fingerprint, kind,
      audio_index, params_json, generator_version, rel_path, size_bytes, duration_ms)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'audio_transcription', ?, ?, ?, ?, ?, ?)`);
  const params = { ...AUDIO_PROFILES.transcription };
  for (const r of rows) {
    if (
      !ctx.storageDir ||
      !isInside(ctx.storageDir, r.extracted_path) ||
      !existsSync(r.extracted_path)
    ) {
      continue;
    }
    const key = derivativeCacheKey({
      sourceFingerprint: r.fingerprint,
      kind: 'audio_transcription',
      audioIndex: r.audio_index,
      range: null,
      params,
      generatorVersion: AUDIO_GENERATOR_VERSION,
    });
    insert.run(
      key,
      r.recording_id,
      r.fingerprint,
      r.audio_index,
      canonicalJson(params),
      AUDIO_GENERATOR_VERSION,
      path.relative(ctx.storageDir, r.extracted_path).split(path.sep).join('/'),
      statSync(r.extracted_path).size,
      r.extracted_duration_sec === null ? null : Math.round(r.extracted_duration_sec * 1000),
    );
  }
}

/**
 * Migrations du schéma, appliquées dans l'ordre et une seule fois.
 * Ne jamais modifier une migration publiée : en ajouter une nouvelle.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'recordings_tracks_jobs',
    sql: `
      CREATE TABLE recordings (
        id               TEXT PRIMARY KEY,
        source_path      TEXT NOT NULL,
        file_name        TEXT NOT NULL,
        size_bytes       INTEGER NOT NULL,
        mtime_ms         INTEGER NOT NULL,
        fingerprint      TEXT NOT NULL UNIQUE,
        container        TEXT NOT NULL,
        duration_sec     REAL,
        duration_source  TEXT,
        game_id          TEXT NOT NULL,
        media_info_json  TEXT NOT NULL,
        warnings_json    TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE audio_tracks (
        recording_id            TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        audio_index             INTEGER NOT NULL,
        stream_index            INTEGER NOT NULL,
        role                    TEXT NOT NULL,
        role_source             TEXT NOT NULL,
        title                   TEXT,
        codec                   TEXT,
        channels                INTEGER,
        sample_rate             INTEGER,
        start_offset_sec        REAL NOT NULL DEFAULT 0,
        extracted_path          TEXT,
        extracted_duration_sec  REAL,
        extracted_at            TEXT,
        PRIMARY KEY (recording_id, audio_index)
      );

      CREATE TABLE jobs (
        id             TEXT PRIMARY KEY,
        recording_id   TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        type           TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN
                         ('queued','running','succeeded','failed','interrupted','cancelled')),
        progress       REAL NOT NULL DEFAULT 0,
        error_code     TEXT,
        error_message  TEXT,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        started_at     TEXT,
        finished_at    TEXT
      );
      CREATE INDEX jobs_recording_idx ON jobs(recording_id, created_at);
      CREATE INDEX jobs_status_idx ON jobs(status, created_at);
    `,
  },
  {
    version: 2,
    name: 'derivatives_cache_job_targets',
    sql: `
      CREATE TABLE media_derivatives (
        id                   TEXT PRIMARY KEY,
        cache_key            TEXT NOT NULL UNIQUE,
        recording_id         TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        source_fingerprint   TEXT NOT NULL,
        kind                 TEXT NOT NULL CHECK (kind IN
                               ('audio_transcription','audio_stem','waveform','video_proxy','thumbnail')),
        audio_index          INTEGER,
        src_start_ms         INTEGER,
        src_end_ms           INTEGER,
        params_json          TEXT NOT NULL,
        generator_version    INTEGER NOT NULL,
        input_derivative_id  TEXT REFERENCES media_derivatives(id) ON DELETE SET NULL,
        rel_path             TEXT NOT NULL UNIQUE,
        size_bytes           INTEGER NOT NULL,
        duration_ms          INTEGER,
        retention            TEXT NOT NULL DEFAULT 'cache' CHECK (retention IN ('cache','keep')),
        created_at           TEXT NOT NULL DEFAULT (${NOW}),
        last_used_at         TEXT NOT NULL DEFAULT (${NOW}),
        CHECK ((src_start_ms IS NULL) = (src_end_ms IS NULL)),
        CHECK (src_start_ms IS NULL OR (src_start_ms >= 0 AND src_start_ms < src_end_ms))
      );
      CREATE INDEX media_derivatives_lookup
        ON media_derivatives(recording_id, kind, audio_index, generator_version);
      CREATE INDEX media_derivatives_lru ON media_derivatives(retention, last_used_at);

      CREATE TABLE jobs_v2 (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        lane           TEXT NOT NULL CHECK (lane IN ('heavy','interactive')),
        target_key     TEXT NOT NULL,
        recording_id   TEXT REFERENCES recordings(id) ON DELETE CASCADE,
        params_json    TEXT NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL CHECK (status IN
                         ('queued','running','succeeded','failed','interrupted','cancelled')),
        progress       REAL NOT NULL DEFAULT 0,
        result_json    TEXT,
        error_code     TEXT,
        error_message  TEXT,
        created_at     TEXT NOT NULL DEFAULT (${NOW}),
        started_at     TEXT,
        finished_at    TEXT
      );
      INSERT INTO jobs_v2 (id, type, lane, target_key, recording_id, params_json, status, progress,
                           error_code, error_message, created_at, started_at, finished_at)
        SELECT id,
               CASE type WHEN 'extract_audio' THEN 'extract_transcription_audio' ELSE type END,
               'heavy',
               'recording:' || recording_id || ':transcription_audio',
               recording_id, '{}', status, progress, error_code, error_message,
               created_at, started_at, finished_at
        FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_v2 RENAME TO jobs;
      CREATE UNIQUE INDEX jobs_active_target ON jobs(target_key) WHERE status IN ('queued','running');
      CREATE INDEX jobs_queue_idx ON jobs(lane, status, created_at);
      CREATE INDEX jobs_recording_idx ON jobs(recording_id, created_at);

      CREATE TABLE job_files (
        job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        rel_path  TEXT NOT NULL,
        usage     TEXT NOT NULL CHECK (usage IN ('input','output')),
        PRIMARY KEY (job_id, rel_path)
      );
      CREATE INDEX job_files_path_idx ON job_files(rel_path);
    `,
    up: (db, ctx) => {
      migrateExtractedTracks(db, ctx);
      db.exec(`
        ALTER TABLE audio_tracks DROP COLUMN extracted_path;
        ALTER TABLE audio_tracks DROP COLUMN extracted_duration_sec;
        ALTER TABLE audio_tracks DROP COLUMN extracted_at;
      `);
    },
  },
  {
    version: 3,
    name: 'transcriptions',
    sql: `
      -- Une transcription = une piste d'un enregistrement, avec un modèle et des paramètres donnés.
      CREATE TABLE transcriptions (
        id                      TEXT PRIMARY KEY,
        recording_id            TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        audio_index             INTEGER NOT NULL,
        cache_key               TEXT NOT NULL,   -- audio d'entrée + modèle + paramètres
        comparison_key          TEXT NOT NULL,   -- idem SANS le modèle : transcriptions comparables
        input_audio_key         TEXT NOT NULL,   -- clé du WAV dérivé (16 kHz mono) utilisé
        source_fingerprint      TEXT NOT NULL,
        engine                  TEXT NOT NULL DEFAULT 'faster-whisper',
        engine_version          TEXT,
        ctranslate2_version     TEXT,
        model                   TEXT NOT NULL,
        compute_type_requested  TEXT NOT NULL,
        device_requested        TEXT NOT NULL CHECK (device_requested IN ('auto','cuda','cpu')),
        params_json             TEXT NOT NULL,
        status                  TEXT NOT NULL CHECK (status IN
                                  ('pending','running','completed','failed','interrupted','cancelled')),
        language                TEXT,
        language_probability    REAL,            -- valeur BRUTE de Whisper (non calibrée)
        language_source         TEXT CHECK (language_source IN ('detected','forced')),
        audio_duration_ms       INTEGER,
        checkpoint_ms           INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_ms >= 0),  -- SourceMs
        segment_count           INTEGER NOT NULL DEFAULT 0,
        processing_ms           INTEGER NOT NULL DEFAULT 0,  -- somme des blocs, hors chargement
        model_load_ms           INTEGER,
        error_code              TEXT,
        error_message           TEXT,
        created_at              TEXT NOT NULL DEFAULT (${NOW}),
        started_at              TEXT,
        completed_at            TEXT,
        updated_at              TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX transcriptions_recording_idx ON transcriptions(recording_id, audio_index, created_at);
      CREATE INDEX transcriptions_cache_idx ON transcriptions(cache_key, status);

      -- Un bloc enregistré : zone centrale traitée et périphérique RÉELLEMENT utilisé.
      CREATE TABLE transcription_blocks (
        transcription_id       TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
        core_start_ms          INTEGER NOT NULL,
        core_end_ms            INTEGER NOT NULL,
        device                 TEXT NOT NULL CHECK (device IN ('cuda','cpu')),
        compute_type           TEXT NOT NULL,
        fallback_error         TEXT,      -- erreur CUDA ayant provoqué un repli CPU, le cas échéant
        elapsed_ms             INTEGER NOT NULL,
        audio_ms               INTEGER NOT NULL,
        segments_kept          INTEGER NOT NULL,
        segments_deduplicated  INTEGER NOT NULL,
        created_at             TEXT NOT NULL DEFAULT (${NOW}),
        PRIMARY KEY (transcription_id, core_start_ms),
        CHECK (core_start_ms >= 0 AND core_start_ms < core_end_ms)
      );

      CREATE TABLE transcript_segments (
        id                      INTEGER PRIMARY KEY,
        transcription_id        TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
        recording_id            TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        audio_index             INTEGER NOT NULL,
        src_start_ms            INTEGER NOT NULL,   -- SourceMs
        src_end_ms              INTEGER NOT NULL,   -- SourceMs
        text                    TEXT NOT NULL,
        avg_logprob             REAL NOT NULL,      -- métriques BRUTES de Whisper
        no_speech_prob          REAL NOT NULL,
        compression_ratio       REAL NOT NULL,
        suspicion_score         REAL NOT NULL,      -- heuristique, PAS une probabilité
        suspicion_reasons_json  TEXT NOT NULL DEFAULT '[]',
        words_json              TEXT NOT NULL DEFAULT '[]',  -- mots en SourceMs + probabilité brute
        CHECK (src_start_ms >= 0 AND src_start_ms < src_end_ms),
        UNIQUE (transcription_id, src_start_ms, src_end_ms)
      );
      CREATE INDEX transcript_segments_chrono ON transcript_segments(recording_id, src_start_ms);
      CREATE INDEX transcript_segments_run ON transcript_segments(transcription_id, src_start_ms);
    `,
  },
  {
    version: 4,
    name: 'analysis_local',
    sql: `
      -- Les contraintes CHECK de SQLite ne se modifient pas : on reconstruit deux tables
      -- (données, clés et index conservés). Les références vers les nouvelles tables sont
      -- vérifiées à la fin de la transaction.
      PRAGMA defer_foreign_keys = ON;

      -- 1. Dérivés : nouveau type 'frame' (image extraite de la vidéo).
      CREATE TABLE media_derivatives_v4 (
        id                   TEXT PRIMARY KEY,
        cache_key            TEXT NOT NULL UNIQUE,
        recording_id         TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        source_fingerprint   TEXT NOT NULL,
        kind                 TEXT NOT NULL CHECK (kind IN
                               ('audio_transcription','audio_stem','waveform','video_proxy','thumbnail','frame')),
        audio_index          INTEGER,
        src_start_ms         INTEGER,
        src_end_ms           INTEGER,
        params_json          TEXT NOT NULL,
        generator_version    INTEGER NOT NULL,
        input_derivative_id  TEXT REFERENCES media_derivatives_v4(id) ON DELETE SET NULL,
        rel_path             TEXT NOT NULL UNIQUE,
        size_bytes           INTEGER NOT NULL,
        duration_ms          INTEGER,
        retention            TEXT NOT NULL DEFAULT 'cache' CHECK (retention IN ('cache','keep')),
        created_at           TEXT NOT NULL DEFAULT (${NOW}),
        last_used_at         TEXT NOT NULL DEFAULT (${NOW}),
        CHECK ((src_start_ms IS NULL) = (src_end_ms IS NULL)),
        CHECK (src_start_ms IS NULL OR (src_start_ms >= 0 AND src_start_ms < src_end_ms))
      );
      INSERT INTO media_derivatives_v4 (id, cache_key, recording_id, source_fingerprint, kind,
          audio_index, src_start_ms, src_end_ms, params_json, generator_version, input_derivative_id,
          rel_path, size_bytes, duration_ms, retention, created_at, last_used_at)
        SELECT id, cache_key, recording_id, source_fingerprint, kind, audio_index, src_start_ms,
          src_end_ms, params_json, generator_version, input_derivative_id, rel_path, size_bytes,
          duration_ms, retention, created_at, last_used_at
        FROM media_derivatives;
      DROP TABLE media_derivatives;
      ALTER TABLE media_derivatives_v4 RENAME TO media_derivatives;
      CREATE INDEX media_derivatives_lookup
        ON media_derivatives(recording_id, kind, audio_index, generator_version);
      CREATE INDEX media_derivatives_lru ON media_derivatives(retention, last_used_at);

      -- 2. Traitements : nouvelle file 'analysis' (job_files, qui y fait référence, est
      --    reconstruite d'abord pour que la suppression de l'ancienne table ne l'efface pas).
      CREATE TABLE jobs_v4 (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        lane           TEXT NOT NULL CHECK (lane IN ('heavy','interactive','analysis')),
        target_key     TEXT NOT NULL,
        recording_id   TEXT REFERENCES recordings(id) ON DELETE CASCADE,
        params_json    TEXT NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL CHECK (status IN
                         ('queued','running','succeeded','failed','interrupted','cancelled')),
        progress       REAL NOT NULL DEFAULT 0,
        result_json    TEXT,
        error_code     TEXT,
        error_message  TEXT,
        created_at     TEXT NOT NULL DEFAULT (${NOW}),
        started_at     TEXT,
        finished_at    TEXT
      );
      INSERT INTO jobs_v4 (id, type, lane, target_key, recording_id, params_json, status, progress,
          result_json, error_code, error_message, created_at, started_at, finished_at)
        SELECT id, type, lane, target_key, recording_id, params_json, status, progress,
          result_json, error_code, error_message, created_at, started_at, finished_at
        FROM jobs;
      CREATE TABLE job_files_v4 (
        job_id    TEXT NOT NULL REFERENCES jobs_v4(id) ON DELETE CASCADE,
        rel_path  TEXT NOT NULL,
        usage     TEXT NOT NULL CHECK (usage IN ('input','output')),
        PRIMARY KEY (job_id, rel_path)
      );
      INSERT INTO job_files_v4 (job_id, rel_path, usage) SELECT job_id, rel_path, usage FROM job_files;
      DROP TABLE job_files;
      DROP TABLE jobs;
      ALTER TABLE jobs_v4 RENAME TO jobs;
      ALTER TABLE job_files_v4 RENAME TO job_files;
      CREATE UNIQUE INDEX jobs_active_target ON jobs(target_key) WHERE status IN ('queued','running');
      CREATE INDEX jobs_queue_idx ON jobs(lane, status, created_at);
      CREATE INDEX jobs_recording_idx ON jobs(recording_id, created_at);
      CREATE INDEX job_files_path_idx ON job_files(rel_path);

      -- 3. Réglages d'analyse par enregistrement (confidentialité et cadrage).
      CREATE TABLE recording_analysis_settings (
        recording_id          TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
        -- Accord explicite pour transmettre le TEXTE de Discord et de la piste « tout »
        -- (voix d'autres personnes). Jamais accordé par défaut.
        discord_text_allowed  INTEGER NOT NULL DEFAULT 0 CHECK (discord_text_allowed IN (0,1)),
        discord_consent_note  TEXT,
        discord_consent_at    TEXT,
        facecam_allowed       INTEGER NOT NULL DEFAULT 0 CHECK (facecam_allowed IN (0,1)),
        framing_profile_id    TEXT,
        framing_profile_hash  TEXT,      -- empreinte du profil AU MOMENT de la validation
        framing_validated_at  TEXT,
        updated_at            TEXT NOT NULL DEFAULT (${NOW}),
        CHECK (discord_text_allowed = 0 OR discord_consent_at IS NOT NULL),
        CHECK (framing_validated_at IS NULL
               OR (framing_profile_id IS NOT NULL AND framing_profile_hash IS NOT NULL))
      );

      -- 4. Analyses : une ligne par analyse (jamais écrasée ; une nouvelle analyse = une nouvelle ligne).
      CREATE TABLE analysis_runs (
        id                      TEXT PRIMARY KEY,
        recording_id            TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        mode                    TEXT NOT NULL CHECK (mode IN ('dry_run','claude')),
        status                  TEXT NOT NULL CHECK (status IN ('pending','running','completed',
                                  'failed','interrupted','cancelled','budget_exhausted')),
        stage                   TEXT,
        pipeline_version        INTEGER NOT NULL,
        prompt_version          TEXT,              -- null : aucun prompt (préparation locale)
        pricing_version         TEXT NOT NULL,
        memory_version          TEXT,              -- null : mémoire éditoriale non branchée
        input_key               TEXT NOT NULL,     -- transcriptions + réglages + profils + versions
        transcription_ids_json  TEXT NOT NULL,
        config_json             TEXT NOT NULL,
        privacy_json            TEXT NOT NULL,     -- réglages de confidentialité copiés au lancement
        profiles_json           TEXT NOT NULL,     -- empreintes des profils utilisés
        budget_usd              REAL NOT NULL CHECK (budget_usd > 0),
        estimate_json           TEXT,
        spent_usd               REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
        reserved_usd            REAL NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
        output_rel_dir          TEXT,              -- contenu préparé, relatif au stockage
        window_count            INTEGER NOT NULL DEFAULT 0,
        error_code              TEXT,
        error_message           TEXT,
        created_at              TEXT NOT NULL DEFAULT (${NOW}),
        started_at              TEXT,
        completed_at            TEXT,
        updated_at              TEXT NOT NULL DEFAULT (${NOW}),
        -- Plafond strict garanti par la base : dépensé + réservé ne dépasse jamais le budget.
        CHECK (spent_usd + reserved_usd <= budget_usd + 0.000001)
      );
      CREATE INDEX analysis_runs_recording_idx ON analysis_runs(recording_id, created_at);
      CREATE INDEX analysis_runs_input_idx ON analysis_runs(input_key, status);

      -- 5. Fenêtres candidates d'une analyse (temps en SourceMs).
      CREATE TABLE analysis_windows (
        id                TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        rank              INTEGER NOT NULL CHECK (rank >= 1),   -- 1 = la plus prioritaire
        origin            TEXT NOT NULL CHECK (origin IN ('signals','triage','both')),
        far_start_ms      INTEGER NOT NULL,   -- début du contexte lointain (texte seul)
        src_start_ms      INTEGER NOT NULL,   -- fenêtre avec contexte proche
        core_start_ms     INTEGER NOT NULL,   -- zone d'intérêt
        core_end_ms       INTEGER NOT NULL,
        src_end_ms        INTEGER NOT NULL,
        local_score       REAL NOT NULL CHECK (local_score >= 0 AND local_score <= 1),
        signals_json      TEXT NOT NULL,
        frames_json       TEXT NOT NULL DEFAULT '[]',
        payload_rel_path  TEXT,
        estimate_json     TEXT,
        status            TEXT NOT NULL CHECK (status IN
                            ('prepared','pending','analyzed','failed','refused','truncated','skipped')),
        cache_key         TEXT NOT NULL,
        cost_usd          REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
        created_at        TEXT NOT NULL DEFAULT (${NOW}),
        updated_at        TEXT NOT NULL DEFAULT (${NOW}),
        UNIQUE (run_id, rank),
        CHECK (far_start_ms >= 0 AND far_start_ms <= src_start_ms AND src_start_ms <= core_start_ms
               AND core_start_ms < core_end_ms AND core_end_ms <= src_end_ms)
      );
      CREATE INDEX analysis_windows_run_idx ON analysis_windows(run_id, rank);
    `,
  },
  {
    version: 5,
    name: 'analysis_claude',
    sql: `
      -- Étape 4b : appels à Claude, repérage, propositions de clips. Ajouts uniquement :
      -- aucune table existante n'est reconstruite.
      ALTER TABLE analysis_runs ADD COLUMN prepared_from_run_id TEXT
        REFERENCES analysis_runs(id) ON DELETE SET NULL;
      -- Résumé du stream produit par le repérage : NON VÉRIFIÉ, jamais une preuve.
      ALTER TABLE analysis_runs ADD COLUMN stream_summary TEXT;
      -- 1 : l'utilisateur a demandé de refaire les appels malgré des réponses réutilisables.
      ALTER TABLE analysis_runs ADD COLUMN force_recall INTEGER NOT NULL DEFAULT 0
        CHECK (force_recall IN (0,1));
      -- Coût réel au-delà de la réservation (ne devrait jamais arriver : la réservation est un
      -- pire cas). Le coût réel reste dans llm_calls ; l'analyse s'arrête dès qu'il est > 0.
      ALTER TABLE analysis_runs ADD COLUMN overrun_usd REAL NOT NULL DEFAULT 0
        CHECK (overrun_usd >= 0);

      -- Un appel (une tentative) à Claude API. La ligne est créée AVANT l'envoi, avec la
      -- réservation budgétaire du pire cas ; le coût réel la remplace à la réponse.
      CREATE TABLE llm_calls (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        window_id             TEXT REFERENCES analysis_windows(id) ON DELETE SET NULL,
        stage                 TEXT NOT NULL CHECK (stage IN ('triage','deep')),
        chunk_index           INTEGER,
        attempt               INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
        model                 TEXT NOT NULL,
        prompt_version        TEXT NOT NULL,
        request_hash          TEXT NOT NULL,
        effort                TEXT NOT NULL,
        max_tokens            INTEGER NOT NULL,
        status                TEXT NOT NULL CHECK (status IN ('reserved','succeeded','refused',
                                'truncated','invalid_output','failed','unknown_cost','reused')),
        reserved_usd          REAL NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
        cost_usd              REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
        input_tokens          INTEGER,
        cache_write_tokens    INTEGER,
        cache_read_tokens     INTEGER,
        output_tokens         INTEGER,     -- réflexion comprise
        stop_reason           TEXT,
        refusal_category      TEXT,
        refusal_explanation   TEXT,
        error_code            TEXT,
        error_message         TEXT,
        http_status           INTEGER,
        provider_request_id   TEXT,
        reused_from_call_id   TEXT REFERENCES llm_calls(id) ON DELETE SET NULL,
        sent_manifest_json    TEXT NOT NULL DEFAULT '{}',  -- ce qui a été transmis (pistes, images…)
        request_rel_path      TEXT,
        response_rel_path     TEXT,
        duration_ms           INTEGER,
        created_at            TEXT NOT NULL DEFAULT (${NOW}),
        completed_at          TEXT
      );
      CREATE INDEX llm_calls_hash_idx ON llm_calls(request_hash, status);
      CREATE INDEX llm_calls_run_idx ON llm_calls(run_id, stage, created_at);

      -- Moments signalés par le repérage global (segments transmis uniquement).
      CREATE TABLE analysis_triage_moments (
        id                TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        chunk_index       INTEGER NOT NULL,
        call_id           TEXT REFERENCES llm_calls(id) ON DELETE SET NULL,
        start_segment_id  INTEGER NOT NULL,
        end_segment_id    INTEGER NOT NULL,
        src_start_ms      INTEGER,
        src_end_ms        INTEGER,
        kind              TEXT NOT NULL,
        strength          TEXT NOT NULL CHECK (strength IN ('fort','moyen')),
        why               TEXT NOT NULL,
        valid             INTEGER NOT NULL CHECK (valid IN (0,1)),
        reject_reason     TEXT,
        created_at        TEXT NOT NULL DEFAULT (${NOW}),
        CHECK (valid = 0 OR (src_start_ms IS NOT NULL AND src_start_ms < src_end_ms))
      );
      CREATE INDEX analysis_triage_moments_run_idx ON analysis_triage_moments(run_id, chunk_index);

      -- Propositions de clips (jamais écrasées ; une nouvelle analyse en crée de nouvelles).
      CREATE TABLE clip_proposals (
        id                       TEXT PRIMARY KEY,
        run_id                   TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        recording_id             TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        window_id                TEXT REFERENCES analysis_windows(id) ON DELETE SET NULL,
        call_id                  TEXT REFERENCES llm_calls(id) ON DELETE SET NULL,
        tier                     TEXT NOT NULL CHECK (tier IN ('clip','secondary')),
        title                    TEXT NOT NULL,
        explanation              TEXT NOT NULL,
        categories_json          TEXT NOT NULL,
        relevance                INTEGER NOT NULL CHECK (relevance BETWEEN 0 AND 100),  -- Claude
        reliability              INTEGER NOT NULL CHECK (reliability BETWEEN 0 AND 100), -- calcul local
        reliability_json         TEXT NOT NULL,
        flags_json               TEXT NOT NULL DEFAULT '[]',
        src_start_ms             INTEGER NOT NULL,   -- SourceMs
        src_end_ms               INTEGER NOT NULL,   -- SourceMs
        setup_segment_id         INTEGER NOT NULL,
        punchline_segment_id     INTEGER NOT NULL,
        reaction_end_segment_id  INTEGER NOT NULL,
        punchline_ms             INTEGER NOT NULL,
        standalone               INTEGER NOT NULL CHECK (standalone IN (0,1)),
        tracks_used_json         TEXT NOT NULL DEFAULT '[]',
        visual_json              TEXT NOT NULL DEFAULT '[]',
        editing_hint_json        TEXT,
        uncertainty              TEXT,
        merged_into_id           TEXT REFERENCES clip_proposals(id) ON DELETE SET NULL,
        review_status            TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (review_status IN ('pending','accepted','rejected')),
        created_at               TEXT NOT NULL DEFAULT (${NOW}),
        CHECK (src_start_ms >= 0 AND src_start_ms < src_end_ms)
      );
      CREATE INDEX clip_proposals_run_idx ON clip_proposals(run_id, tier, relevance);
      CREATE INDEX clip_proposals_recording_idx ON clip_proposals(recording_id, created_at);

      CREATE TABLE proposal_evidence (
        id                   INTEGER PRIMARY KEY,
        proposal_id          TEXT NOT NULL REFERENCES clip_proposals(id) ON DELETE CASCADE,
        kind                 TEXT NOT NULL CHECK (kind IN ('quote','frame','signal')),
        segment_id           INTEGER,
        quote                TEXT,          -- telle qu'envoyée (pseudonymisée)
        verified             INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
        role                 TEXT,
        src_ms               INTEGER,
        frame_derivative_id  TEXT,
        note                 TEXT
      );
      CREATE INDEX proposal_evidence_idx ON proposal_evidence(proposal_id);
    `,
  },
  {
    version: 6,
    name: 'editorial_feedback',
    // Étape 5 : validation des propositions et mémoire éditoriale v1. Ajouts uniquement.
    //  - moments : regroupement stable des propositions équivalentes (référence figée) ;
    //  - proposal_reviews : décision propre à chaque proposition (source de vérité) ;
    //  - feedback_events : journal éditorial, en ajout seul, autonome (aucune clé étrangère) ;
    //  - review_requests / moment_changes : journaux techniques (idempotence, regroupements).
    // clip_proposals.review_status (migration 5) n'est plus jamais lue.
    sql: `
      CREATE TABLE review_moments (
        id                        TEXT PRIMARY KEY,
        recording_id              TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        rule_version              INTEGER NOT NULL CHECK (rule_version >= 1),
        ref_proposal_id           TEXT NOT NULL,     -- fondatrice, pour mémoire
        -- Référence FIGÉE, copiée de la fondatrice ; mêmes types que clip_proposals (migration 5).
        ref_punchline_segment_id  INTEGER NOT NULL,
        ref_punchline_ms          INTEGER NOT NULL,
        ref_src_start_ms          INTEGER NOT NULL,
        ref_src_end_ms            INTEGER NOT NULL,
        created_at                TEXT NOT NULL DEFAULT (${NOW}),
        CHECK (ref_src_start_ms >= 0 AND ref_src_start_ms < ref_src_end_ms)
      );
      CREATE INDEX review_moments_recording_idx ON review_moments(recording_id, created_at);
      CREATE TRIGGER review_moments_frozen BEFORE UPDATE ON review_moments
      BEGIN SELECT RAISE(ABORT, 'review_moments : la référence d''un moment est figée'); END;

      CREATE TABLE moment_members (
        proposal_id   TEXT PRIMARY KEY REFERENCES clip_proposals(id) ON DELETE CASCADE,
        moment_id     TEXT NOT NULL REFERENCES review_moments(id) ON DELETE CASCADE,
        match_kind    TEXT NOT NULL
                        CHECK (match_kind IN ('founder','same_punchline','overlap','detached')),
        score         REAL NOT NULL CHECK (score >= 0 AND score <= 1),
        rule_version  INTEGER NOT NULL CHECK (rule_version >= 1),
        linked_at     TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX moment_members_moment_idx ON moment_members(moment_id);
      -- Une appartenance n'est jamais modifiée : seul le détachement explicite la remplace
      -- (suppression + insertion tracées dans moment_changes).
      CREATE TRIGGER moment_members_stable BEFORE UPDATE ON moment_members
      BEGIN SELECT RAISE(ABORT, 'moment_members : une appartenance n''est jamais modifiée'); END;

      CREATE TABLE moment_changes (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT NOT NULL UNIQUE,
        request_id      TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL CHECK (kind IN ('detach')),
        proposal_id     TEXT NOT NULL,
        from_moment_id  TEXT NOT NULL,
        to_moment_id    TEXT NOT NULL,
        comment         TEXT CHECK (comment IS NULL OR length(comment) <= 2000),
        source          TEXT NOT NULL CHECK (source IN ('ui','cli','api')),
        occurred_at     TEXT NOT NULL DEFAULT (${NOW})
      );

      CREATE TABLE feedback_events (
        seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
        id                     TEXT NOT NULL UNIQUE,
        request_id             TEXT NOT NULL UNIQUE,
        schema_version         INTEGER NOT NULL CHECK (schema_version >= 1),
        type                   TEXT NOT NULL,       -- validé par Zod (types extensibles)
        occurred_at            TEXT NOT NULL DEFAULT (${NOW}),
        recording_id           TEXT NOT NULL,       -- pas de clé étrangère : le journal survit
        game_id                TEXT NOT NULL,
        proposal_id            TEXT NOT NULL,
        run_id                 TEXT NOT NULL,
        moment_id_at_decision  TEXT NOT NULL,
        previous_status        TEXT NOT NULL CHECK (previous_status IN ('pending','accepted','rejected')),
        new_status             TEXT NOT NULL CHECK (new_status IN ('pending','accepted','rejected')),
        reasons_json           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
        comment                TEXT CHECK (comment IS NULL OR length(comment) <= 2000),
        reevaluates_event_id   TEXT,
        snapshot_json          TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        source                 TEXT NOT NULL CHECK (source IN ('ui','cli','api'))
      );
      CREATE INDEX feedback_events_recording_idx ON feedback_events(recording_id, seq);
      CREATE INDEX feedback_events_game_idx ON feedback_events(game_id, seq);
      CREATE INDEX feedback_events_proposal_idx ON feedback_events(proposal_id, seq);
      CREATE INDEX feedback_events_moment_idx ON feedback_events(moment_id_at_decision, seq);
      CREATE INDEX feedback_events_type_idx ON feedback_events(type, seq);

      CREATE TABLE proposal_reviews (
        proposal_id     TEXT PRIMARY KEY REFERENCES clip_proposals(id) ON DELETE CASCADE,
        status          TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
        reasons_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
        comment         TEXT CHECK (comment IS NULL OR length(comment) <= 2000),
        decided_at      TEXT,
        last_event_id   TEXT NOT NULL REFERENCES feedback_events(id),
        last_event_seq  INTEGER NOT NULL,
        version         INTEGER NOT NULL CHECK (version >= 1),
        updated_at      TEXT NOT NULL DEFAULT (${NOW}),
        -- Une décision réinitialisée ne garde aucun motif, commentaire ni date de décision.
        CHECK (status <> 'pending' OR (reasons_json = '[]' AND comment IS NULL AND decided_at IS NULL)),
        CHECK (status <> 'accepted' OR reasons_json = '[]'),
        CHECK (status <> 'rejected' OR json_array_length(reasons_json) >= 1),
        CHECK (status = 'pending' OR decided_at IS NOT NULL)
      );

      CREATE TABLE review_requests (
        request_id     TEXT PRIMARY KEY,
        request_hash   TEXT NOT NULL,
        proposal_id    TEXT NOT NULL,
        action         TEXT NOT NULL CHECK (action IN ('decision','detach')),
        outcome        TEXT NOT NULL CHECK (outcome IN ('applied','noop')),
        event_id       TEXT,
        response_json  TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at     TEXT NOT NULL DEFAULT (${NOW}),
        CHECK (outcome = 'applied' OR event_id IS NULL)
      );

      -- Journaux en ajout seul : ni modification ni suppression.
      CREATE TRIGGER feedback_events_no_update BEFORE UPDATE ON feedback_events
      BEGIN SELECT RAISE(ABORT, 'feedback_events : journal en ajout seul'); END;
      CREATE TRIGGER feedback_events_no_delete BEFORE DELETE ON feedback_events
      BEGIN SELECT RAISE(ABORT, 'feedback_events : journal en ajout seul'); END;
      CREATE TRIGGER moment_changes_no_update BEFORE UPDATE ON moment_changes
      BEGIN SELECT RAISE(ABORT, 'moment_changes : journal en ajout seul'); END;
      CREATE TRIGGER moment_changes_no_delete BEFORE DELETE ON moment_changes
      BEGIN SELECT RAISE(ABORT, 'moment_changes : journal en ajout seul'); END;
      CREATE TRIGGER review_requests_no_update BEFORE UPDATE ON review_requests
      BEGIN SELECT RAISE(ABORT, 'review_requests : journal en ajout seul'); END;
      CREATE TRIGGER review_requests_no_delete BEFORE DELETE ON review_requests
      BEGIN SELECT RAISE(ABORT, 'review_requests : journal en ajout seul'); END;
    `,
  },
  {
    version: 7,
    name: 'clip_projects',
    // Étape 6a : projets de clip et persistance. Ajouts uniquement (docs/plan-etape-6.md §5.2).
    //  - export_audio_events : consentements (voix de tiers) et déclarations de composition des
    //    pistes (« tout », jeu, micro), par enregistrement, en ajout seul. Distincts de l'accord « texte Discord envoyé à
    //    Claude » (migration 4) : finalités différentes.
    //  - source_integrity_manifests : ensemble d'octets protégé d'une fenêtre source (§6.5).
    //  - clip_projects / clip_project_revisions : document du projet, révisions immuables. La
    //    décision effective n'y est JAMAIS copiée : elle est recalculée depuis proposal_reviews.
    //  - clip_renders : rendus (utilisés à partir de l'étape 6b).
    sql: `
      CREATE TABLE export_audio_events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        id            TEXT NOT NULL UNIQUE,
        recording_id  TEXT NOT NULL REFERENCES recordings(id),
        kind          TEXT NOT NULL CHECK (kind IN ('consent','declaration')),
        subject       TEXT NOT NULL CHECK (subject IN (
                        'discord_voices','game_voice_chat','other_voices',
                        'mix_composition','game_composition','mic_composition')),
        action        TEXT NOT NULL CHECK (action IN ('granted','revoked','declared')),
        payload_json  TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
        note          TEXT CHECK (note IS NULL OR length(note) <= 500),
        request_id    TEXT NOT NULL UNIQUE,
        source        TEXT NOT NULL CHECK (source IN ('ui','cli','api')),
        created_at    TEXT NOT NULL DEFAULT (${NOW}),
        CHECK ((kind = 'consent'
                  AND subject IN ('discord_voices','game_voice_chat','other_voices')
                  AND action IN ('granted','revoked') AND payload_json IS NULL)
            OR (kind = 'declaration'
                  AND subject IN ('mix_composition','game_composition','mic_composition')
                  AND action = 'declared' AND payload_json IS NOT NULL))
      );
      CREATE INDEX export_audio_events_recording_idx ON export_audio_events(recording_id, seq);
      CREATE TRIGGER export_audio_events_no_update BEFORE UPDATE ON export_audio_events
      BEGIN SELECT RAISE(ABORT, 'export_audio_events : journal en ajout seul'); END;
      CREATE TRIGGER export_audio_events_no_delete BEFORE DELETE ON export_audio_events
      BEGIN SELECT RAISE(ABORT, 'export_audio_events : journal en ajout seul'); END;

      CREATE TABLE source_integrity_manifests (
        id               TEXT PRIMARY KEY,
        recording_id     TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        method           TEXT NOT NULL CHECK (method IN ('byte_ranges','full_file')),
        container        TEXT NOT NULL,
        file_size        INTEGER NOT NULL CHECK (file_size >= 0),
        window_start_ms  INTEGER NOT NULL CHECK (window_start_ms >= 0),
        window_end_ms    INTEGER NOT NULL,
        probe_bytes      INTEGER NOT NULL CHECK (probe_bytes >= 0),
        ranges_json      TEXT NOT NULL CHECK (json_valid(ranges_json)),
        protected_bytes  INTEGER NOT NULL CHECK (protected_bytes >= 0),
        sha256           TEXT NOT NULL CHECK (length(sha256) = 64),
        algo_version     INTEGER NOT NULL CHECK (algo_version >= 1),
        created_at       TEXT NOT NULL DEFAULT (${NOW}),
        CHECK (window_start_ms < window_end_ms)
      );
      CREATE INDEX source_integrity_manifests_recording_idx
        ON source_integrity_manifests(recording_id);
      CREATE TRIGGER source_integrity_manifests_frozen BEFORE UPDATE ON source_integrity_manifests
      BEGIN SELECT RAISE(ABORT, 'source_integrity_manifests : un manifeste est figé'); END;

      CREATE TABLE clip_projects (
        id                TEXT PRIMARY KEY,
        proposal_id       TEXT NOT NULL UNIQUE REFERENCES clip_proposals(id),
        recording_id      TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        current_revision  INTEGER NOT NULL CHECK (current_revision >= 1),
        created_at        TEXT NOT NULL DEFAULT (${NOW}),
        updated_at        TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX clip_projects_recording_idx ON clip_projects(recording_id);

      CREATE TABLE clip_project_revisions (
        project_id      TEXT NOT NULL REFERENCES clip_projects(id) ON DELETE CASCADE,
        revision        INTEGER NOT NULL CHECK (revision >= 1),
        schema_version  INTEGER NOT NULL CHECK (schema_version >= 1),
        document_json   TEXT NOT NULL CHECK (json_valid(document_json)),
        document_hash   TEXT NOT NULL CHECK (length(document_hash) = 64),
        change_summary  TEXT CHECK (change_summary IS NULL OR length(change_summary) <= 500),
        request_id      TEXT NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('ui','cli','api','system')),
        created_at      TEXT NOT NULL DEFAULT (${NOW}),
        PRIMARY KEY (project_id, revision),
        UNIQUE (project_id, request_id)
      );
      CREATE TRIGGER clip_project_revisions_frozen BEFORE UPDATE ON clip_project_revisions
      BEGIN SELECT RAISE(ABORT, 'clip_project_revisions : une révision est immuable'); END;

      CREATE TABLE clip_renders (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES clip_projects(id) ON DELETE CASCADE,
        revision          INTEGER NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('preview','final')),
        status            TEXT NOT NULL CHECK (status IN
                            ('queued','running','finalizing','succeeded','failed','cancelled','evicted')),
        plan_hash         TEXT NOT NULL,
        job_id            TEXT,
        staging_rel_path  TEXT,
        output_rel_path   TEXT,
        output_sha256     TEXT,
        srt_rel_path      TEXT,
        size_bytes        INTEGER,
        duration_ms       INTEGER,
        width             INTEGER,
        height            INTEGER,
        toolchain_json    TEXT CHECK (toolchain_json IS NULL OR json_valid(toolchain_json)),
        warnings_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
        error_code        TEXT,
        error_message     TEXT,
        last_served_at    TEXT,
        created_at        TEXT NOT NULL DEFAULT (${NOW}),
        finished_at       TEXT,
        FOREIGN KEY (project_id, revision) REFERENCES clip_project_revisions(project_id, revision),
        CHECK (kind = 'preview' OR status <> 'evicted'),
        CHECK (status <> 'finalizing' OR (staging_rel_path IS NOT NULL
                                          AND output_rel_path IS NOT NULL
                                          AND output_sha256 IS NOT NULL)),
        CHECK (status <> 'succeeded' OR (output_rel_path IS NOT NULL AND output_sha256 IS NOT NULL))
      );
      CREATE UNIQUE INDEX clip_renders_active ON clip_renders(plan_hash, kind)
        WHERE status IN ('queued','running','finalizing','succeeded');
      CREATE INDEX clip_renders_project_idx ON clip_renders(project_id, created_at);
    `,
  },
];

export function openDatabase(
  filePath: string,
  migrations: readonly Migration[] = MIGRATIONS,
  ctx: MigrationContext = {},
): Db {
  if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL'); // lectures concurrentes + robustesse en cas d'interruption
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations, ctx);
  return db;
}

export function migrate(
  db: Db,
  migrations: readonly Migration[],
  ctx: MigrationContext = {},
): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));

  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  for (const m of pending) {
    // Chaque migration est atomique : en cas d'erreur, rien n'est appliqué.
    db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      m.up?.(db, ctx);
      insert.run(m.version, m.name);
    })();
  }
  return pending.map((m) => m.version);
}
