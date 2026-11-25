import { describe, expect, it } from 'vitest';
import {
  applyRenderOptions,
  displayCaptions,
  projectFromProposal,
  projectSegments,
  type ClipProject,
  type CreateProjectInput,
} from '@acs/timeline';
import { allowedAudio, EMPTY_AUDIO_STATE, type ExportAudioState, type TrackIn } from './audio';
import {
  activeEffects,
  ENERGY_RATIO_THRESHOLD,
  mergeSuggestedEffects,
  rmsEnvelope,
  suggestEffects,
  type EnergyEnvelope,
} from './effects';
import { buildFrameArgs, buildRenderArgs, parseProgressLine } from './ffmpeg-args';
import { buildVideoGraph, cropToAspect, safeName, zoomExpression } from './layout';
import { buildRenderPlan, RenderPlanError, type RenderPlanInput } from './plan';
import { outputFps, presetFor } from './presets';
import {
  assColor,
  assTime,
  buildAss,
  buildSrt,
  escapeAssText,
  srtTime,
  wrapWords,
} from './subtitles';

const words = (from: number, to: number, prefix: string) => {
  const out = [];
  for (let t = from, i = 0; t + 300 <= to; t += 400, i++)
    out.push({ text: `${prefix}${i}`, srcStartMs: t, srcEndMs: t + 300 });
  return out;
};

function input(over: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return {
    proposal: {
      id: 'p1',
      runId: 'run',
      recordingId: 'rec',
      momentId: 'm1',
      srcStartMs: 110_000,
      srcEndMs: 140_000,
      punchlineMs: 125_000,
      setupStartMs: 110_400,
      reactionEndMs: 133_000,
      editingMode: null,
    },
    source: {
      fingerprint: 'fp',
      durationMs: 600_000,
      width: 1920,
      height: 1080,
      fps: 60,
      container: 'matroska',
      integrityManifestId: 'man',
    },
    framing: {
      id: 'f',
      hash: 'h',
      gameplay: { x: 0, y: 0, w: 1, h: 1 },
      facecam: { x: 0.74, y: 0.7, w: 0.25, h: 0.28 },
      masks: [{ label: 'Fil', x: 0.72, y: 0.04, w: 0.27, h: 0.2 }],
    },
    words: [
      { role: 'mic', words: words(100_000, 150_000, 'mot') },
      { role: 'discord', words: words(100_000, 150_000, 'dsc') },
    ],
    audio: { tracks: [{ audioIndex: 1, role: 'mic' }], captionRoles: ['mic'] },
    defaults: { mode: 'fidele', minMs: 20_000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
    ...over,
  };
}

const MIC_STATE: ExportAudioState = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present', otherVoices: 'absent' },
};
const TRACKS: TrackIn[] = [
  { audioIndex: 0, role: 'mix' },
  { audioIndex: 1, role: 'mic' },
  { audioIndex: 2, role: 'discord' },
];

function planInput(p: ClipProject, over: Partial<RenderPlanInput> = {}): RenderPlanInput {
  const audio = allowedAudio(TRACKS, MIC_STATE);
  return {
    project: p,
    revision: 1,
    kind: 'final',
    source: { width: 1920, height: 1080, fps: 60 },
    audio,
    captions: displayCaptions(projectSegments(p), p.captions.items, p.captions.corrections, {
      roles: p.captions.sources,
      pseudonymize: (t) => ({ text: t, replacements: 0 }),
    }),
    probeBytes: 5_000_000,
    ...over,
  };
}

const base = () => projectFromProposal(input()).project;
const ctx = (rev = 2) => ({
  nextRevision: rev,
  now: '2026-11-25T10:00:00.000Z',
  words: [],
  allowedCaptionRoles: ['mic' as const],
  allowedAudioTracks: [{ audioIndex: 1, role: 'mic' as const }],
});

