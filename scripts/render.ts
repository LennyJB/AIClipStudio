/**
 * Projets de clip et rendus (étapes 6a et 6b), en ligne de commande. Aucun appel réseau,
 * aucune publication : l'export s'arrête au fichier dans storage/exports/.
 *
 *   npm run render -- --list <recordingId>
 *   npm run render -- --audio <recordingId>
 *   npm run render -- --consent <recordingId> --grant|--revoke discord_voices|game_voice_chat|other_voices
 *                      [--note "accord de A et B"]
 *   npm run render -- --declare-mix <recordingId> --discord present|absent
 *                      --game-voice-chat present|absent --other-voices present|absent [--note "…"]
 *   npm run render -- --declare-game <recordingId> --game-voice-chat present|absent [--note "…"]
 *   npm run render -- --declare-mic <recordingId> --creator-voice present|absent
 *                      --other-voices present|absent [--note "…"]
 *   npm run render -- <proposalId> --create [--layout facecam_top|gameplay_crop|blurred_fit]
 *                      [--captions on|off]
 *   npm run render -- <proposalId> --suggest-effects
 *   npm run render -- <proposalId> --preview|--final [--confirm-duration] [--enable-allowed-audio]
 *                      (attend la fin du rendu ; Ctrl+C l'annule proprement)
 *     --enable-allowed-audio : ajoute au projet les pistes et sous-titres AUJOURD'HUI autorisés
 *                              (après une déclaration ou un accord) ; jamais les autres.
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
    'declare-mic': { type: 'string' },
    'creator-voice': { type: 'string' },
    discord: { type: 'string' },
    'game-voice-chat': { type: 'string' },
    'other-voices': { type: 'string' },
    note: { type: 'string' },
    create: { type: 'boolean', default: false },
    layout: { type: 'string' },
    captions: { type: 'string' },
    preview: { type: 'boolean', default: false },
    final: { type: 'boolean', default: false },
    'confirm-duration': { type: 'boolean', default: false },
    'suggest-effects': { type: 'boolean', default: false },
    'enable-allowed-audio': { type: 'boolean', default: false },
  },
});

const USAGE =
  'Usage : npm run render -- --list <recordingId>\n' +
  '        npm run render -- --audio <recordingId>\n' +
  '        npm run render -- --consent <recordingId> --grant|--revoke <catégorie> [--note "…"]\n' +
  '        npm run render -- --declare-mix <recordingId> --discord … --game-voice-chat … --other-voices …\n' +
  '        npm run render -- --declare-game <recordingId> --game-voice-chat present|absent\n' +
  '        npm run render -- --declare-mic <recordingId> --creator-voice present|absent --other-voices present|absent\n' +
  '        npm run render -- <proposalId> --create [--layout …] [--captions on|off]\n' +
  '        npm run render -- <proposalId> --suggest-effects\n' +
  '        npm run render -- <proposalId> --preview|--final [--confirm-duration] [--enable-allowed-audio]';

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

    const declared = values['declare-mix']
      ? ({
          recordingId: values['declare-mix'],
          subject: 'mix_composition',
          payload: {
            discord: values.discord,
            gameVoiceChat: values['game-voice-chat'],
            otherVoices: values['other-voices'],
          },
        } as const)
      : values['declare-game']
        ? ({
            recordingId: values['declare-game'],
            subject: 'game_composition',
            payload: { gameVoiceChat: values['game-voice-chat'] },
          } as const)
        : values['declare-mic']
          ? ({
              recordingId: values['declare-mic'],
              subject: 'mic_composition',
              payload: {
                creatorVoice: values['creator-voice'],
                otherVoices: values['other-voices'],
              },
            } as const)
          : null;
    if (declared) {
      // Valeurs manquantes ou invalides : refusées par le schéma (VALIDATION_FAILED), jamais supposées.
      exportAudio.record(
        declared.recordingId,
        {
          requestId: randomUUID(),
          kind: 'declaration',
          subject: declared.subject,
          payload: declared.payload,
          ...note,
        },
        'cli',
      );
      console.log('Déclaration enregistrée.');
      printAudio(declared.recordingId);
      return 0;
    }

    const proposalId = positionals[0];
    if (proposalId && (values.preview || values.final || values['suggest-effects'])) {
      if (values.preview && values.final) {
        console.error('Choisissez --preview OU --final');
        return 2;
      }
      return await renderCommand(ctx, proposalId);
    }
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

/** Rendu ou effets d'une proposition (son projet doit exister : --create). */
async function renderCommand(
  ctx: Awaited<ReturnType<typeof openCliContext>>,
  proposalId: string,
): Promise<number> {
  const { clips, renders, runner } = ctx.services;
  const project = clips.repo.projectForProposal(proposalId);
  if (!project) {
    console.error('Aucun projet pour cette proposition : créez-le avec --create.');
    return 1;
  }
  if (values['suggest-effects']) {
    const r = await renders.suggest(project.id, {
      requestId: randomUUID(),
      baseRevision: project.currentRevision,
    });
    console.log(`Effets proposés (révision ${r.revision}) :`);
    for (const e of r.suggested) console.log(`  ${e.type} — ${e.reason}`);
    if (!r.suggested.length) console.log('  aucun');
    return 0;
  }
  let revision = project.currentRevision;
  if (values['enable-allowed-audio']) {
    const view = await clips.view(project.id);
    const allowed = view.audio.selected;
    const captionSources = view.document.captions.sources.length
      ? view.document.captions.sources.filter((r) => view.audio.captionRoles.includes(r))
      : view.audio.captionRoles.filter((r) => r === 'mic' || r === 'mix');
    const v = await clips.patch(
      project.id,
      {
        requestId: randomUUID(),
        baseRevision: revision,
        changes: {
          audio: { tracks: allowed.map((t) => ({ audioIndex: t.audioIndex, enabled: true })) },
          captions: { enabled: captionSources.length > 0, sources: captionSources },
        },
      },
      'cli',
    );
    revision = v.revision;
    console.log(
      `Pistes autorisées activées : ${allowed.map((t) => t.role).join(' + ') || 'aucune'} (révision ${revision}).`,
    );
  }
  if (values['confirm-duration']) {
    const v = await clips.patch(
      project.id,
      { requestId: randomUUID(), baseRevision: revision, changes: { confirmDuration: true } },
      'cli',
    );
    revision = v.revision;
    console.log(`Durée hors plage confirmée (révision ${revision}).`);
  }
  const kind = values.final ? 'final' : 'preview';
  const r = await renders.request(project.id, { requestId: randomUUID(), kind }, 'cli');
  if (!r.created && r.render.status === 'succeeded') {
    console.log(`Rendu identique déjà disponible : ${r.render.id}`);
  } else {
    console.log(`Rendu ${kind === 'final' ? 'final' : 'd’aperçu'} lancé : ${r.render.id}`);
    const stop = () => {
      try {
        renders.cancel(r.render.id);
      } catch {
        /* déjà terminé */
      }
    };
    process.once('SIGINT', stop);
    await runner.idle();
    process.off('SIGINT', stop);
  }
  const done = renders.get(r.render.id);
  if (done.status !== 'succeeded') {
    console.error(`Rendu ${done.status} [${done.errorCode ?? '?'}] : ${done.errorMessage ?? ''}`);
    return 1;
  }
  console.log(
    `Rendu terminé : ${done.outputRelPath} (${done.width}×${done.height}, ${sec(done.durationMs ?? 0)})`,
  );
  if (done.srtRelPath) console.log(`  sous-titres : ${done.srtRelPath}`);
  return 0;
}

runMain(main);
