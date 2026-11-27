/**
 * Bibliothèque de médias de bout en bout (étape 7, PR 7f) : API RÉELLE (FFmpeg, faux modèle :
 * aucun appel à Claude), interface servie par Vite, Chromium.
 *
 *  - import depuis l'accueil (droits déclarés), fichier piégé refusé avec sa raison ;
 *  - mème ajouté dans l'éditeur depuis la bibliothèque : PARITÉ aperçu canvas / image exacte
 *    FFmpeg (rectangle de l'image ≤ 2 px d'écart, couleur identique), partie transparente sans
 *    effet sur l'image sous-jacente ;
 *  - effet sonore ajouté : décodé par l'aperçu (pistes autorisées) et visible sur la timeline ;
 *  - suppression d'un média utilisé : refusée, message du serveur affiché.
 * Le projet est remis dans son état (calque et son retirés) pour les parcours suivants.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { halfTransparentPng, textFile, tone } from '../helpers/asset-fixtures';
import { E2E } from './constants';

test.describe.configure({ mode: 'serial' });

const state = () =>
  JSON.parse(readFileSync(process.env.E2E_STATE ?? E2E.stateFile, 'utf8')) as {
    projectId: string;
  };

const dir = mkdtempSync(path.join(tmpdir(), 'acs-e2e-biblio-'));

async function importFile(page: Page, file: string, rights = 'own') {
  await page.getByTestId('library-file').first().setInputFiles(file);
  await page.getByTestId('library-rights').first().selectOption(rights);
  await page.getByTestId('library-import').first().click();
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Boîte englobante des pixels MAGENTA d'une image : du canvas de l'aperçu (`exact` = false) ou de
 * l'image exacte FFmpeg affichée à côté (`exact` = true). Calculée dans la page.
 */
const magentaBox = (page: Page, exact: boolean) =>
  page.evaluate(async (exact) => {
    let c: HTMLCanvasElement;
    if (exact) {
      const img = document.querySelector<HTMLImageElement>('figure.editor-exact img')!;
      await img.decode();
      c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
    } else {
      c = document.querySelector<HTMLCanvasElement>('[data-testid=editor-canvas]')!;
    }
    const { width: w, height: h } = c;
    const data = c.getContext('2d')!.getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i]! > 180 && data[i + 1]! < 90 && data[i + 2]! > 180) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    return { box: x1 < 0 ? null : { x0, y0, x1, y1 }, width: w, height: h };
  }, exact) as Promise<{ box: Box | null; width: number; height: number }>;

test('accueil : import avec droits déclarés ; fichier piégé refusé avec sa raison', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('Bibliothèque de médias')).toBeVisible();
  // Sans déclaration de droits : impossible d'importer.
  await page
    .getByTestId('library-file')
    .setInputFiles(
      textFile(
        dir,
        'piege.svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    );
  await expect(page.getByTestId('library-import')).toBeDisabled();
  await page.getByTestId('library-rights').selectOption('own');
  await page.getByTestId('library-import').click();
  await expect(page.getByTestId('library-message')).toContainText('Import refusé');
  await expect(page.getByTestId('library-item')).toHaveCount(0);

  await importFile(page, halfTransparentPng(dir, 'meme.png', '0xFF00FF', 200, 100));
  await expect(page.getByTestId('library-message')).toContainText('importé');
  await importFile(page, tone(dir, 'boing.wav', 1500, 0.6), 'licensed');
  await expect(page.getByTestId('library-item')).toHaveCount(2);
  await expect(page.getByTestId('library-item').filter({ hasText: 'meme.png' })).toContainText(
    '200×100',
  );
  // Même fichier : aucune copie.
  await importFile(page, path.join(dir, 'meme.png'));
  await expect(page.getByTestId('library-message')).toContainText('déjà dans la bibliothèque');
  await expect(page.getByTestId('library-item')).toHaveCount(2);
});