describe('préréglages', () => {
  it('final 1080×1920 ; aperçu en 9:16 pair ; fréquence source plafonnée à 60 i/s', () => {
    expect(presetFor('final')).toMatchObject({ width: 1080, height: 1920, crf: 18 });
    expect(presetFor('preview')).toMatchObject({ width: 540, height: 960 });
    expect(
      presetFor('preview', { finalCrf: 18, x264Preset: 'medium', previewHeight: 641 }).width % 2,
    ).toBe(0);
    expect(outputFps(120)).toBe(60);
    expect(outputFps(59.94)).toBe(59.94);
    expect(outputFps(30)).toBe(30);
    expect(outputFps(null)).toBe(30);
  });
});

describe('dispositions et masques', () => {
  const graph = (p: ClipProject, extra: Partial<Parameters<typeof buildVideoGraph>[0]> = {}) =>
    buildVideoGraph({
      srcWidth: 1920,
      srcHeight: 1080,
      outWidth: 1080,
      outHeight: 1920,
      fps: 60,
      layout: p.layout,
      zooms: [],
      facecamZooms: [],
      subtitlesFile: 'subs.ass',
      fontsDir: 'fonts',
      ...extra,
    });

  it('recadrage au bon rapport, pixels pairs, focus aux bords', () => {
    const r = { x: 0, y: 0, w: 1920, h: 1080 };
    const left = cropToAspect(r, 9 / 16, 0);
    const right = cropToAspect(r, 9 / 16, 1);
    expect(left).toEqual({ x: 0, y: 2, w: 606, h: 1076 });
    expect(right.x + right.w).toBeLessThanOrEqual(1920);
    for (const v of Object.values(right)) expect(v % 2).toBe(0);
  });

  it('aplats opaques sur l’image source AVANT tout recadrage, dans toutes les dispositions', () => {
    for (const preset of ['facecam_top', 'gameplay_crop', 'blurred_fit'] as const) {
      const p = { ...base(), layout: { ...base().layout, preset } };
      const g = graph(p);
      expect(g, preset).toContain('drawbox=x=1382:y=43:w=518:h=216:color=black@1:t=fill');
      expect(g.indexOf('drawbox')).toBeLessThan(g.indexOf('crop='));
      expect(g.indexOf('drawbox')).toBeLessThan(
        g.indexOf('split') === -1 ? Infinity : g.indexOf('split'),
      );
    }
    const off = applyRenderOptions(
      base(),
      { masks: { modes: [{ index: 0, mode: 'off' }], acknowledgeMaskRisk: true } },
      ctx(),
    ).project;
    expect(graph(off)).not.toContain('drawbox');
  });

  it('facecam en haut : bandes empilées couvrant exactement 1920 px', () => {
    const g = graph(base());
    const heights = [...g.matchAll(/scale=1080:(\d+):flags/gu)].map((m) => Number(m[1]));
    expect(heights.reduce((a, b) => a + b, 0)).toBe(1920);
    expect(g).toContain('vstack=inputs=2');
  });

  it('fond flouté : gameplay entier au premier plan ; sous-titres par noms relatifs fixes', () => {
    const p = { ...base(), layout: { ...base().layout, preset: 'blurred_fit' as const } };
    const g = graph(p);
    expect(g).toContain('gblur=sigma=30');
    expect(g).toContain('scale=1080:606:flags=lanczos');
    expect(g).toContain('subtitles=subs.ass:fontsdir=fonts');
    expect(g.endsWith('format=yuv420p[v]')).toBe(true);
  });

  it('noms de fichiers du graphe : refus de tout chemin ou caractère spécial', () => {
    for (const bad of ['../x.ass', 'C:\\x.ass', 'a:b', "a'b", '/abs', 'a,b', '']) {
      expect(() => safeName(bad), bad).toThrow();
    }
    expect(safeName('subs.ass')).toBe('subs.ass');
  });

  it('zoom : expression numérique uniquement', () => {
    expect(zoomExpression([])).toBe('1');
    expect(zoomExpression([{ startS: 1, endS: 2.5, factor: 1.12 }])).toBe(
      '1+0.12*clip(min((it-1)/0.25,(2.5-it)/0.25),0,1)',
    );
  });
});

