/**
 * Éditeur de bout en bout (docs/plan-etape-7.md §5.2, §6.2–6.4) : API RÉELLE, interface servie
 * par Vite, Chromium. Les tests partagent un projet et s'exécutent dans l'ordre.
 *
 *  - aperçu : la zone sensible (blanche) est visible sans masque (contre-épreuve) puis recouverte
 *    d'un aplat noir dès qu'une zone masquée est posée ;
 *  - deux onglets : le geste de l'un apparaît dans l'autre, « Annuler » libellé « autre onglet » ;
 *  - rechargement : annuler un geste fait avant le rechargement ;
 *  - fermeture brutale : brouillon IndexedDB restauré et envoyé sans doublon ;
 *  - proxy : lu par une vraie balise <video> à travers le proxy de Vite ; une autre origine
 *    locale est refusée (jeton et média).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from './constants';

test.describe.configure({ mode: 'serial' });

const state = () =>
  JSON.parse(readFileSync(process.env.E2E_STATE ?? E2E.stateFile, 'utf8')) as {
    projectId: string;
  };

const open = async (page: Page) => {
  await page.goto(`/#/editeur/${state().projectId}`);
  await expect(page.getByTestId('editor-page')).toBeVisible();
  await expect(page.getByTestId('editor-version')).toContainText('enregistré');
};

const version = async (page: Page) =>
  Number(/version (\d+)/u.exec((await page.getByTestId('editor-version').textContent()) ?? '')![1]);

const segments = (page: Page) => page.locator('[data-testid^="segment-"]');

/** Pixels du canvas dans un rectangle (RVB). */
const canvasPixels = (page: Page, r: { x: number; y: number; w: number; h: number }) =>
  page.evaluate((r) => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=editor-canvas]')!;
    const d = c.getContext('2d')!.getImageData(r.x, r.y, r.w, r.h).data;
    const out: [number, number, number][] = [];
    for (let i = 0; i < d.length; i += 4) out.push([d[i]!, d[i + 1]!, d[i + 2]!]);
    return out;
  }, r);

/**
 * Zone sensible dans l'aperçu 540×960 (disposition « fond flouté » : premier plan pleine largeur,
 * centré verticalement) : source 320×180 → 540×304 à y = 328.
 */
const ZONE = (() => {
  const k = 540 / 320;
  const z = E2E.sensitive;
  const m = 8; // marge intérieure (bords lissés par la mise à l'échelle)
  return {
    x: Math.ceil(z.x * k) + m,
    y: 328 + Math.ceil(z.y * k) + m,
    w: Math.floor(z.w * k) - 2 * m,
    h: Math.floor(z.h * k) - 2 * m,
  };
})();

