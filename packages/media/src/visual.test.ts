import { describe, expect, it } from 'vitest';
import { parseVisualActivity, visualActivityArgs } from './visual';

describe('activité visuelle : lecture de la sortie FFmpeg', () => {
  it('associe chaque différence moyenne (mafd) à l’instant de son image clé ; ignore le score de coupe', () => {
    const out = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.scd.mafd=0.000',
      'lavfi.scd.score=0.000',
      'frame:1    pts:2000    pts_time:2.002',
      'lavfi.scd.mafd=12.582',
      'lavfi.scd.score=0.230',
      'ligne parasite',
      'frame:2    pts:4000    pts_time:4',
      'lavfi.scd.mafd=150',
    ].join('\r\n');
    expect(parseVisualActivity(out)).toEqual([
      { tMs: 0, score: 0 },
      { tMs: 2002, score: 12.582 },
      { tMs: 4000, score: 100 },
    ]);
    expect(parseVisualActivity('')).toEqual([]);
  });

  it('arguments : images clés seulement, première vidéo, aucun fichier écrit', () => {
    const args = visualActivityArgs('C:\\vidéos\\stream.mkv');
    expect(args.slice(args.indexOf('-skip_frame'), args.indexOf('-skip_frame') + 2)).toEqual([
      '-skip_frame',
      'nokey',
    ]);
    expect(args).toContain('0:v:0');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
  });
});