describe('sous-titres ASS et SRT', () => {
  const style = base().captions.style;

  it('texte non fiable : aucune balise ni échappement ASS possible', () => {
    const evil = '{\\pos(0,0)\\c&H0000FF&}pirate\\N\u0007ligne';
    const t = escapeAssText(evil);
    expect(t).not.toMatch(/[{}\\]/u);
    // eslint-disable-next-line no-control-regex
    expect(t).not.toMatch(/[\u0000-\u001f]/u);
    const ass = buildAss(
      [{ startMs: 0, endMs: 1000, text: evil, words: null, emphasize: false }],
      style,
    );
    const event = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(event.split(',,')[1]).not.toContain('\\pos');
  });

  it('découpe sans jamais perdre de mot', () => {
    const ws = 'un deux trois quatre cinq six sept huit neuf dix onze douze treize'.split(' ');
    const lines = wrapWords(ws, 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines.flat()).toEqual(ws);
  });

  it('couleurs, temps, karaoké, mise en évidence, SRT', () => {
    expect(assColor('#FFD400')).toBe('&H0000D4FF');
    expect(assTime(61_234)).toBe('0:01:01.23');
    expect(srtTime(3_723_004)).toBe('01:02:03,004');
    const line = {
      startMs: 1000,
      endMs: 3000,
      text: 'Bonjour tout le monde',
      words: [
        { text: 'Bonjour', startMs: 1200, endMs: 1600 },
        { text: 'tout', startMs: 1700, endMs: 1900 },
        { text: 'le', startMs: 2000, endMs: 2100 },
        { text: 'monde', startMs: 2100, endMs: 2600 },
      ],
      emphasize: false,
    };
    const ass = buildAss([line], style);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Style: Default,Montserrat ExtraBold,72,');
    expect(ass).toContain(
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\k20}{\\k40}Bonjour',
    );
    const emph = buildAss([{ ...line, emphasize: true }], style);
    expect(emph).toContain(
      `{\\1c${assColor(style.highlightColor)}\\fscx108\\fscy108}Bonjour tout le monde`,
    );
    expect(buildSrt([line], style)).toBe(
      '1\n00:00:01,000 --> 00:00:03,000\nBonjour tout le monde\n',
    );
  });
});