test('éditeur : mème de la bibliothèque — parité aperçu canvas / image exacte FFmpeg (≤ 2 px)', async ({
  page,
}) => {
  await page.goto(`/#/editeur/${state().projectId}`);
  await expect(page.getByTestId('editor-version')).toContainText('enregistré');
  await page.getByTestId('pick-image').locator('summary').click();
  await page.getByTestId('pick-image').getByLabel('Ajouter comme mème').check();
  await page.getByTestId('pick-image').getByTestId('library-pick').first().click();
  await expect(page.locator('.tl-overlay').filter({ hasText: 'Mème meme.png' })).toBeVisible();
  await expect(page.getByTestId('editor-version')).toContainText('enregistré');

  await expect.poll(async () => (await magentaBox(page, false)).box).not.toBeNull();
  const preview = (await magentaBox(page, false)).box!;
  await page.getByRole('button', { name: 'Image exacte' }).click();
  await expect(page.locator('figure.editor-exact img')).toBeVisible();
  const exact = await magentaBox(page, true);
  expect([exact.width, exact.height]).toEqual([540, 960]);
  expect(exact.box).not.toBeNull();
  // Écart de géométrie ≤ 2 px sur chaque bord (même cadre arrondi, même étirement).
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) {
    expect(
      Math.abs(preview[k] - exact.box![k]),
      `${k} : ${preview[k]} / ${exact.box![k]}`,
    ).toBeLessThanOrEqual(2);
  }
  // Moitié transparente : aucun magenta au-delà de la moitié gauche du cadre (216 px de large).
  expect(preview.x1 - preview.x0).toBeLessThanOrEqual(110);
});

test('éditeur : effet sonore ajouté, décodé par l’aperçu (pistes autorisées), visible sur la timeline', async ({
  page,
}) => {
  await page.goto(`/#/editeur/${state().projectId}`);
  await expect(page.getByTestId('editor-version')).toContainText('enregistré');
  await page.getByTestId('pick-sound').locator('summary').click();
  await page.getByTestId('pick-sound').getByTestId('library-pick').first().click();
  await expect(page.getByTestId('tl-sfx')).toHaveCount(1);
  await expect(page.getByTestId('tl-sfx')).toContainText('boing.wav');
  await expect(page.getByTestId('sfx-loaded')).toHaveText('1');
});

test('éditeur : échec de chargement d’un effet sonore (réponse HTTP en erreur, puis décodage impossible) affiché, jamais compté comme chargé', async ({
  browser,
}) => {
  for (const [label, fulfill, expected] of [
    ['réponse 500', { status: 500, body: 'erreur' }, 'réponse du serveur 500'],
    [
      'octets illisibles',
      { status: 200, contentType: 'audio/wav', body: Buffer.from('ceci n’est pas un son') },
      'son illisible',
    ],
  ] as const) {
    // Contexte neuf : aucun son déjà en cache du navigateur.
    const ctx = await browser.newContext({ baseURL: E2E.origin });
    const page = await ctx.newPage();
    const doc = (await (
      await page.request.get(`/api/clip-projects/${state().projectId}/document`)
    ).json()) as { document: { audio: { sfx: { assetId: string }[] } } };
    const soundId = doc.document.audio.sfx[0]!.assetId;
    await page.route(`**/api/media-assets/${soundId}/file`, (r) => r.fulfill(fulfill));
    await page.goto(`/#/editeur/${state().projectId}`);
    await expect(page.getByTestId('editor-version')).toContainText('enregistré');
    await expect(page.getByTestId('sfx-error'), label).toContainText(expected);
    await expect(page.getByTestId('sfx-error')).toContainText('boing.wav');
    await expect(page.getByTestId('sfx-loaded')).toHaveText('0');
    await ctx.close();
  }
});

test('accueil : suppression d’un média utilisé refusée (message du serveur) ; projet remis en état', async ({
  page,
}) => {
  await page.goto('/');
  page.once('dialog', (d) => void d.accept());
  await page
    .getByTestId('library-item')
    .filter({ hasText: 'meme.png' })
    .getByTestId('library-delete')
    .click();
  await expect(page.getByTestId('library-message')).toContainText('utilisé par 1 projet');
  await expect(page.getByTestId('library-item')).toHaveCount(2);

  // Remise en état : calque et effet sonore retirés (les parcours suivants partent d'un clip nu).
  const doc = (await (
    await page.request.get(`/api/clip-projects/${state().projectId}/document`)
  ).json()) as {
    version: number;
    document: { overlays: { id: string }[]; audio: { sfx: { id: string }[] } };
  };
  const res = await page.request.post(`/api/clip-projects/${state().projectId}/edits`, {
    data: {
      requestId: crypto.randomUUID(),
      clientId: 'cli-e2e',
      base: { version: doc.version },
      kind: 'do',
      ops: [
        ...doc.document.overlays.map((o) => ({
          type: 'removeEntity',
          collection: 'overlay',
          id: o.id,
        })),
        ...doc.document.audio.sfx.map((s) => ({
          type: 'removeEntity',
          collection: 'sfx',
          id: s.id,
        })),
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
});