async function apiEdit(page: Page, body: Record<string, unknown>) {
  const res = await page.request.post(`/api/clip-projects/${state().projectId}/edits`, {
    data: { requestId: crypto.randomUUID(), clientId: 'cli-e2e', ...body },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { version: number };
}

test('aperçu canvas : zone sensible visible sans masque (contre-épreuve), aplat noir avec la zone masquée', async ({
  page,
}) => {
  await open(page);
  // Sous-titres : seules les sources autorisées (micro), textes pseudonymisés par le serveur.
  await expect(page.getByText(/\[Coéquipier 1\]/u).first()).toBeVisible();
  await expect(page.getByText(/SECRET/u)).toHaveCount(0);
  await expect(page.locator('.tl-caption.role-discord')).toHaveCount(0);
  await expect(page.getByText(/Théo/u)).toHaveCount(0);
  await expect
    .poll(
      async () => (await canvasPixels(page, ZONE)).filter((p) => p.every((v) => v > 220)).length,
    )
    .toBeGreaterThan(ZONE.w * ZONE.h * 0.9);

  const v = await version(page);
  const z = E2E.sensitive;
  await apiEdit(page, {
    base: { version: v },
    kind: 'do',
    ops: [
      {
        type: 'setEntity',
        collection: 'mask',
        entity: {
          id: 'zz-e2e',
          rect: { x: z.x / 320, y: z.y / 180, w: z.w / 320, h: z.h / 180 },
          label: 'Pseudo',
          mode: 'opaque',
          srcRange: null,
        },
      },
    ],
    summary: 'zone masquée (ligne de commande)',
  });
  // L'onglet relit la tête (relecture périodique) : l'aplat est posé sur l'image source.
  await expect.poll(() => version(page), { timeout: 20_000 }).toBe(v + 1);
  await expect
    .poll(async () => (await canvasPixels(page, ZONE)).every((p) => p.every((x) => x < 30)))
    .toBe(true);
  // Aucun pixel blanc de la zone dans tout le premier plan (fond flouté compris).
  const all = await canvasPixels(page, { x: 0, y: 0, w: 540, h: 560 });
  expect(all.filter((p) => p.every((x) => x > 235)).length).toBe(0);
});

test('deux onglets : le geste de l’un apparaît dans l’autre ; « Annuler » vise l’entrée la plus récente, libellée « autre onglet »', async ({
  context,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await open(a);
  await open(b);
  const n = await segments(a).count();
  await b.getByTestId('ruler').click({ position: { x: 300, y: 5 } });
  await b.getByTestId('split').click();
  await expect(segments(b)).toHaveCount(n + 1);
  await expect(segments(a)).toHaveCount(n + 1);
  await expect(a.getByTestId('undo')).toContainText('(autre onglet)');
  await expect(b.getByTestId('undo')).not.toContainText('(autre onglet)');
  await a.getByTestId('undo').click();
  await expect(segments(a)).toHaveCount(n);
  await expect(segments(b)).toHaveCount(n);
  await a.close();
  await b.close();
});

test('rechargement : un geste fait avant le rechargement s’annule exactement', async ({ page }) => {
  await open(page);
  const n = await segments(page).count();
  await page.getByTestId('ruler').click({ position: { x: 420, y: 5 } });
  await page.keyboard.press('s');
  await expect(segments(page)).toHaveCount(n + 1);
  await expect(page.getByTestId('editor-version')).toContainText('enregistré');
  await page.reload();
  await expect(page.getByTestId('editor-page')).toBeVisible();
  await expect(segments(page)).toHaveCount(n + 1);
  await page.keyboard.press('Control+z');
  await expect(segments(page)).toHaveCount(n);
  await page.keyboard.press('Control+Shift+z');
  await expect(segments(page)).toHaveCount(n + 1);
});

test('fermeture brutale : le brouillon IndexedDB est restauré et envoyé, sans doublon', async ({
  context,
}) => {
  const page = await context.newPage();
  await open(page);
  const n = await segments(page).count();
  const v = await version(page);
  // Le serveur ne reçoit pas le lot (réseau coupé pour les envois d'édition).
  await page.route('**/api/clip-projects/*/edits', (route) =>
    route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
  );
  await page.getByTestId('ruler').click({ position: { x: 150, y: 5 } });
  await page.getByTestId('split').click();
  await expect(segments(page)).toHaveCount(n + 1);
  await expect(page.getByTestId('editor-version')).toContainText('hors ligne');
  const drafts = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('acs-editor', 1);
        req.onsuccess = () => {
          const t = req.result.transaction('drafts', 'readonly').objectStore('drafts').getAll();
          t.onsuccess = () => resolve((t.result as unknown[][]).flat().length);
        };
      }),
  );
  expect(drafts).toBe(1);
  await page.close({ runBeforeUnload: false });

  const again = await context.newPage();
  await open(again);
  await expect.poll(() => version(again)).toBe(v + 1);
  await expect(segments(again)).toHaveCount(n + 1);
  const journal = await again.request.get(
    `/api/clip-projects/${state().projectId}/edits?since=${v}`,
  );
  expect(((await journal.json()) as { entries: unknown[] }).entries).toHaveLength(1);
  await again.close();
});