describe('effets contextuels', () => {
  const env = (base: number, peakAt: number | null, peak = 0.5): EnergyEnvelope => {
    const values: number[] = [];
    for (let t = 100_000; t < 150_000; t += 50)
      values.push(peakAt !== null && t >= peakAt && t < peakAt + 400 ? peak : base);
    return { startMs: 100_000, stepMs: 50, values };
  };

  it('fidèle : seulement la ligne de la chute, même avec un pic d’énergie', () => {
    const fx = suggestEffects({ project: base(), energy: env(0.05, 125_500) });
    expect(fx.map((e) => e.type)).toEqual(['caption_emphasis']);
  });

  it('enrichi : zoom seulement si ancrage ET indice ; raison prudente et valeurs mesurées', () => {
    const p = applyRenderOptions(base(), { mode: 'enrichi' }, ctx()).project;
    const fx = suggestEffects({ project: p, energy: env(0.05, 125_500) });
    expect(fx.map((e) => e.type)).toEqual(['caption_emphasis', 'punch_zoom']);
    const zoom = fx[1]!;
    expect(zoom.reason).toMatch(/indice technique, pas une preuve de réaction/);
    expect(zoom.signals.ratio).toBeGreaterThanOrEqual(ENERGY_RATIO_THRESHOLD);
    expect(zoom.timing.srcStartMs).toBe(124_800);
    // Sans pic, ou sans enveloppe : aucun zoom.
    expect(suggestEffects({ project: p, energy: env(0.05, null) }).map((e) => e.type)).toEqual([
      'caption_emphasis',
    ]);
    expect(suggestEffects({ project: p, energy: null }).map((e) => e.type)).toEqual([
      'caption_emphasis',
    ]);
    // Pic hors de la réaction : ignoré (jamais d'effet sur l'indice seul).
    expect(suggestEffects({ project: p, energy: env(0.05, 115_000) })).toHaveLength(1);
    // Déterministe.
    expect(suggestEffects({ project: p, energy: env(0.05, 125_500) })).toEqual(fx);
  });

  it('aucun effet dans les 2 premières secondes ; au plus 2 effets automatiques', () => {
    const p0 = projectFromProposal(
      input({ proposal: { ...input().proposal, punchlineMs: 110_500, reactionEndMs: 113_000 } }),
    ).project;
    const p = applyRenderOptions(p0, { mode: 'enrichi' }, ctx()).project;
    const fx = suggestEffects({ project: p, energy: env(0.05, 110_600) });
    expect(fx.length).toBeLessThanOrEqual(2);
    for (const e of fx.filter((x) => x.type !== 'caption_emphasis'))
      expect(e.timing.srcStartMs).toBeGreaterThanOrEqual(112_000);
  });

  it('une désactivation du créateur est conservée ; le mode fidèle neutralise les zooms', () => {
    const p = applyRenderOptions(base(), { mode: 'enrichi' }, ctx()).project;
    const fx = suggestEffects({ project: p, energy: env(0.05, 125_500) });
    const disabled = fx.map((e) => (e.type === 'punch_zoom' ? { ...e, enabled: false } : e));
    const merged = mergeSuggestedEffects(disabled, fx);
    expect(merged.find((e) => e.type === 'punch_zoom')!.enabled).toBe(false);
    const fidele = { ...p, effects: fx, mode: 'fidele' as const };
    expect(activeEffects(fidele).map((e) => e.type)).toEqual(['caption_emphasis']);
  });

  it('fusion : un nouveau type d’effet arrive désactivé ; aucun choix existant n’est modifié', () => {
    const p = applyRenderOptions(base(), { mode: 'enrichi' }, ctx()).project;
    const fx = suggestEffects({ project: p, energy: env(0.05, 125_500) });
    expect(fx.length).toBeGreaterThanOrEqual(2);
    // Projet sans effet : toutes les propositions arrivent désactivées.
    const first = mergeSuggestedEffects([], fx);
    expect(first.map((e) => e.enabled)).toEqual(fx.map(() => false));
    // Le créateur active le premier ; une nouvelle proposition le garde activé, l'autre désactivé.
    const chosen = first.map((e, i) => (i === 0 ? { ...e, enabled: true } : e));
    const again = mergeSuggestedEffects(chosen, fx);
    expect(again.map((e) => [e.type, e.enabled])).toEqual(chosen.map((e) => [e.type, e.enabled]));
    // Effet actif hérité de la 6b (enabled: true) : conservé actif.
    const legacy = mergeSuggestedEffects(fx, fx);
    expect(legacy.map((e) => e.enabled)).toEqual(fx.map(() => true));
  });

  it('fusion : effet du créateur intact ; effet plus proposé conservé ; instants mis à jour', () => {
    const p = applyRenderOptions(base(), { mode: 'enrichi' }, ctx()).project;
    const fx = suggestEffects({ project: p, energy: env(0.05, 125_500) });
    const creator = { ...fx[0]!, id: 'creator-1', origin: 'creator' as const, enabled: true };
    const stale = { ...fx[0]!, type: 'reaction_hold' as const, id: 'auto-reaction_hold' };
    const current = [creator, { ...fx[0]!, enabled: true }, stale];
    const moved = fx.map((e) =>
      e.type === fx[0]!.type
        ? {
            ...e,
            timing: { ...e.timing, srcStartMs: e.timing.srcStartMs + 100 },
          }
        : e,
    ) as typeof fx;
    const merged = mergeSuggestedEffects(current, moved.slice(0, 1));
    expect(merged[0]).toEqual(creator);
    expect(merged[1]!.enabled).toBe(true);
    expect(merged[1]!.timing).toEqual(moved[0]!.timing);
    expect(merged[2]).toEqual(stale);
    expect(merged).toHaveLength(3);
  });

  it('enveloppe RMS : silence = 0, signal plein = ~0,707', () => {
    const sine = new Int16Array(800);
    for (let i = 0; i < 800; i++) sine[i] = Math.round(32767 * Math.sin((2 * Math.PI * i) / 16));
    const e = rmsEnvelope(sine, 8000, 1000, 50);
    expect(e.values[0]).toBeGreaterThan(0.69);
    expect(rmsEnvelope(new Int16Array(800), 8000, 0).values.every((v) => v === 0)).toBe(true);
  });
});

