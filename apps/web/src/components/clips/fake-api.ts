/**
 * Faux serveur pour les tests de l'interface des clips (aucun réseau, aucun FFmpeg). Il imite
 * les réponses de l'API, y compris ses refus (EXPORT_CONSENT_REQUIRED, VERSION_CONFLICT).
 */
import { vi } from 'vitest';
import type {
  AudioDecision,
  ExportAudioBody,
  ProjectChanges,
  ClipListItem,
  ExportAudioView,
  ProjectView,
  RenderRow,
} from '../../api';

export const REC = 'rec-1';
export const P1 = 'p1';
export const P2 = 'p2';
export const PRJ = 'prj-1';
export const PRJ_RO = 'prj-ro';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

/** Décision type : micro autorisé, Discord bloqué (accord manquant), Tout bloqué. */
export function decision(discordAllowed = false): AudioDecision {
  return {
    tracks: [
      {
        audioIndex: 0,
        role: 'mix',
        exportable: false,
        missing: [{ kind: 'declaration', subject: 'mix_composition' }],
        reason: 'bloquée : composition de la piste « tout » non déclarée',
      },
      {
        audioIndex: 1,
        role: 'mic',
        exportable: true,
        missing: [],
        reason: 'autorisée (voix du créateur)',
      },
      discordAllowed
        ? {
            audioIndex: 2,
            role: 'discord',
            exportable: true,
            missing: [],
            reason: 'autorisée (voix Discord : accord donné)',
          }
        : {
            audioIndex: 2,
            role: 'discord',
            exportable: false,
            missing: [{ kind: 'consent', subject: 'discord_voices' }],
            reason: 'bloquée : accord requis : voix Discord',
          },
    ],
    mode: 'individual',
    selected: discordAllowed
      ? [
          { audioIndex: 1, role: 'mic' },
          { audioIndex: 2, role: 'discord' },
        ]
      : [{ audioIndex: 1, role: 'mic' }],
    captionRoles: discordAllowed ? ['mic', 'discord'] : ['mic'],
    missing: [],
  };
}

export function projectView(over: Partial<ProjectView> = {}, id = PRJ): ProjectView {
  return {
    project: { id, proposalId: id === PRJ ? P1 : P2, recordingId: REC, currentRevision: 1 },
    revision: 1,
    documentHash: 'h1',
    document: {
      origin: { proposalId: P1, proposalBounds: { srcStartMs: 110_000, srcEndMs: 134_000 } },
      segments: [{ kind: 'source', srcStartMs: 110_000, srcEndMs: 134_000 }],
      layout: {
        preset: 'facecam_top',
        facecamRect: { x: 0.75, y: 0.7, w: 0.25, h: 0.3 },
        focusX: 0.5,
        facecamShare: 0.35,
        masks: [{ rect: { x: 0.7, y: 0, w: 0.3, h: 0.2 }, label: 'Pseudo', mode: 'opaque' }],
      },
      captions: {
        enabled: true,
        sources: ['mic'],
        style: {
          font: 'Montserrat ExtraBold',
          sizePx: 72,
          color: '#FFFFFF',
          highlightColor: '#FFD400',
          outlineColor: '#000000',
          outlinePx: 6,
          shadow: true,
          position: 'bottom_safe',
          uppercase: false,
          maxCharsPerLine: 28,
          maxLines: 2,
          karaoke: true,
          emphasizePunchline: true,
        },
        corrections: [],
      },
      effects: [],
      audio: {
        tracks: [{ audioIndex: 1, role: 'mic', gainDb: 0, enabled: true }],
        silent: false,
        loudnorm: { enabled: true, targetLufs: -14 },
      },
      mode: 'fidele',
      durationPolicy: { minMs: 20_000, maxMs: 80_000, outOfRangeConfirmedForRevision: null },
    },
    decision: { status: 'accepted', inherited: false, merged: false },
    editable: true,
    warnings: [],
    durationMs: 24_000,
    durationAccepted: true,
    audio: decision(),
    captions: [
      {
        itemId: 'c1',
        speakerRole: 'mic',
        originalText: 'on va tenter le plan de Théo',
        text: 'on va tenter le plan de [Coéquipier 1]',
        corrected: false,
        replacements: 1,
        editRanges: [{ editStartMs: 0, editEndMs: 2000 }],
      },
    ],
    captionsError: null,
    ...over,
  };
}

export function render(over: Partial<RenderRow> = {}): RenderRow {
  return {
    id: 'r1',
    projectId: PRJ,
    revision: 1,
    kind: 'preview',
    status: 'succeeded',
    srtRelPath: 'processing/renders/previews/r1/clip.srt',
    outputRelPath: 'processing/renders/previews/r1/clip.mp4',
    sizeBytes: 1000,
    durationMs: 24_000,
    width: 540,
    height: 960,
    warnings: [],
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-11-25T10:00:00.000Z',
    finishedAt: '2026-11-25T10:00:10.000Z',
    ...over,
  };
}

