/**
 * Réglages d'analyse d'un enregistrement : confidentialité et cadrage.
 *
 *   npm run analysis-settings -- <id>                                   afficher
 *   npm run analysis-settings -- <id> --discord-consent "Accord de …"   transmettre le texte Discord
 *   npm run analysis-settings -- <id> --no-discord                      retirer l'accord
 *   npm run analysis-settings -- <id> --facecam on|off                  images de la facecam
 *
 *   npm run framing -- list                                             profils de cadrage
 *   npm run framing -- preview <id> <profil> [--at 01:00:00]            aperçu (images sur disque)
 *   npm run framing -- validate <id> <profil>                           valider après relecture
 *   npm run framing -- clear <id>                                       aucun profil (aucune image)
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openCliContext, parseClock, runMain } from './lib/context';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'discord-consent': { type: 'string' },
    'no-discord': { type: 'boolean', default: false },
    facecam: { type: 'string' },
    at: { type: 'string' },
  },
});

const STATUS: Record<string, string> = {
  none: 'aucun profil (aucune image envoyée)',
  not_validated: 'choisi mais NON validé (aucune image envoyée)',
  changed: 'modifié depuis sa validation : à revalider (aucune image envoyée)',
  missing: 'introuvable (aucune image envoyée)',
  validated: 'validé',
};

async function main(): Promise<number> {
  const framingMode = positionals[0] === 'framing';
  const args = framingMode ? positionals.slice(1) : positionals;
  const { config, db, services } = await openCliContext();
  const a = services.analysis;
  try {
    const show = async (id: string) => {
      const s = await a.settings(id);
      console.log(
        `Texte Discord / piste « tout » : ${s.discordTextAllowed ? `TRANSMIS (accord : ${s.discordConsentNote}, ${s.discordConsentAt})` : 'non transmis'}`,
      );
      console.log(
        `Facecam : ${s.facecamAllowed ? 'images autorisées' : 'jamais envoyée (masquée)'}`,
      );
      console.log(`Cadrage : ${s.framingProfileId ?? '—'} — ${STATUS[s.framingStatus]}`);
    };

    if (framingMode) {
      const [cmd, id, profile] = args;
      if (cmd === 'list') {
        for (const p of await a.framingProfiles()) {
          console.log(
            `  ${p.id.padEnd(28)} ${p.displayName}${p.facecam ? '' : ' (sans facecam)'} — ${p.masks.length} zone(s) masquée(s)`,
          );
        }
        return 0;
      }
      if (cmd === 'preview' && id && profile) {
        const res = await a.framingPreview(
          id,
          profile,
          values.at ? parseClock(values.at) : undefined,
        );
        const dir = path.join(config.analysis.outputDir, id, 'framing');
        console.log(
          `Aperçu à ${values.at ?? `${Math.round(res.atMs / 1000)} s`} (dossier ${dir}) :`,
        );
        for (const f of res.files) {
          const label =
            f.kind === 'annotated'
              ? 'image annotée (jaune : gameplay, bleu : facecam, rouge : masqué)'
              : f.kind === 'gameplay'
                ? 'TELLE QU’ENVOYÉE (gameplay)'
                : 'TELLE QU’ENVOYÉE (facecam)';
          console.log(`  ${f.name}  ${f.width}×${f.height}  ${label}`);
        }
        console.log(`\nSi l’aperçu est correct : npm run framing -- validate ${id} ${profile}`);
        return 0;
      }
      if (cmd === 'validate' && id && profile) {
        await a.validateFraming(id, profile);
        await show(id);
        return 0;
      }
      if (cmd === 'clear' && id) {
        await a.updateSettings(id, { framingProfileId: null });
        await show(id);
        return 0;
      }
      console.error(
        'Usage : npm run framing -- list | preview <id> <profil> [--at hh:mm:ss] | validate <id> <profil> | clear <id>',
      );
      return 2;
    }

    const id = args[0];
    if (!id) {
      console.error(
        'Usage : npm run analysis-settings -- <id> [--discord-consent "note" | --no-discord] [--facecam on|off]',
      );
      return 2;
    }
    if (values['discord-consent'] !== undefined) {
      await a.updateSettings(id, {
        discordTextAllowed: true,
        discordConsentNote: values['discord-consent'],
      });
    }
    if (values['no-discord']) await a.updateSettings(id, { discordTextAllowed: false });
    if (values.facecam !== undefined) {
      if (!['on', 'off'].includes(values.facecam)) throw new Error('--facecam attend on ou off');
      await a.updateSettings(id, { facecamAllowed: values.facecam === 'on' });
    }
    await show(id);
    return 0;
  } finally {
    db.close();
  }
}

runMain(main);