test('conflit : geste construit sur une ancienne tête refusé sans perte ; recharger puis réappliquer', async ({
  context,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await open(a);
  await open(b);
  const n = await segments(a).count();
  // A est hors ligne : sa coupe reste dans sa file et son brouillon.
  await a.route('**/api/clip-projects/*/edits', (route) =>
    route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
  );
  await a.getByTestId('ruler').click({ position: { x: 90, y: 5 } });
  await a.getByTestId('split').click();
  await expect(a.getByTestId('editor-version')).toContainText('hors ligne');
  // B coupe le même segment plus loin : les deux gestes écrivent la structure.
  await b.getByTestId('ruler').click({ position: { x: 360, y: 5 } });
  await b.getByTestId('split').click();
  await expect(segments(b)).toHaveCount(n + 1);
  // A revient en ligne : le serveur refuse la réapplication automatique (§6.3).
  await a.unroute('**/api/clip-projects/*/edits');
  await expect(a.getByTestId('conflict')).toBeVisible({ timeout: 20_000 });
  await expect(a.getByTestId('conflict')).toContainText('coupe à');
  await a.getByRole('button', { name: 'Recharger (sans perte)' }).click();
  await expect(segments(a)).toHaveCount(n + 1);
  await a.getByRole('button', { name: 'Réappliquer' }).click();
  await expect(a.getByTestId('conflict')).toBeHidden();
  await expect(segments(a)).toHaveCount(n + 2);
  await expect(segments(b)).toHaveCount(n + 2);
  await a.close();
  await b.close();
});

test('rognage au pointeur : un glissement = UNE entrée d’historique', async ({ page }) => {
  await open(page);
  const v = await version(page);
  const first = segments(page).first();
  const id = (await first.getAttribute('data-testid'))!.replace('segment-', '');
  const before = (await first.boundingBox())!;
  const handle = page.getByTestId(`trim-end-${id}`);
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(h.x + h.width / 2 - i * 4, h.y + h.height / 2);
  await page.mouse.up();
  await expect.poll(() => version(page)).toBe(v + 1);
  await expect(page.getByTestId('editor-version')).toContainText('enregistré');
  expect((await first.boundingBox())!.width).toBeLessThan(before.width - 20);
  const journal = await page.request.get(
    `/api/clip-projects/${state().projectId}/edits?since=${v}`,
  );
  const entries = ((await journal.json()) as { entries: { ops: { type: string }[] }[] }).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]!.ops.map((o) => o.type)).toEqual(['trimSegment']);
});

test('disposition libre : poignées sur l’aperçu, un déplacement = une entrée', async ({ page }) => {
  await open(page);
  const v = await version(page);
  await page.getByTestId('layout-preset').selectOption('custom');
  await expect.poll(() => version(page)).toBe(v + 1);
  const layer = page.locator('[data-testid^="layer-"]').first();
  await expect(layer).toBeVisible();
  const b = (await layer.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++)
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + i * 10);
  await page.mouse.up();
  await expect.poll(() => version(page)).toBe(v + 2);
  expect((await layer.boundingBox())!.y).toBeGreaterThan(b.y + 30);
  // Annuler revient à la position d'avant (même réducteur, inverse exacte).
  await page.keyboard.press('Control+z');
  await expect.poll(async () => Math.round((await layer.boundingBox())!.y)).toBe(Math.round(b.y));
});

test('sous-titre ajouté : texte affiché pseudonymisé par le serveur, comme dans l’export', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('ruler').click({ position: { x: 60, y: 5 } });
  await page.getByTestId('manual-new').fill('GG Théo');
  await page.getByRole('button', { name: 'Ajouter à la tête de lecture' }).click();
  // Un sous-titre coupé par un raccord apparaît une fois par morceau.
  await expect(page.getByText('✎ GG [Coéquipier 1]').first()).toBeVisible();
  await expect(page.getByText('GG Théo', { exact: true })).toHaveCount(0);
});

test('zone masquée : désactivation après confirmation explicite, avertissement permanent', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('mask-list').getByRole('button', { name: 'Pseudo' }).click();
  await page.getByRole('button', { name: 'Désactiver…' }).click();
  await expect(page.getByTestId('masks-disabled')).toHaveCount(0);
  await page.getByRole('button', { name: 'Je confirme le risque' }).click();
  await expect(page.getByTestId('masks-disabled')).toBeVisible();
  // La zone sensible redevient visible dans l'aperçu (aucun flou ne la remplace).
  await expect
    .poll(
      async () => (await canvasPixels(page, ZONE)).filter((p) => p.every((v) => v > 220)).length,
    )
    .toBeGreaterThan(0);
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('masks-disabled')).toHaveCount(0);
});

