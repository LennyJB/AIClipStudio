/**
 * Store de l'éditeur (docs/plan-etape-7.md §6.2–6.4) avec un faux serveur qui applique le MÊME
 * réducteur : un geste = une entrée, brouillon écrit avant l'envoi, annuler / rétablir exacts (y
 * compris un lot jamais envoyé), restauration du brouillon sans doublon, réapplication par le
 * serveur, conflit sans perte, deux onglets, `HISTORY_CHANGED`, masque, autorisation audio,
 * lecture seule.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClipProjectV2, Operation } from '@acs/timeline';
import { fixtureV2 } from '../../../../packages/timeline/src/v2/test-fixtures';
import { memoryDrafts, type DraftStore, type PendingBatch } from './drafts';
import { createEditorStore, entryLabel, type EditorDeps } from './store';
import { fakeChannels, FakeEditServer, sha256Hex } from './test/fake-server';

const CTX = { allowedAudioIndexes: [1], allowedCaptionRoles: ['mic'] };

function setup(
  o: {
    server?: FakeEditServer;
    drafts?: DraftStore;
    channels?: EditorDeps['channel'];
    api?: EditorDeps['api'];
  } = {},
) {
  const server = o.server ?? new FakeEditServer(fixtureV2(), CTX);
  const drafts = o.drafts ?? memoryDrafts();
  const deps: EditorDeps = {
    api: o.api ?? server.api(),
    drafts,
    channel: o.channels ?? (() => null),
    uuid: () => crypto.randomUUID(),
    sha256: sha256Hex,
    now: () => new Date('2026-11-26T12:00:00Z'),
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const store = createEditorStore('p', deps);
  return { server, drafts, store, deps };
}

const until = async (cond: () => boolean, maxMs = 1000) => {
  for (let i = 0; i < maxMs / 5 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

const seg0 = (d: ClipProjectV2) =>
  d.segments[0] as Extract<ClipProjectV2['segments'][number], { kind: 'source' }>;
const split = (d: ClipProjectV2, newId = 'n1', at = 120_000): Operation => ({
  type: 'splitSegment',
  segmentId: seg0(d).id,
  atSrcMs: at,
  newId,
});

afterEach(() => vi.useRealTimers());

describe('lots, brouillon et historique', () => {
  it('un geste = un lot = une entrée ; brouillon écrit AVANT l’envoi puis supprimé après confirmation', async () => {
    const { server, drafts, store } = setup();
    const order: string[] = [];
    const save = drafts.save.bind(drafts);
    drafts.save = async (id, b) => {
      order.push(`brouillon:${b.length}`);
      return save(id, b);
    };
    const submit = server.submit.bind(server);
    server.submit = async (b, s) => {
      order.push(`envoi:${b.kind}`);
      return submit(b, s);
    };
    await store.getState().load();
    const d = store.getState().doc!;
    const ok = await store
      .getState()
      .dispatch(
        [split(d), { type: 'setMode', mode: 'enrichi' }, { type: 'setLayout', focusX: 0.3 }],
        'coupe et réglages',
      );
    expect(ok).toBe(true);
    await until(() => store.getState().pending.length === 0);
    expect(server.entries).toHaveLength(1);
    expect(server.entries[0]!.summary).toBe('coupe et réglages');
    expect(order).toEqual(['brouillon:1', 'envoi:do', 'brouillon:0']);
    expect(await drafts.load('p')).toEqual([]);
    expect(store.getState().server!.version).toBe(2);
    expect(store.getState().doc).toEqual(server.doc);
  });

  it('annuler puis rétablir passent par le serveur et rendent exactement les documents', async () => {
    const { server, store } = setup();
    await store.getState().load();
    const before = structuredClone(store.getState().doc!);
    await store.getState().dispatch([split(before)], 'coupe');
    await until(() => store.getState().pending.length === 0);
    const after = structuredClone(store.getState().doc!);
    await store.getState().undo();
    expect(store.getState().doc).toEqual(before);
    expect(server.entries.map((e) => e.kind)).toEqual(['do', 'undo']);
    await store.getState().redo();
    expect(store.getState().doc).toEqual(after);
    // Historique reconstruit par un NOUVEL onglet (rechargement) : annulable.
    const other = setup({ server }).store;
    await other.getState().load();
    expect(other.getState().server!.history.undo).toBe(4);
    await other.getState().undo();
    expect(other.getState().doc).toEqual(before);
  });

  it('annuler un lot pas encore envoyé le retire de la file sans rien envoyer', async () => {
    const { server, store } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const submit = server.submit.bind(server);
    server.submit = async (b, s) => {
      await gate;
      return submit(b, s);
    };
    await store.getState().load();
    const d = store.getState().doc!;
    await store.getState().dispatch([split(d, 'n1', 120_000)], 'coupe 1');
    await store.getState().dispatch([{ type: 'setMode', mode: 'enrichi' }], 'mode');
    expect(store.getState().pending).toHaveLength(2);
    await store.getState().undo(); // retire « mode », jamais envoyé
    expect(store.getState().pending.map((b) => b.summary)).toEqual(['coupe 1']);
    expect(store.getState().doc!.mode).toBe('fidele');
    release();
    await until(() => store.getState().pending.length === 0);
    expect(server.entries.map((e) => e.summary)).toEqual(['coupe 1']);
    expect(server.calls.map((c) => c.kind)).toEqual(['do']);
  });

  it('annuler pendant l’envoi attend la confirmation, puis annule par le serveur', async () => {
    const { server, store } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const submit = server.submit.bind(server);
    server.submit = async (b, s) => {
      if (b.kind === 'do') await gate;
      return submit(b, s);
    };
    await store.getState().load();
    const d = structuredClone(store.getState().doc!);
    await store.getState().dispatch([split(d)], 'coupe');
    await store.getState().undo();
    release();
    await until(() => server.entries.length === 2);
    expect(server.entries.map((e) => e.kind)).toEqual(['do', 'undo']);
    await until(() => store.getState().server!.version === 3);
    expect(store.getState().doc).toEqual(d);
  });
});

describe('reprise du brouillon (fermeture brutale)', () => {
  it('même tête : renvoi avec le MÊME requestId, aucun doublon même si le serveur l’avait reçu', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    const drafts = memoryDrafts();
    const d = server.doc;
    const batch: PendingBatch = {
      requestId: crypto.randomUUID(),
      ops: [split(d)],
      summary: 'coupe',
      base: 1,
      expectedHash: '',
      createdAt: '2026-11-26T12:00:00Z',
    };
    // Le serveur avait déjà reçu le lot, mais la confirmation a été perdue.
    await server.submit({
      requestId: batch.requestId,
      clientId: 'x',
      base: { version: 1 },
      kind: 'do',
      ops: batch.ops,
      summary: 'coupe',
    });
    // Contenu identique pour l'idempotence : même corps (clientId compris) que le premier envoi.
    const { store } = setup({ server, drafts });
    await drafts.save('p', [batch]);
    const submit = server.submit.bind(server);
    server.submit = (b, s) =>
      submit(
        { ...b, clientId: 'x', ...(b.kind === 'do' ? { expectedHash: undefined } : {}) } as never,
        s,
      );
    await store.getState().load();
    await until(() => !store.getState().restoring);
    expect(server.entries).toHaveLength(1);
    expect(await drafts.load('p')).toEqual([]);
    expect(store.getState().doc!.segments).toHaveLength(2);
  });

  it('double chargement (montage double de React) pendant la restauration : un seul envoi, aucune erreur', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    const drafts = memoryDrafts();
    const d = server.doc;
    const next = (await import('@acs/timeline')).applyBatch(d, [split(d)], CTX).doc;
    await drafts.save('p', [
      {
        requestId: crypto.randomUUID(),
        ops: [split(d)],
        summary: 'coupe',
        base: 1,
        expectedHash: await sha256Hex((await import('@acs/timeline')).canonicalJson(next)),
        createdAt: '2026-11-26T12:00:00Z',
      },
    ]);
    // Montage double de React : load(), dispose(), load() dans la même tâche. Le chargement en
    // cours est réutilisé : le brouillon n'est lu (et renvoyé) qu'une fois.
    let draftReads = 0;
    const load = drafts.load.bind(drafts);
    drafts.load = async (id) => {
      draftReads++;
      return load(id);
    };
    const { store } = setup({ server, drafts });
    const first = store.getState().load();
    store.getState().dispose();
    const second = store.getState().load();
    await Promise.all([first, second]);
    await until(() => !store.getState().restoring);
    expect(store.getState().status).toBe('ready');
    expect(server.entries).toHaveLength(1);
    expect(server.calls).toHaveLength(1);
    expect(draftReads).toBe(1);
    expect(store.getState().doc).toEqual(server.doc);
  });

  it('tête différente, gestes indépendants : réappliqué par le serveur (§6.3)', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    const drafts = memoryDrafts();
    const next = { ...server.doc, mode: 'enrichi' as const };
    await drafts.save('p', [
      {
        requestId: crypto.randomUUID(),
        ops: [{ type: 'setMode', mode: 'enrichi' }],
        summary: 'mode',
        base: 1,
        expectedHash: await sha256Hex(JSON.stringify(next)),
        createdAt: '2026-11-26T12:00:00Z',
      },
    ]);
    await server.remote([{ type: 'setLayout', focusX: 0.2 }], 'cadrage distant');
    const { store } = setup({ server, drafts });
    await store.getState().load();
    await until(() => !store.getState().restoring);
    expect(store.getState().conflict).toBeNull();
    expect(server.entries.map((e) => e.summary)).toEqual(['cadrage distant', 'mode']);
    expect(store.getState().doc).toMatchObject({ mode: 'enrichi', layout: { focusX: 0.2 } });
  });

  it('tête différente, gestes dépendants : conflit explicite, rien n’est perdu ; recharger puis réappliquer', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    const drafts = memoryDrafts();
    const d = server.doc;
    const local: PendingBatch = {
      requestId: crypto.randomUUID(),
      ops: [split(d, 'local', 115_000)],
      summary: 'coupe locale',
      base: 1,
      expectedHash: 'x'.repeat(64),
      createdAt: '2026-11-26T12:00:00Z',
    };
    await drafts.save('p', [local]);
    await server.remote([split(d, 'distant', 125_000)], 'coupe distante');
    const { store } = setup({ server, drafts });
    await store.getState().load();
    await until(() => store.getState().conflict !== null);
    expect(store.getState().conflict!.batches.map((b) => b.summary)).toEqual(['coupe locale']);
    expect((await drafts.load('p')).map((b) => b.summary)).toEqual(['coupe locale']);
    expect(server.entries).toHaveLength(1);
    // Édition suspendue tant que le conflit n'est pas résolu.
    expect(await store.getState().dispatch([{ type: 'setMode', mode: 'enrichi' }], 'x')).toBe(
      false,
    );
    await store.getState().reloadAfterConflict();
    expect(await store.getState().reapply(local.requestId)).toBe(true);
    expect(store.getState().conflict).toBeNull();
    expect(server.entries.map((e) => e.summary)).toEqual(['coupe distante', 'coupe locale']);
    expect(store.getState().doc!.segments.map((s) => s.id)).toEqual([
      seg0(d).id,
      'local',
      'distant',
    ]);
    expect(await drafts.load('p')).toEqual([]);
  });
});

describe('plusieurs onglets', () => {
  it('le geste d’un onglet est diffusé ; l’autre avance à la nouvelle tête et annule l’entrée la plus récente, libellée « autre onglet »', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    const channels = fakeChannels();
    const a = setup({ server, channels }).store;
    const b = setup({ server, channels }).store;
    await a.getState().load();
    await b.getState().load();
    await b.getState().dispatch([{ type: 'setMode', mode: 'enrichi' }], 'passage en mode enrichi');
    await until(() => a.getState().server?.version === 2);
    expect(a.getState().doc!.mode).toBe('enrichi');
    await until(() => a.getState().entries.length === 1);
    const s = a.getState();
    expect(entryLabel(s.entries, s.server!.history.undo!, s.clientId)).toBe(
      'passage en mode enrichi (autre onglet)',
    );
    expect(entryLabel(b.getState().entries, 2, b.getState().clientId)).toBe(
      'passage en mode enrichi',
    );
    await a.getState().undo();
    expect(a.getState().doc!.mode).toBe('fidele');
  });

  it('historique changé entre l’affichage et le clic : HISTORY_CHANGED, rien n’est annulé', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    const a = setup({ server }).store; // aucune diffusion : A ne voit pas le geste distant
    await a.getState().load();
    await a.getState().dispatch([{ type: 'setMode', mode: 'enrichi' }], 'mode');
    await until(() => a.getState().pending.length === 0);
    await server.remote([{ type: 'setLayout', focusX: 0.1 }], 'distant');
    await a.getState().undo();
    expect(a.getState().notice).toMatch(/historique a changé/u);
    expect(server.entries.map((e) => e.kind)).toEqual(['do', 'do']);
    // L'onglet s'est mis à jour : le prochain « annuler » vise bien l'entrée distante.
    expect(a.getState().server!.history.undo).toBe(3);
  });
});

describe('garde-fous', () => {
  it('document divergent (même version, résultat différent sur le serveur) : refusé, conflit sans perte', async () => {
    const { server, store, drafts } = setup();
    await store.getState().load();
    // Divergence simulée : le serveur a un autre document à la MÊME version.
    (server as unknown as { base: ClipProjectV2 }).base = {
      ...server.base,
      layout: { ...server.base.layout, focusX: 0.123 },
    };
    await store.getState().dispatch([{ type: 'setMode', mode: 'enrichi' }], 'mode');
    await until(() => store.getState().conflict !== null);
    expect(server.entries).toHaveLength(0);
    expect((await drafts.load('p')).map((b) => b.summary)).toEqual(['mode']);
  });

  it('annuler l’ajout d’un masque exige une confirmation explicite', async () => {
    const { server, store } = setup();
    await store.getState().load();
    await store.getState().dispatch(
      [
        {
          type: 'setEntity',
          collection: 'mask',
          entity: {
            id: 'zz',
            rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
            label: 'Notif',
            mode: 'opaque',
            srcRange: null,
          },
        },
      ],
      'masque',
    );
    await until(() => store.getState().pending.length === 0);
    await store.getState().undo();
    expect(store.getState().maskPrompt).toMatchObject({ kind: 'undo' });
    expect(server.entries).toHaveLength(1);
    await store.getState().confirmMaskPrompt();
    expect(server.entries.map((e) => e.kind)).toEqual(['do', 'undo']);
    expect(store.getState().doc!.masks.some((m) => m.id === 'zz')).toBe(false);
  });

  it('activer une piste non autorisée : refus immédiat (même réducteur), rien n’est envoyé', async () => {
    const { server, store } = setup();
    await store.getState().load();
    const ok = await store
      .getState()
      .dispatch(
        [{ type: 'setTrack', audioIndex: 2, role: 'discord', enabled: true }],
        'piste discord',
      );
    expect(ok).toBe(false);
    expect(store.getState().notice).toMatch(/non autorisée/u);
    expect(server.calls).toEqual([]);
  });

  it('lecture seule : aucune modification, aucun annuler, rien n’est envoyé', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    server.editable = false;
    const { store } = setup({ server });
    await store.getState().load();
    expect(await store.getState().dispatch([{ type: 'setMode', mode: 'enrichi' }], 'x')).toBe(
      false,
    );
    expect(store.getState().notice).toMatch(/lecture seule/u);
    await store.getState().undo();
    expect(server.calls).toEqual([]);
  });

  it('hors ligne : le lot reste dans la file et le brouillon, renvoyé ensuite', async () => {
    const { server, store, drafts } = setup();
    server.failNext = 1;
    await store.getState().load();
    await store.getState().dispatch([{ type: 'setMode', mode: 'enrichi' }], 'mode');
    await until(() => store.getState().offline);
    expect((await drafts.load('p')).length).toBe(1);
    await until(() => store.getState().pending.length === 0, 4000);
    expect(store.getState().offline).toBe(false);
    expect(server.entries).toHaveLength(1);
    expect(new Set(server.calls.map((c) => c.requestId)).size).toBe(1);
  });
});
