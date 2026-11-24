/**
 * Projets de clip (étape 6a), en ligne de commande. Aucun rendu à cette étape (6b), aucun
 * appel réseau, aucune publication.
 *
 *   npm run render -- --list <recordingId>
 *   npm run render -- --audio <recordingId>
 *   npm run render -- --consent <recordingId> --grant|--revoke discord_voices|game_voice_chat|other_voices
 *                      [--note "accord de A et B"]
 *   npm run render -- --declare-mix <recordingId> --discord present|absent
 *                      --game-voice-chat present|absent --other-voices present|absent [--note "…"]
 *   npm run render -- --declare-game <recordingId> --game-voice-chat present|absent [--note "…"]
 *   npm run render -- <proposalId> --create [--layout facecam_top|gameplay_crop|blurred_fit]
 *                      [--captions on|off]
 *
 * Les mêmes services que l'API sont utilisés (mêmes gardes : décision effective recalculée,
 * audio exporté, révisions immuables).
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { describeMissing, CATEGORY_LABELS, type VoiceCategory } from '@acs/render';
import { LAYOUT_PRESETS } from '@acs/timeline';
import { openCliContext, runMain } from './lib/context';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: 'string' },
    audio: { type: 'string' },
    consent: { type: 'string' },
    grant: { type: 'string' },
    revoke: { type: 'string' },
    'declare-mix': { type: 'string' },
    'declare-game': { type: 'string' },
    discord: { type: 'string' },
    'game-voice-chat': { type: 'string' },
    'other-voices': { type: 'string' },
    note: { type: 'string' },
    create: { type: 'boolean', default: false },
    layout: { type: 'string' },
    captions: { type: 'string' },
  },
});

const USAGE =
  'Usage : npm run render -- --list <recordingId>\n' +
  '        npm run render -- --audio <recordingId>\n' +
  '        npm run render -- --consent <recordingId> --grant|--revoke <catégorie> [--note "…"]\n' +
  '        npm run render -- --declare-mix <recordingId> --discord … --game-voice-chat … --other-voices …\n' +
  '        npm run render -- --declare-game <recordingId> --game-voice-chat present|absent\n' +
  '        npm run render -- <proposalId> --create [--layout …] [--captions on|off]';

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function main(): Promise<number> {
  const ctx = await openCliContext();
  try {
    const { clips, exportAudio } = ctx.services;
    const note = values.note ? { note: values.note } : {};

    const printAudio = (recordingId: string) => {
      const v = exportAudio.view(recordingId);
      for (const t of v.decision.tracks) {
        console.log(
          `  piste ${t.audioIndex} (${t.role}) : ${t.exportable ? 'exportable' : 'NON exportable'} — ${t.reason}`,
        );
      }
      console.log(
        v.decision.mode === 'none'
          ? `  Aucun audio exportable : ${describeMissing(v.decision.missing)}`
          : `  Export : ${v.decision.selected.map((t) => t.role).join(' + ')} ; sous-titres possibles : ${v.decision.captionRoles.join(', ') || 'aucun'}`,
      );
    };

    if (values.list) {
      const l = clips.listForRecording(values.list);
      if (!l.items.length) {
        console.log(
          'Aucune proposition acceptée pour cet enregistrement (étape 5 : npm run review).',
        );
        return 0;
      }
      for (const i of l.items) {
        console.log(
          `  ${i.proposal.id}  « ${i.proposal.title} »  ${sec(i.proposal.srcEndMs - i.proposal.srcStartMs)}  ${
            i.project
              ? `projet ${i.project.id} (révision ${i.project.currentRevision})`
              : 'sans projet'
          }${i.inherited ? '  [décision héritée]' : ''}`,
        );
      }
      return 0;
    }

    if (values.audio) {
      printAudio(values.audio);
      return 0;
    }

    if (values.consent) {
      const subject = values.grant ?? values.revoke;
      if (!subject || (values.grant && values.revoke) || !(subject in CATEGORY_LABELS)) {
        console.error(
          `Indiquez --grant ou --revoke avec : ${Object.keys(CATEGORY_LABELS).join(', ')}`,
        );
        return 2;
      }
      exportAudio.record(
        values.consent,
        {
          requestId: randomUUID(),
          kind: 'consent',
          subject,
          action: values.grant ? 'granted' : 'revoked',
          ...note,
        },
        'cli',
      );
      console.log(
        `Accord ${values.grant ? 'enregistré' : 'révoqué'} : ${CATEGORY_LABELS[subject as VoiceCategory]}.`,
      );
      printAudio(values.consent);
      return 0;
    }

    if (values['declare-mix'] || values['declare-game']) {
      const recordingId = (values['declare-mix'] ?? values['declare-game'])!;
      const payload = values['declare-mix']
        ? {
            discord: values.discord,
            gameVoiceChat: values['game-voice-chat'],
            otherVoices: values['other-voices'],
          }
        : { gameVoiceChat: values['game-voice-chat'] };
      exportAudio.record(
        recordingId,
        {
          requestId: randomUUID(),
          kind: 'declaration',
          subject: values['declare-mix'] ? 'mix_composition' : 'game_composition',
          payload,
          ...note,
        },
        'cli',
      );
      console.log('Déclaration enregistrée.');
      printAudio(recordingId);
      return 0;
    }

    const proposalId = positionals[0];
    if (!proposalId || !values.create) {
      console.error(USAGE);
      return 2;
    }
    if (values.layout && !(LAYOUT_PRESETS as readonly string[]).includes(values.layout)) {
      console.error(`Disposition inconnue : ${values.layout} (${LAYOUT_PRESETS.join(', ')})`);
      return 2;
    }
    if (values.captions && !['on', 'off'].includes(values.captions)) {
      console.error('--captions attend on ou off');
      return 2;
    }
    let v = await clips.create(proposalId, { requestId: randomUUID() }, 'cli');
    console.log(
      v.created
        ? `Projet créé : ${v.project.id}`
        : `Projet existant : ${v.project.id} (révision ${v.revision})`,
    );
    const changes = {
      ...(values.layout ? { layout: { preset: values.layout } } : {}),
      ...(values.captions ? { captions: { enabled: values.captions === 'on' } } : {}),
    };
    if (Object.keys(changes).length) {
      v = {
        ...(await clips.patch(
          v.project.id,
          { requestId: randomUUID(), baseRevision: v.revision, changes },
          'cli',
        )),
        created: v.created,
      };
      console.log(`Réglages appliqués (révision ${v.revision}).`);
    }
    console.log(
      `  durée ${sec(v.durationMs)}${v.durationAccepted ? '' : ' (hors plage : confirmation requise)'} ; disposition ${v.document.layout.preset} ; audio ${
        v.document.audio.tracks.map((t) => t.role).join(' + ') || 'aucun'
      } ; sous-titres ${v.document.captions.enabled ? v.document.captions.sources.join(', ') : 'désactivés'}`,
    );
    for (const w of v.warnings) console.log(`  ⚠ ${w.message}`);
    return 0;
  } finally {
    ctx.db.close();
  }
}

runMain(main);