describe('plan de rendu', () => {
  it('plan complet : durée, fps, audio autorisé, -14 LUFS, sous-titres micro', () => {
    const plan = buildRenderPlan(planInput(base()));
    expect(plan).toMatchObject({
      srcStartMs: 110_000,
      durationMs: 30_000,
      fps: 60,
      hasAudio: true,
    });
    expect(plan.audio.tracks).toEqual([{ audioIndex: 1, role: 'mic', gainDb: 0 }]);
    expect(plan.filterComplex).toContain('[0:a:1]aresample=48000');
    expect(plan.filterComplex).toContain('loudnorm=I=-14:TP=-1.5:LRA=11');
    expect(plan.ass).toContain('Dialogue:');
    expect(plan.srt).toMatch(/^1\n00:00:00,/u);
    // Aucun texte de transcription dans le graphe de filtres.
    expect(plan.filterComplex).not.toMatch(/mot\d/u);
  });

  it('normalisation désactivable', () => {
    const p = applyRenderOptions(base(), { audio: { loudnorm: false } }, ctx()).project;
    const plan = buildRenderPlan(planInput(p, { revision: 2 }));
    expect(plan.filterComplex).not.toContain('loudnorm');
    expect(plan.audio.loudnorm).toBe(false);
  });

  it('consentement revérifié : piste ou sous-titres non autorisés ⇒ refus, jamais de contournement', () => {
    const p = base();
    // Le micro n'est plus autorisé (composition non déclarée) : refus.
    const noMic = allowedAudio(TRACKS, EMPTY_AUDIO_STATE);
    expect(() => buildRenderPlan(planInput(p, { audio: noMic }))).toThrow(
      expect.objectContaining({ code: 'EXPORT_CONSENT_REQUIRED' }),
    );
    // Document falsifié contenant Discord : refus.
    const forged: ClipProject = {
      ...p,
      audio: {
        ...p.audio,
        tracks: [...p.audio.tracks, { audioIndex: 2, role: 'discord', gainDb: 0, enabled: true }],
      },
    };
    expect(() => buildRenderPlan(planInput(forged))).toThrow(/non autorisée/);
    const forgedCaptions: ClipProject = {
      ...p,
      captions: { ...p.captions, sources: ['mic', 'discord'] },
    };
    expect(() => buildRenderPlan(planInput(forgedCaptions))).toThrow(/Sous-titres non autorisés/);
    // « tout » superposée à une piste séparée : refus.
    const both: ClipProject = {
      ...p,
      audio: {
        ...p.audio,
        tracks: [{ audioIndex: 0, role: 'mix', gainDb: 0, enabled: true }, ...p.audio.tracks],
      },
    };
    const all = allowedAudio(TRACKS, {
      ...MIC_STATE,
      mixComposition: { discord: 'absent', gameVoiceChat: 'absent', otherVoices: 'absent' },
    });
    expect(() =>
      buildRenderPlan(
        planInput(both, {
          audio: { ...all, selected: [...all.selected, { audioIndex: 0, role: 'mix' }] },
        }),
      ),
    ).toThrow(/superposée/);
  });

  it('aucune piste active : refus, sauf export muet explicite', () => {
    const off = applyRenderOptions(
      base(),
      { audio: { tracks: [{ audioIndex: 1, enabled: false }] } },
      ctx(),
    ).project;
    expect(() => buildRenderPlan(planInput(off, { revision: 2 }))).toThrow(
      /Aucune piste audio active/,
    );
    const silent = applyRenderOptions(off, { audio: { silent: true } }, ctx(3)).project;
    const plan = buildRenderPlan(planInput(silent, { revision: 3 }));
    expect(plan.hasAudio).toBe(false);
    expect(buildRenderArgs(plan, { sourcePath: '/s.mkv', outputPath: '/o.part' })).toContain('-an');
  });

  it('durée hors plage refusée sans confirmation de la révision ; un seul segment à l’étape 6', () => {
    const short = projectFromProposal(
      input({ proposal: { ...input().proposal, srcEndMs: 120_000 } }),
    ).project;
    expect(() => buildRenderPlan(planInput(short))).toThrow(
      expect.objectContaining({ code: 'DURATION_OUT_OF_RANGE' }),
    );
    const ok = applyRenderOptions(short, { confirmDuration: true }, ctx()).project;
    expect(buildRenderPlan(planInput(ok, { revision: 2 })).durationMs).toBe(10_000);
    const two: ClipProject = {
      ...base(),
      segments: [
        ...base().segments,
        { id: 's2', kind: 'source', srcStartMs: 120_000, srcEndMs: 125_000, speed: 1 },
      ],
    };
    expect(() => buildRenderPlan(planInput(two))).toThrow(RenderPlanError);
  });

  it('karaoké seulement sur un texte exact ; corrigé ⇒ texte simple, jamais de mot inventé', () => {
    const p = base();
    const plan = buildRenderPlan(planInput(p));
    expect(plan.ass).toContain('\\k');
    const item = p.captions.items.find((i) => i.speakerRole === 'mic' && i.srcStartMs >= 110_000)!;
    const fixed = applyRenderOptions(
      p,
      { corrections: [{ itemId: item.id, text: 'Texte corrigé' }] },
      ctx(),
    ).project;
    const caps = displayCaptions(
      projectSegments(fixed),
      fixed.captions.items,
      fixed.captions.corrections,
      {
        roles: ['mic'],
        pseudonymize: (t) => ({ text: t, replacements: 0 }),
      },
    );
    const plan2 = buildRenderPlan(planInput(fixed, { revision: 2, captions: caps }));
    expect(plan2.ass).toMatch(/,,Texte corrigé\n/u);
    expect(plan2.srt).toContain('Texte corrigé');
  });

  it('effets : zoom seulement en mode enrichi, ligne de la chute mise en évidence', () => {
    const fx = suggestEffects({
      project: applyRenderOptions(base(), { mode: 'enrichi' }, ctx()).project,
      energy: {
        startMs: 100_000,
        stepMs: 50,
        values: Array.from({ length: 1000 }, (_, k) => (k >= 510 && k < 518 ? 0.5 : 0.05)),
      },
    });
    const enrichi = {
      ...applyRenderOptions(base(), { mode: 'enrichi' }, ctx()).project,
      effects: fx,
    };
    const plan = buildRenderPlan(planInput(enrichi, { revision: 2 }));
    expect(plan.effects.map((e) => e.type)).toEqual(['caption_emphasis', 'punch_zoom']);
    expect(plan.filterComplex).toContain('zoompan=');
    expect(plan.ass).toContain('\\fscx108');
    const fidele = { ...enrichi, mode: 'fidele' as const };
    expect(buildRenderPlan(planInput(fidele, { revision: 2 })).filterComplex).not.toContain(
      'zoompan',
    );
  });
});