export interface FakeState {
  items: ClipListItem[];
  exportAudio: ExportAudioView;
  views: Record<string, ProjectView>;
  renders: Record<string, RenderRow[]>;
  renderProgress: Record<string, { progress: number; status: RenderRow['status'] }>;
  calls: Call[];
  /** Comportement des prochains PATCH (consommé dans l'ordre). */
  patchPlan: ('ok' | 'network' | 'conflict')[];
  /** PATCH bloqués jusqu'à résolution (test de la mise en série). */
  patchGate: Deferred<void> | null;
  /** Réponses des images fixes, dans l'ordre des demandes. */
  frameReplies: Deferred<Response>[];
  decisionChanged: Set<string>;
  /** Simule une annulation sans effet : la requête abandonnée répond quand même. */
  frameIgnoreAbort: boolean;
}

export function fakeState(): FakeState {
  return {
    items: [
      {
        proposal: {
          id: P1,
          title: 'Le plan infaillible',
          tier: 'clip',
          srcStartMs: 110_000,
          srcEndMs: 134_000,
        },
        momentId: 'm1',
        inherited: false,
        readOnly: false,
        decision: 'accepted',
        project: {
          id: PRJ,
          currentRevision: 1,
          lastRender: { id: 'r1', kind: 'preview', status: 'succeeded' },
        },
      },
      {
        proposal: {
          id: 'p3',
          title: 'Sans projet',
          tier: 'clip',
          srcStartMs: 200_000,
          srcEndMs: 230_000,
        },
        momentId: 'm3',
        inherited: false,
        readOnly: false,
        decision: 'accepted',
        project: null,
      },
      {
        proposal: {
          id: P2,
          title: 'Le malentendu',
          tier: 'secondaire',
          srcStartMs: 300_000,
          srcEndMs: 330_000,
        },
        momentId: null,
        inherited: false,
        readOnly: true,
        decision: 'rejected',
        project: {
          id: PRJ_RO,
          currentRevision: 3,
          lastRender: { id: 'rf', kind: 'final', status: 'succeeded' },
        },
      },
    ],
    exportAudio: {
      recordingId: REC,
      state: {
        consents: { discord_voices: false, game_voice_chat: false, other_voices: false },
        mixComposition: null,
        gameComposition: null,
        micComposition: { creatorVoice: 'present', otherVoices: 'absent' },
      },
      decision: decision(),
      history: [],
    },
    views: {
      [PRJ]: projectView(),
      [PRJ_RO]: projectView(
        {
          editable: false,
          decision: { status: 'rejected', inherited: false, merged: false },
          revision: 3,
        },
        PRJ_RO,
      ),
    },
    renders: {
      [PRJ]: [],
      [PRJ_RO]: [render({ id: 'rf', projectId: PRJ_RO, kind: 'final', revision: 3 })],
    },
    renderProgress: {},
    calls: [],
    patchPlan: [],
    patchGate: null,
    frameReplies: [],
    decisionChanged: new Set(['rf']),
    frameIgnoreAbort: false,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, details } }, status);

/** Applique un PATCH comme le ferait le serveur (sous-ensemble utile aux tests). */
function applyPatch(v: ProjectView, changes: ProjectChanges): Response | ProjectView {
  const doc = structuredClone(v.document);
  if (changes.layout) Object.assign(doc.layout, changes.layout);
  if (changes.masks) {
    for (const m of changes.masks.modes) doc.layout.masks[m.index]!.mode = m.mode;
    if (doc.layout.masks.some((m) => m.mode === 'off') && !changes.masks.acknowledgeMaskRisk)
      return fail(400, 'VALIDATION_FAILED', 'confirmation requise');
  }
  if (changes.audio?.tracks) {
    for (const t of changes.audio.tracks) {
      const allowed = v.audio.selected.find((x) => x.audioIndex === t.audioIndex);
      let cur = doc.audio.tracks.find((x) => x.audioIndex === t.audioIndex);
      if (!cur) {
        if (!allowed)
          return fail(
            422,
            'EXPORT_CONSENT_REQUIRED',
            `Piste ${t.audioIndex} non autorisée à l’export : elle ne peut pas être ajoutée`,
          );
        cur = { ...allowed, gainDb: 0, enabled: true };
        doc.audio.tracks.push(cur);
      }
      if (t.enabled !== false && !allowed)
        return fail(
          422,
          'EXPORT_CONSENT_REQUIRED',
          `Piste ${t.audioIndex} non autorisée à l’export`,
        );
      if (t.enabled !== undefined) cur.enabled = t.enabled;
      if (t.gainDb !== undefined) cur.gainDb = t.gainDb;
    }
  }
  if (changes.effects)
    for (const e of changes.effects) doc.effects.find((x) => x.id === e.id)!.enabled = e.enabled;
  if (changes.mode) doc.mode = changes.mode;
  if (changes.captions?.sources) doc.captions.sources = changes.captions.sources;
  const revision = v.revision + 1;
  return {
    ...v,
    document: doc,
    revision,
    project: { ...v.project, currentRevision: revision },
    durationAccepted: changes.confirmDuration ? true : v.durationAccepted,
  };
}