test('proxy lu par une vraie balise <video> à travers Vite ; autre origine locale refusée', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  const project = state().projectId;
  const ok = await page.evaluate(async (project) => {
    const sessionId = crypto.randomUUID();
    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const media = (await (
      await post(`/api/clip-projects/${project}/editor-media`, { sessionId })
    ).json()) as {
      proxy: { id: string } | null;
    };
    const tok = await post(`/api/clip-projects/${project}/media-token`, {
      sessionId,
      derivativeId: media.proxy!.id,
    });
    const { token } = (await tok.json()) as { token: string };
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = `/api/editor-media/${media.proxy!.id}?token=${encodeURIComponent(token)}`;
    document.body.append(v);
    const loaded = await new Promise<boolean>((resolve) => {
      v.addEventListener('loadeddata', () => resolve(true));
      v.addEventListener('error', () => resolve(false));
      setTimeout(() => resolve(false), 15_000);
    });
    // Saut dans le proxy : nouvelles requêtes Range, toujours acceptées.
    v.currentTime = Math.min(10, v.duration / 2);
    const seeked = await new Promise<boolean>((resolve) => {
      v.addEventListener('seeked', () => resolve(true));
      setTimeout(() => resolve(false), 15_000);
    });
    return {
      tokenStatus: tok.status,
      loaded,
      seeked,
      width: v.videoWidth,
      proxy: media.proxy!.id,
      token,
      sessionId,
    };
  }, project);
  expect(ok).toMatchObject({ tokenStatus: 200, loaded: true, seeked: true });
  expect(ok.width).toBeGreaterThan(0);

  // Autre origine locale (autre nom d'hôte) : demande de jeton et lecture refusées.
  const other = await ctx.newPage();
  await other.goto(`${E2E.otherOrigin}/`);
  const refused = await other.evaluate(
    async ({ project, ok }) => {
      const tok = await fetch(`/api/clip-projects/${project}/media-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: ok.sessionId, derivativeId: ok.proxy }),
      });
      const v = document.createElement('video');
      v.src = `/api/editor-media/${ok.proxy}?token=${encodeURIComponent(ok.token)}`;
      document.body.append(v);
      const loaded = await new Promise<boolean>((resolve) => {
        v.addEventListener('loadeddata', () => resolve(true));
        v.addEventListener('error', () => resolve(false));
        setTimeout(() => resolve(false), 10_000);
      });
      return { tokenStatus: tok.status, loaded };
    },
    { project, ok },
  );
  expect(refused).toEqual({ tokenStatus: 403, loaded: false });
  await ctx.close();
});

/* ---------------- Révocation d'un accord audio (après les autres parcours) ---------------- */

const declareMic = (page: Page, otherVoices: 'present' | 'absent') =>
  page.request.post(`/api/recordings/${stateIds().recordingId}/export-audio`, {
    data: {
      requestId: crypto.randomUUID(),
      kind: 'declaration',
      subject: 'mic_composition',
      payload: { creatorVoice: 'present', otherVoices },
    },
  });

const stateIds = () =>
  JSON.parse(readFileSync(process.env.E2E_STATE ?? E2E.stateFile, 'utf8')) as {
    projectId: string;
    recordingId: string;
  };

test('révocation pendant que l’éditeur est ouvert : détectée sans modification du montage, piste plus jamais lue', async ({
  page,
}) => {
  await open(page);
  const v = await version(page);
  await expect(page.getByText('son : pistes autorisées')).toBeVisible();
  try {
    expect((await declareMic(page, 'present')).status()).toBe(200);
    await expect(page.getByTestId('notice')).toContainText('plus autorisée', { timeout: 10_000 });
    await expect(page.getByText('non autorisée à l’export : jamais lue')).toBeVisible();
    await expect(page.getByText('aperçu muet')).toBeVisible();
    // Le montage n'a pas changé : même version.
    expect(await version(page)).toBe(v);
    // Lecture : aucune piste jouée.
    await page.getByTestId('play-toggle').click();
    await expect(page.getByTestId('play-toggle')).toHaveText('Pause');
    await page.waitForTimeout(500);
    await expect(page.getByTestId('audio-playing')).toHaveText('');
    await page.getByTestId('play-toggle').click();
  } finally {
    expect((await declareMic(page, 'absent')).status()).toBe(200);
  }
  // Accord rétabli : la piste est de nouveau préparée et audible.
  await expect(page.getByText('son : pistes autorisées')).toBeVisible({ timeout: 15_000 });
});

test('révocation pendant une lecture en cours : la lecture s’arrête immédiatement', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText('son : pistes autorisées')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('audio-playing')).toContainText('pistes jouées : 0');
  const v = await version(page);
  try {
    expect((await declareMic(page, 'present')).status()).toBe(200);
    // Relecture de la décision toutes les 2 s : arrêt dès la détection.
    await expect(page.getByTestId('play-toggle')).toHaveText('Lecture', { timeout: 6_000 });
    await expect(page.getByTestId('audio-playing')).toHaveText('');
    await expect(page.getByTestId('notice')).toContainText('lecture arrêtée');
    expect(await version(page)).toBe(v);
    // Relancer : lecture muette, la piste révoquée n'est plus jouée.
    await page.getByTestId('play-toggle').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('audio-playing')).toHaveText('');
    await page.getByTestId('play-toggle').click();
  } finally {
    expect((await declareMic(page, 'absent')).status()).toBe(200);
  }
});