describe('arguments FFmpeg', () => {
  it('-ss avant -i, durée en sortie, chemins en arguments seulement, progression', () => {
    const plan = buildRenderPlan(planInput(base()));
    const args = buildRenderArgs(plan, {
      sourcePath: 'C:\\Vidéos\\a b.mkv',
      outputPath: '/tmp/o.mp4.part',
    });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('110.000');
    expect(args[args.indexOf('-t') + 1]).toBe('30.000');
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'));
    expect(args[args.indexOf('-i') + 1]).toBe('C:\\Vidéos\\a b.mkv');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).not.toContain('Vidéos');
    expect(graph).not.toMatch(/[A-Za-z]:\\|\/tmp/u);
    expect(args.slice(-1)[0]).toBe('/tmp/o.mp4.part');
    expect(args).toEqual(
      expect.arrayContaining([
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
      ]),
    );
    const frame = buildFrameArgs(plan, 5000, { sourcePath: '/s.mkv', outputPath: '/f.jpg' });
    expect(frame[frame.indexOf('-ss') + 1]).toBe('115.000');
    expect(frame[frame.indexOf('-filter_complex') + 1]).not.toContain('subtitles');
    expect(parseProgressLine('out_time_us=15000000', 30_000)).toBe(0.5);
    expect(parseProgressLine('out_time_ms=45000000', 30_000)).toBe(1);
    expect(parseProgressLine('progress=continue', 30_000)).toBeNull();
  });
});
