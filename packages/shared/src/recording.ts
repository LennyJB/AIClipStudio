import { z } from 'zod';

/**
 * Rôle d'une piste audio d'un enregistrement OBS.
 *  - mic     : micro du créateur seul
 *  - discord : vocal des coéquipiers seul
 *  - game    : son du jeu / navigateur, sans voix
 *  - mix     : tout mélangé (jeu + navigateur + micro + Discord)
 */
export const TrackRoleSchema = z.enum(['mic', 'discord', 'game', 'mix', 'unknown']);
export type TrackRole = z.infer<typeof TrackRoleSchema>;

export type TrackRoleSource = 'override' | 'title' | 'config' | 'single_track' | 'default';

export const SUPPORTED_EXTENSIONS = ['.mkv', '.mp4'] as const;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export type JobType =
  | 'extract_transcription_audio'
  | 'extract_audio_stems'
  | 'compute_waveform'
  | 'transcribe_recording';

/** File d'exécution : `heavy` (long, en arrière-plan) ou `interactive` (préparation de clip). */
export type JobLane = 'heavy' | 'interactive';