export function installFakeApi(s: FakeState) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const u = new URL(input, 'http://x');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    s.calls.push({ method, path: u.pathname, body, signal: init?.signal ?? null });
    const path = u.pathname;
    if (path === `/api/recordings/${REC}/clips`) return json({ items: s.items });
    if (path === `/api/recordings/${REC}/export-audio`) {
      if (method === 'POST') {
        const b = body as ExportAudioBody;
        if (b.kind === 'consent') {
          s.exportAudio.state.consents[b.subject] = b.action === 'granted';
        }
        s.exportAudio.history.push({
          id: `e${s.exportAudio.history.length + 1}`,
          kind: b.kind,
          subject: b.subject,
          action: b.kind === 'consent' ? b.action : 'declared',
          payload: b.kind === 'declaration' ? b.payload : null,
          note: b.note ?? null,
          source: 'ui',
          createdAt: '2026-11-25T10:00:00.000Z',
        });
      }
      return json(s.exportAudio);
    }
    const create = /^\/api\/proposals\/([^/]+)\/clip-project$/.exec(path);
    if (create) return json({ ...projectView(), created: true }, 201);
    if (/^\/api\/proposals\/[^/]+$/.exec(path))
      return json({ proposal: { editingHint: { ideas: ['Couper le silence avant la chute'] } } });
    const prj = /^\/api\/clip-projects\/([^/]+)(\/[a-z/]+)?$/.exec(path);
    if (prj) {
      const id = prj[1]!;
      const sub = prj[2];
      const v = s.views[id]!;
      if (!sub && method === 'GET') return json(v);
      if (!sub && method === 'PATCH') {
        if (s.patchGate) await s.patchGate.promise;
        const plan = s.patchPlan.shift() ?? 'ok';
        if (plan === 'network') throw new TypeError('Failed to fetch');
        if (plan === 'conflict')
          return fail(
            409,
            'VERSION_CONFLICT',
            'Le projet a été modifié entre-temps : rechargez-le',
            {
              currentRevision: v.revision + 1,
            },
          );
        if (!v.editable) return fail(409, 'PROPOSAL_NOT_ACCEPTED', 'Proposition refusée');
        if ((body as { baseRevision: number }).baseRevision !== v.revision)
          return fail(409, 'VERSION_CONFLICT', 'conflit', { currentRevision: v.revision });
        const r = applyPatch(v, (body as { changes: ProjectChanges }).changes);
        if (r instanceof Response) return r;
        s.views[id] = r;
        return json({ ...r, replayed: false });
      }
      if (sub === '/effects/suggest') {
        const next = structuredClone(v);
        next.revision += 1;
        next.document.effects = [
          {
            id: 'auto-punch_zoom',
            type: 'punch_zoom',
            params: { factor: 1.12 },
            timing: { anchor: 'source', srcStartMs: 125_000, srcEndMs: 126_000 },
            enabled: false,
            origin: 'auto',
            reason: 'Pic de niveau sonore au micro',
            signals: { peak: 0.42 },
          },
        ];
        s.views[id] = next;
        return json({ revision: next.revision, replayed: false, suggested: next.document.effects });
      }
      if (sub === '/frame') {
        // Chaque demande attend sa réponse, fournie par le test (s.frameReplies[i]).
        const d = deferred<Response>();
        s.frameReplies.push(d);
        return new Promise<Response>((resolve, reject) => {
          if (!s.frameIgnoreAbort)
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          void d.promise.then(resolve);
        });
      }
      if (sub === '/renders' && method === 'GET') return json({ renders: s.renders[id] ?? [] });
      if (sub === '/renders' && method === 'POST') {
        const r = render({
          id: 'r-new',
          status: 'queued',
          kind: (body as { kind: 'preview' }).kind,
        });
        s.renders[id] = [r, ...(s.renders[id] ?? [])];
        s.renderProgress['r-new'] = { progress: 0.4, status: 'running' };
        return json({ render: r, created: true }, 202);
      }
    }
    const rnd = /^\/api\/renders\/([^/]+)(\/cancel)?$/.exec(path);
    if (rnd) {
      const id = rnd[1]!;
      const all = Object.values(s.renders).flat();
      const row = all.find((r) => r.id === id)!;
      if (rnd[2]) {
        row.status = 'cancelled';
        delete s.renderProgress[id];
        return json({ render: row });
      }
      const p = s.renderProgress[id];
      if (p) row.status = p.status;
      return json({
        render: row,
        progress: p?.progress ?? (row.status === 'succeeded' ? 1 : 0),
        decisionChangedSinceExport: s.decisionChanged.has(id),
      });
    }
    return json({ error: { message: `inattendu : ${method} ${path}` } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const jpeg = (tag: string) =>
  new Response(`JPEG-${tag}`, {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
