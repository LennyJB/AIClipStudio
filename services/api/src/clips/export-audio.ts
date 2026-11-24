/**
 * Audio exporté : consentements (voix de tiers) et déclarations de composition des pistes, par
 * enregistrement (docs/plan-etape-6.md §6.4). Journal en ajout seul : l'état courant est le
 * dernier événement de chaque sujet ; révoquer ou redéclarer ajoute un événement.
 *
 * Distinct de l'accord « texte Discord envoyé à Claude » (étape 4) : l'un ne vaut pas l'autre.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  allowedAudio,
  EMPTY_AUDIO_STATE,
  GameCompositionSchema,
  MixCompositionSchema,
  VOICE_CATEGORIES,
  type AudioDecision,
  type ExportAudioState,
  type VoiceCategory,
} from '@acs/render';
import { AppError } from '@acs/shared';
import type { AppContext } from '../context';
import { RecordingRepository, type RecordingDto } from '../recordings/repository';
import type { Source } from '../review/repository';
import { parse } from '../routes/validation';

export const ExportAudioBodySchema = z.union([
  z
    .object({
      requestId: z.uuid(),
      kind: z.literal('consent'),
      subject: z.enum(VOICE_CATEGORIES),
      action: z.enum(['granted', 'revoked']),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      kind: z.literal('declaration'),
      subject: z.literal('mix_composition'),
      payload: MixCompositionSchema,
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      kind: z.literal('declaration'),
      subject: z.literal('game_composition'),
      payload: GameCompositionSchema,
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
]);
export type ExportAudioBody = z.infer<typeof ExportAudioBodySchema>;

export interface ExportAudioEvent {
  id: string;
  kind: 'consent' | 'declaration';
  subject: string;
  action: 'granted' | 'revoked' | 'declared';
  payload: unknown;
  note: string | null;
  source: Source;
  createdAt: string;
}

interface Row {
  id: string;
  recording_id: string;
  kind: 'consent' | 'declaration';
  subject: string;
  action: 'granted' | 'revoked' | 'declared';
  payload_json: string | null;
  note: string | null;
  request_id: string;
  source: Source;
  created_at: string;
}

const toEvent = (r: Row): ExportAudioEvent => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  action: r.action,
  payload: r.payload_json === null ? null : (JSON.parse(r.payload_json) as unknown),
  note: r.note,
  source: r.source,
  createdAt: r.created_at,
});

/** État courant à partir du journal (dernier événement par sujet). Pur. */
export function audioStateFromEvents(events: readonly ExportAudioEvent[]): ExportAudioState {
  const s: ExportAudioState = structuredClone(EMPTY_AUDIO_STATE);
  for (const e of events) {
    if (e.kind === 'consent') {
      s.consents[e.subject as VoiceCategory] = e.action === 'granted';
    } else if (e.subject === 'mix_composition') {
      s.mixComposition = MixCompositionSchema.parse(e.payload);
    } else if (e.subject === 'game_composition') {
      s.gameComposition = GameCompositionSchema.parse(e.payload);
    }
  }
  return s;
}

export interface ExportAudioView {
  recordingId: string;
  state: ExportAudioState;
  decision: AudioDecision;
  history: ExportAudioEvent[];
}

export class ExportAudioService {
  private readonly recordings: RecordingRepository;

  constructor(private readonly ctx: AppContext) {
    this.recordings = new RecordingRepository(ctx.db);
  }

  private recording(recordingId: string): RecordingDto {
    const rec = this.recordings.get(recordingId);
    if (!rec) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return rec;
  }

  history(recordingId: string): ExportAudioEvent[] {
    return (
      this.ctx.db
        .prepare('SELECT * FROM export_audio_events WHERE recording_id = ? ORDER BY seq')
        .all(recordingId) as Row[]
    ).map(toEvent);
  }

  state(recordingId: string): ExportAudioState {
    return audioStateFromEvents(this.history(recordingId));
  }

  /** Décision d'audio exporté pour un enregistrement (pistes réelles × état courant). */
  decisionFor(rec: RecordingDto): AudioDecision {
    return allowedAudio(
      rec.audioTracks.map((t) => ({ audioIndex: t.audioIndex, role: t.role })),
      this.state(rec.id),
    );
  }

  view(recordingId: string): ExportAudioView {
    const rec = this.recording(recordingId);
    const history = this.history(recordingId);
    const state = audioStateFromEvents(history);
    return {
      recordingId,
      state,
      decision: allowedAudio(
        rec.audioTracks.map((t) => ({ audioIndex: t.audioIndex, role: t.role })),
        state,
      ),
      history,
    };
  }

  /**
   * Enregistre un consentement ou une déclaration. Idempotent : le même `requestId` avec le même
   * contenu ne crée rien ; avec un autre contenu, refus explicite.
   */
  record(
    recordingId: string,
    body: unknown,
    source: Source,
  ): ExportAudioView & { replayed: boolean } {
    const b = parse(ExportAudioBodySchema, body);
    this.recording(recordingId);
    const action = b.kind === 'consent' ? b.action : 'declared';
    const payload = b.kind === 'declaration' ? JSON.stringify(b.payload) : null;
    const note = b.note ? b.note : null;
    const replayed = this.ctx.db
      .transaction(() => {
        const prior = this.ctx.db
          .prepare('SELECT * FROM export_audio_events WHERE request_id = ?')
          .get(b.requestId) as Row | undefined;
        if (prior) {
          const same =
            prior.recording_id === recordingId &&
            prior.kind === b.kind &&
            prior.subject === b.subject &&
            prior.action === action &&
            prior.payload_json === payload &&
            prior.note === note;
          if (!same) {
            throw new AppError(
              'IDEMPOTENCY_MISMATCH',
              'Cet identifiant de demande a déjà servi pour une autre demande',
            );
          }
          return true;
        }
        this.ctx.db
          .prepare(
            `INSERT INTO export_audio_events (id, recording_id, kind, subject, action, payload_json, note,
               request_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            recordingId,
            b.kind,
            b.subject,
            action,
            payload,
            note,
            b.requestId,
            source,
          );
        return false;
      })
      .immediate();
    return { ...this.view(recordingId), replayed };
  }
}
