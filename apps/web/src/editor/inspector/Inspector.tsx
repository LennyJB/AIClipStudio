/**
 * Inspecteurs de l'éditeur : réglages de l'élément sélectionné (segment, sous-titre, effet,
 * calque texte, masque, calque de cadrage, piste audio) et panneau du projet. Chaque
 * validation = un geste = un lot. Les règles de consentement restent au serveur : l'interface
 * affiche sa décision, elle ne la recalcule pas.
 *
 * Confidentialité (§3.4) : les zones masquées sont TOUJOURS opaques ; leur désactivation ou leur
 * suppression demande une confirmation explicite. Le flou est rangé dans « Effets », avec
 * l'avertissement « Le flou n'est pas une protection : utilisez une zone masquée. »
 */
import { useState } from 'react';
import {
  CAPTION_FONTS,
  EFFECT_CATALOG,
  EFFECT_TYPES_V2,
  editToSource,
  segmentsV2,
  type CaptionStyle,
  type ClipProjectV2,
  type EditMs,
  type EffectTypeV2,
  type Layer,
  type Mask,
} from '@acs/timeline';
import type { EditorDocument, EditorTexts } from '../api';
import { LibraryPanel } from '../../library/LibraryPanel';
import { libraryApi as defaultLibraryApi, type LibraryApi } from '../../library/api';
import type { LibraryState } from '../../library/useLibrary';
import {
  addEffect,
  addImageOverlay,
  addSfx,
  addManualCaption,
  addTextOverlay,
  addTimedMask,
  deleteSegment,
  layersFromPreset,
  setEffect,
  setLayers,
  setMask,
  shortId,
  trimGesture,
  type Gesture,
} from '../actions';
import type { Selection } from '../ui-store';

interface Props {
  doc: ClipProjectV2;
  server: EditorDocument;
  texts: EditorTexts | null;
  selection: Selection | null;
  playheadMs: number;
  editable: boolean;
  uuid: () => string;
  onGesture: (g: Gesture) => void;
  onSelect: (s: Selection | null) => void;
  /** Bibliothèque de médias (état des fichiers vu par le serveur). */
  library?: Pick<LibraryState, 'assets'> | undefined;
  libraryApi?: LibraryApi | undefined;
}

const ROLE_LABELS: Record<string, string> = { mic: 'Micro', discord: 'Discord', mix: 'Tout' };
const POSITIONS: Record<CaptionStyle['position'], string> = {
  bottom_safe: 'Bas (zone sûre)',
  middle: 'Milieu',
  top: 'Haut',
};

function Num(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onCommit: (v: number) => void;
  testId?: string;
}) {
  const [v, setV] = useState(String(props.value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? v : String(props.value);
  return (
    <label className="insp-field">
      {props.label}{' '}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={shown}
        disabled={props.disabled}
        data-testid={props.testId}
        onFocus={() => {
          setFocused(true);
          setV(String(props.value));
        }}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          setFocused(false);
          const n = Number(v);
          if (Number.isFinite(n) && n !== props.value)
            props.onCommit(Math.min(props.max, Math.max(props.min, n)));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

function TextCommit(props: {
  label: string;
  value: string;
  disabled: boolean;
  maxLength: number;
  onCommit: (v: string) => void;
  testId?: string;
}) {
  const [v, setV] = useState<string | null>(null);
  return (
    <label className="insp-field">
      {props.label}{' '}
      <input
        type="text"
        value={v ?? props.value}
        maxLength={props.maxLength}
        disabled={props.disabled}
        data-testid={props.testId}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v !== null && v.trim() && v !== props.value) props.onCommit(v.trim());
          setV(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function Inspector(p: Props) {
  const s = p.selection;
  return (
    <aside className="editor-inspector" aria-label="Réglages">
      {s?.kind === 'segment' && <SegmentPanel {...p} id={s.id} />}
      {s?.kind === 'caption' && <CaptionPanel {...p} id={s.id} />}
      {s?.kind === 'effect' && <EffectPanel {...p} id={s.id} />}
      {s?.kind === 'overlay' && <OverlayPanel {...p} id={s.id} />}
      {s?.kind === 'sfx' && <SfxPanel {...p} id={s.id} />}
      {s?.kind === 'mask' && <MaskPanel {...p} id={s.id} />}
      {s?.kind === 'layer' && <LayerPanel {...p} id={s.id} />}
      {s?.kind === 'track' && <TrackPanel {...p} audioIndex={s.audioIndex} />}
      <ProjectPanel {...p} />
    </aside>
  );
}

/* ------------------------------ Segment ------------------------------ */

function SegmentPanel(p: Props & { id: string }) {
  const i = p.doc.segments.findIndex((x) => x.id === p.id);
  const seg = p.doc.segments[i];
  if (!seg) return null;
  const override = p.doc.layout.overrides.find((o) => o.id === seg.id);
  const src = {
    width: p.server.recording.width ?? 1920,
    height: p.server.recording.height ?? 1080,
  };
  return (
    <section className="insp-section" aria-label="Segment">
      <h3>
        {seg.kind === 'gap'
          ? 'Vide'
          : seg.kind === 'freeze'
            ? 'Arrêt sur image'
            : `Segment ${i + 1}`}
      </h3>
      {seg.kind === 'source' ? (
        <>
          <Num
            label="Début source (ms)"
            value={seg.srcStartMs}
            min={p.doc.source.editWindow.srcStartMs}
            max={seg.srcEndMs - 100}
            step={10}
            disabled={!p.editable}
            onCommit={(v) => p.onGesture(trimGesture(p.doc, seg.id, { srcStartMs: v }))}
          />
          <Num
            label="Fin source (ms)"
            value={seg.srcEndMs}
            min={seg.srcStartMs + 100}
            max={p.doc.source.editWindow.srcEndMs}
            step={10}
            disabled={!p.editable}
            onCommit={(v) => p.onGesture(trimGesture(p.doc, seg.id, { srcEndMs: v }))}
          />
        </>
      ) : (
        <Num
          label="Durée (ms)"
          value={seg.editDurMs}
          min={100}
          max={60_000}
          step={10}
          disabled={!p.editable}
          testId="segment-duration"
          onCommit={(v) => p.onGesture(trimGesture(p.doc, seg.id, { editDurMs: v }))}
        />
      )}
      {seg.kind === 'freeze' && (
        <p className="small muted">
          Image figée, son coupé pendant l’arrêt (aucune boucle du son).
        </p>
      )}
      {seg.kind === 'gap' && <p className="small muted">Fond de la mise en page, silence.</p>}
      {seg.kind !== 'gap' && (
        <p>
          {override ? (
            <button
              type="button"
              disabled={!p.editable}
              onClick={() =>
                p.onGesture({
                  ops: [{ type: 'removeEntity', collection: 'layoutOverride', id: seg.id }],
                  summary: `cadrage du segment ${i + 1} : retour au cadrage du projet`,
                })
              }
            >
              Retirer le cadrage propre au segment
            </button>
          ) : (
            <button
              type="button"
              disabled={!p.editable}
              onClick={() =>
                p.onGesture(
                  setLayers(
                    p.doc,
                    layersFromPreset(p.doc, src),
                    seg.id,
                    `cadrage propre au segment ${i + 1}`,
                  ),
                )
              }
            >
              Cadrage propre à ce segment
            </button>
          )}
        </p>
      )}
      <p className="insp-actions">
        <button
          type="button"
          disabled={!p.editable}
          onClick={() => p.onGesture(deleteSegment(p.doc, seg.id, true, p.uuid))}
        >
          Supprimer (avec décalage)
        </button>
        <button
          type="button"
          disabled={!p.editable}
          onClick={() => p.onGesture(deleteSegment(p.doc, seg.id, false, p.uuid))}
        >
          Supprimer (sans décalage)
        </button>
      </p>
    </section>
  );
}

/* ------------------------------ Sous-titre ------------------------------ */

type StylePatch = { [K in keyof CaptionStyle]?: CaptionStyle[K] | undefined };

function StyleFields(props: {
  style: StylePatch | null;
  base: CaptionStyle;
  disabled: boolean;
  onChange: (s: Partial<CaptionStyle> | null) => void;
}) {
  const own = Object.fromEntries(
    Object.entries(props.style ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<CaptionStyle>;
  const st: CaptionStyle = { ...props.base, ...own };
  const set = (patch: Partial<CaptionStyle>) => props.onChange({ ...own, ...patch });
  return (
    <div className="insp-style">
      <label className="insp-field">
        Police{' '}
        <select
          value={st.font}
          disabled={props.disabled}
          onChange={(e) => set({ font: e.target.value as CaptionStyle['font'] })}
        >
          {CAPTION_FONTS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </label>
      <Num
        label="Taille"
        value={st.sizePx}
        min={40}
        max={120}
        step={2}
        disabled={props.disabled}
        onCommit={(v) => set({ sizePx: v })}
      />
      <label className="insp-field">
        Couleur{' '}
        <input
          type="color"
          value={st.color}
          disabled={props.disabled}
          onChange={(e) => set({ color: e.target.value.toUpperCase() })}
        />
      </label>
      <label className="insp-field">
        Position{' '}
        <select
          value={st.position}
          disabled={props.disabled}
          onChange={(e) => set({ position: e.target.value as CaptionStyle['position'] })}
        >
          {Object.entries(POSITIONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="insp-field">
        <input
          type="checkbox"
          checked={st.uppercase}
          disabled={props.disabled}
          onChange={(e) => set({ uppercase: e.target.checked })}
        />{' '}
        Majuscules
      </label>
      {props.style && (
        <button type="button" disabled={props.disabled} onClick={() => props.onChange(null)}>
          Style du projet
        </button>
      )}
    </div>
  );
}

function CaptionPanel(p: Props & { id: string }) {
  const item = p.doc.captions.items.find((x) => x.id === p.id);
  const manual = p.doc.captions.manual.find((x) => x.id === p.id);
  if (manual) {
    return (
      <section className="insp-section" aria-label="Sous-titre manuel">
        <h3>Sous-titre ajouté</h3>
        <TextCommit
          label="Texte"
          value={manual.text}
          maxLength={200}
          disabled={!p.editable}
          testId="manual-text"
          onCommit={(text) =>
            p.onGesture({
              ops: [{ type: 'setEntity', collection: 'manual', entity: { ...manual, text } }],
              summary: 'texte d’un sous-titre ajouté',
            })
          }
        />
        <p className="small muted">
          Affiché : « {p.texts?.manual[manual.id] ?? '…'} » (pseudonymisé comme la transcription).
        </p>
        <Num
          label="Durée (ms)"
          value={manual.srcEndMs - manual.srcStartMs}
          min={100}
          max={10_000}
          step={50}
          disabled={!p.editable}
          onCommit={(v) =>
            p.onGesture({
              ops: [
                {
                  type: 'setEntity',
                  collection: 'manual',
                  entity: { ...manual, srcEndMs: manual.srcStartMs + v },
                },
              ],
              summary: 'durée d’un sous-titre ajouté',
            })
          }
        />
        <StyleFields
          style={manual.style}
          base={p.doc.captions.style}
          disabled={!p.editable}
          onChange={(style) =>
            p.onGesture({
              ops: [{ type: 'setEntity', collection: 'manual', entity: { ...manual, style } }],
              summary: 'style d’un sous-titre ajouté',
            })
          }
        />
        <button
          type="button"
          disabled={!p.editable}
          onClick={() => {
            p.onGesture({
              ops: [{ type: 'removeEntity', collection: 'manual', id: manual.id }],
              summary: 'sous-titre ajouté retiré',
            });
            p.onSelect(null);
          }}
        >
          Retirer
        </button>
      </section>
    );
  }
  if (!item) return null;
  const correction = p.doc.captions.corrections.find((c) => c.itemId === item.id);
  const override = p.doc.captions.overrides.find((o) => o.id === item.id);
  const original = item.words.map((w) => w.text).join(' ');
  const index = [...p.doc.captions.items]
    .filter((x) => x.speakerRole === item.speakerRole)
    .sort((a, b) => a.srcStartMs - b.srcStartMs);
  const next = index[index.findIndex((x) => x.id === item.id) + 1];
  const shown = p.texts?.items.find((x) => x.itemId === item.id)?.text;
  return (
    <section className="insp-section" aria-label="Sous-titre">
      <h3>Sous-titre ({ROLE_LABELS[item.speakerRole] ?? item.speakerRole})</h3>
      <p className="small">
        Texte d’origine (transcription, intact) : <q>{original}</q>
      </p>
      <TextCommit
        label="Texte corrigé"
        value={correction?.correctedText ?? original}
        maxLength={200}
        disabled={!p.editable}
        testId="caption-text"
        onCommit={(text) =>
          p.onGesture({
            ops: [{ type: 'editCaptionText', itemId: item.id, text, at: new Date().toISOString() }],
            summary: 'correction d’un sous-titre',
          })
        }
      />
      {correction && (
        <button
          type="button"
          disabled={!p.editable}
          onClick={() =>
            p.onGesture({
              ops: [
                {
                  type: 'editCaptionText',
                  itemId: item.id,
                  text: null,
                  at: new Date().toISOString(),
                },
              ],
              summary: 'correction retirée',
            })
          }
        >
          Revenir au texte d’origine
        </button>
      )}
      <p className="small muted">Affiché : « {shown ?? '…'} »</p>
      <p className="insp-actions">
        <label className="insp-field">
          Couper avant le mot{' '}
          <select
            disabled={!p.editable || item.words.length < 2 || Boolean(correction || override)}
            value=""
            onChange={(e) =>
              e.target.value &&
              p.onGesture({
                ops: [
                  {
                    type: 'splitCaption',
                    itemId: item.id,
                    atWord: Number(e.target.value),
                    newId: shortId('st', p.uuid),
                  },
                ],
                summary: 'sous-titre découpé',
              })
            }
          >
            <option value="">—</option>
            {item.words.slice(1).map((w, k) => (
              <option key={k} value={k + 1}>
                {w.text}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!p.editable || !next || Boolean(correction || override)}
          onClick={() =>
            next &&
            p.onGesture({
              ops: [{ type: 'mergeCaptions', firstId: item.id, secondId: next.id }],
              summary: 'sous-titres fusionnés',
            })
          }
        >
          Fusionner avec le suivant
        </button>
      </p>
      {(correction || override) && (
        <p className="small muted">
          Découpe et fusion : annulez d’abord la correction et les réglages de cet item.
        </p>
      )}
      <StyleFields
        style={override?.style ?? null}
        base={p.doc.captions.style}
        disabled={!p.editable}
        onChange={(style) =>
          p.onGesture({
            ops: [
              {
                type: 'styleCaption',
                itemId: item.id,
                style,
                position: override?.position ?? null,
              },
            ],
            summary: 'style d’un sous-titre',
          })
        }
      />
      {override && (override.srcStartMs !== null || override.srcEndMs !== null) && (
        <button
          type="button"
          disabled={!p.editable}
          onClick={() =>
            p.onGesture({
              ops: [{ type: 'retimeCaption', itemId: item.id, srcStartMs: null, srcEndMs: null }],
              summary: 'horaires d’origine',
            })
          }
        >
          Horaires d’origine
        </button>
      )}
    </section>
  );
}

/* ------------------------------ Effet ------------------------------ */

function EffectPanel(p: Props & { id: string }) {
  const e = p.doc.effects.find((x) => x.id === p.id);
  if (!e) return null;
  const def = EFFECT_CATALOG[e.type];
  const paramSpecs: Record<string, { label: string; min: number; max: number; step: number }> = {
    factor: { label: 'Facteur', min: 1, max: e.type === 'zoom' ? 3 : 1.3, step: 0.01 },
    intensity: { label: 'Intensité', min: 0, max: 1, step: 0.05 },
    amplitude: { label: 'Amplitude', min: 0, max: 0.05, step: 0.001 },
    sigma: { label: 'Flou (σ)', min: 1, max: 60, step: 1 },
    gainDb: { label: 'Gain (dB)', min: -60, max: 12, step: 1 },
    frequencyHz: { label: 'Fréquence (Hz)', min: 200, max: 4000, step: 50 },
  };
  const motionOff = def.motion && p.doc.mode === 'fidele';
  return (
    <section className="insp-section" aria-label="Effet">
      <h3>{def.label}</h3>
      {def.hint && (
        <p className="warning small" role="note">
          {def.hint}
        </p>
      )}
      {motionOff && (
        <p className="small muted">
          Mode fidèle : effet de mouvement inactif (passez en mode enrichi).
        </p>
      )}
      <label className="insp-field">
        <input
          type="checkbox"
          checked={e.enabled}
          disabled={!p.editable}
          onChange={(ev) =>
            p.onGesture(
              setEffect(
                { ...e, enabled: ev.target.checked },
                `${def.label} ${ev.target.checked ? 'activé' : 'désactivé'}`,
              ),
            )
          }
        />{' '}
        Activé
      </label>
      {Object.keys(def.defaults).map((k) => {
        const spec = paramSpecs[k]!;
        return (
          <Num
            key={k}
            label={spec.label}
            value={e.params[k] ?? def.defaults[k]!}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            disabled={!p.editable}
            onCommit={(v) =>
              p.onGesture(
                setEffect({ ...e, params: { ...e.params, [k]: v } }, `réglage : ${def.label}`),
              )
            }
          />
        );
      })}
      {e.region && (
        <fieldset className="insp-rect">
          <legend>Zone (image source)</legend>
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <Num
              key={k}
              label={k}
              value={Number(e.region![k].toFixed(3))}
              min={0}
              max={1}
              step={0.01}
              disabled={!p.editable}
              onCommit={(v) =>
                p.onGesture(
                  setEffect({ ...e, region: { ...e.region!, [k]: v } }, `zone : ${def.label}`),
                )
              }
            />
          ))}
        </fieldset>
      )}
      {e.reason && <p className="small muted">{e.reason}</p>}
      <button
        type="button"
        disabled={!p.editable}
        onClick={() => {
          p.onGesture({
            ops: [{ type: 'removeEntity', collection: 'effect', id: e.id }],
            summary: `effet retiré : ${def.label}`,
          });
          p.onSelect(null);
        }}
      >
        Retirer l’effet
      </button>
    </section>
  );
}

/* ------------------------------ Calque texte ------------------------------ */

function OverlayPanel(p: Props & { id: string }) {
  const o = p.doc.overlays.find((x) => x.id === p.id);
  if (!o) return null;
  const set = (patch: Partial<typeof o>, summary: string) =>
    p.onGesture({
      ops: [{ type: 'setEntity', collection: 'overlay', entity: { ...o, ...patch } }],
      summary,
    });
  return (
    <section className="insp-section" aria-label="Calque">
      <h3>{o.kind === 'text' ? 'Calque texte' : o.kind === 'meme' ? 'Mème' : 'Calque image'}</h3>
      {o.assetId && <AssetLine {...p} assetId={o.assetId} />}
      {o.kind === 'text' && (
        <>
          <TextCommit
            label="Texte"
            value={o.text ?? ''}
            maxLength={120}
            disabled={!p.editable}
            testId="overlay-text"
            onCommit={(text) => set({ text }, 'texte d’un calque')}
          />
          <p className="small muted">
            Affiché : « {p.texts?.overlays[o.id] ?? '…'} » (pseudonymisé).
          </p>
        </>
      )}
      <Num
        label="Opacité"
        value={o.opacity}
        min={0}
        max={1}
        step={0.05}
        disabled={!p.editable}
        onCommit={(v) => set({ opacity: v }, 'opacité d’un calque')}
      />
      <Num
        label="Ordre"
        value={o.z}
        min={0}
        max={20}
        step={1}
        disabled={!p.editable}
        onCommit={(v) => set({ z: v }, 'ordre d’un calque')}
      />
      <fieldset className="insp-rect">
        <legend>Cadre (image 9:16)</legend>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <Num
            key={k}
            label={k}
            value={Number(o.frame[k].toFixed(3))}
            min={0}
            max={1}
            step={0.01}
            disabled={!p.editable}
            onCommit={(v) => set({ frame: { ...o.frame, [k]: v } }, 'cadre d’un calque')}
          />
        ))}
      </fieldset>
      <button
        type="button"
        disabled={!p.editable}
        onClick={() => {
          p.onGesture({
            ops: [{ type: 'removeEntity', collection: 'overlay', id: o.id }],
            summary: 'calque retiré',
          });
          p.onSelect(null);
        }}
      >
        Retirer le calque
      </button>
    </section>
  );
}

/* -------------------- Médias de la bibliothèque (7f) -------------------- */

/** Nom du média utilisé et état de son fichier (manquant : signalé, export refusé). */
function AssetLine(p: Props & { assetId: string }) {
  const a = p.library?.assets?.find((x) => x.id === p.assetId);
  if (!p.library?.assets) return <p className="small muted">Bibliothèque en cours de lecture…</p>;
  if (!a) {
    return (
      <p className="error small" data-testid="asset-missing">
        Média absent de la bibliothèque : retirez-le ou réimportez-le. L’export sera refusé.
      </p>
    );
  }
  return (
    <p className={a.status === 'ok' ? 'small' : 'error small'} data-testid="asset-line">
      Média : {a.displayName}
      {a.status === 'missing' && ' — fichier manquant : réimportez-le (export refusé)'}
    </p>
  );
}

function SfxPanel(p: Props & { id: string }) {
  const x = p.doc.audio.sfx.find((s) => s.id === p.id);
  if (!x) return null;
  const set = (patch: Partial<typeof x>, summary: string) =>
    p.onGesture({
      ops: [{ type: 'setEntity', collection: 'sfx', entity: { ...x, ...patch } }],
      summary,
    });
  const t = x.timing;
  return (
    <section className="insp-section" aria-label="Effet sonore">
      <h3>Effet sonore</h3>
      <AssetLine {...p} assetId={x.assetId} />
      {p.doc.audio.silent && (
        <p className="warning small">Export sans son : cet effet sonore ne sera pas entendu.</p>
      )}
      <Num
        label="Gain (dB)"
        value={x.gainDb}
        min={-60}
        max={12}
        step={1}
        disabled={!p.editable}
        testId="sfx-gain"
        onCommit={(v) => set({ gainDb: v }, 'gain d’un effet sonore')}
      />
      {t.anchor === 'edit' && (
        <Num
          label="Début (s)"
          value={t.offsetMs / 1000}
          min={0}
          max={600}
          step={0.1}
          disabled={!p.editable}
          onCommit={(v) =>
            set({ timing: { ...t, offsetMs: Math.round(v * 1000) } }, 'effet sonore déplacé')
          }
        />
      )}
      <button
        type="button"
        disabled={!p.editable}
        onClick={() => {
          p.onGesture({
            ops: [{ type: 'removeEntity', collection: 'sfx', id: x.id }],
            summary: 'effet sonore retiré',
          });
          p.onSelect(null);
        }}
      >
        Retirer l’effet sonore
      </button>
    </section>
  );
}

/* ------------------------------ Masque ------------------------------ */

function MaskPanel(p: Props & { id: string }) {
  const m = p.doc.masks.find((x) => x.id === p.id);
  const [confirming, setConfirming] = useState<null | 'off' | 'remove'>(null);
  if (!m) return null;
  const update = (patch: Partial<Mask>, summary: string) =>
    p.onGesture(setMask({ ...m, ...patch }, false, summary));
  return (
    <section className="insp-section" aria-label="Zone masquée">
      <h3>Zone masquée : {m.label || m.id}</h3>
      <p className="small">
        Aplat opaque posé sur l’image source avant tout recadrage, dans l’aperçu comme dans
        l’export.
        {m.srcRange ? ' Masque temporel (plage en temps source).' : ' Masque permanent.'}
      </p>
      <fieldset className="insp-rect">
        <legend>Zone (image source)</legend>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <Num
            key={k}
            label={k}
            value={Number(m.rect[k].toFixed(3))}
            min={0}
            max={1}
            step={0.01}
            disabled={!p.editable}
            onCommit={(v) => update({ rect: { ...m.rect, [k]: v } }, 'zone masquée ajustée')}
          />
        ))}
      </fieldset>
      {m.srcRange && (
        <>
          <Num
            label="Début (ms, source)"
            value={m.srcRange.srcStartMs}
            min={0}
            max={m.srcRange.srcEndMs - 1}
            step={10}
            disabled={!p.editable}
            onCommit={(v) =>
              update({ srcRange: { ...m.srcRange!, srcStartMs: v } }, 'plage d’une zone masquée')
            }
          />
          <Num
            label="Fin (ms, source)"
            value={m.srcRange.srcEndMs}
            min={m.srcRange.srcStartMs + 1}
            max={p.doc.source.editWindow.srcEndMs}
            step={10}
            disabled={!p.editable}
            onCommit={(v) =>
              update({ srcRange: { ...m.srcRange!, srcEndMs: v } }, 'plage d’une zone masquée')
            }
          />
        </>
      )}
      {m.mode === 'opaque' ? (
        <p className="insp-actions">
          <button type="button" disabled={!p.editable} onClick={() => setConfirming('off')}>
            Désactiver…
          </button>
          <button type="button" disabled={!p.editable} onClick={() => setConfirming('remove')}>
            Supprimer…
          </button>
        </p>
      ) : (
        <button
          type="button"
          disabled={!p.editable}
          onClick={() => update({ mode: 'opaque' }, 'zone masquée réactivée')}
        >
          Réactiver la zone masquée
        </button>
      )}
      {confirming && (
        <div role="alertdialog" aria-label="Confirmer le risque" className="warning">
          <p>
            {confirming === 'off' ? 'Désactiver' : 'Supprimer'} cette zone masquée peut exposer une
            information sensible (pseudo, notification, adresse). Le rendu affichera l’avertissement
            « masques désactivés ».
          </p>
          <button
            type="button"
            onClick={() => {
              p.onGesture(
                confirming === 'off'
                  ? setMask(
                      { ...m, mode: 'off' },
                      true,
                      'zone masquée désactivée (risque confirmé)',
                    )
                  : {
                      ops: [
                        {
                          type: 'removeEntity',
                          collection: 'mask',
                          id: m.id,
                          acknowledgeMaskRisk: true,
                        },
                      ],
                      summary: 'zone masquée supprimée (risque confirmé)',
                    },
              );
              setConfirming(null);
            }}
          >
            Je confirme le risque
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            Annuler
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ Calque de cadrage ------------------------------ */

export function editLayersTarget(doc: ClipProjectV2, playheadMs: number) {
  const p = editToSource(segmentsV2(doc.segments), playheadMs as EditMs);
  const seg = p && p.kind !== 'gap' ? p.segmentId : null;
  const override = seg ? doc.layout.overrides.find((o) => o.id === seg) : undefined;
  if (override) return { segmentId: seg, layers: override.layers };
  if (doc.layout.preset === 'custom') return { segmentId: null, layers: doc.layout.layers };
  return null;
}

function LayerPanel(p: Props & { id: string }) {
  const target = editLayersTarget(p.doc, p.playheadMs);
  const layer = target?.layers.find((l) => l.id === p.id);
  if (!target || !layer) return null;
  const set = (patch: Partial<Layer>, summary: string) =>
    p.onGesture(
      setLayers(
        p.doc,
        target.layers.map((l) => (l.id === layer.id ? { ...l, ...patch } : l)),
        target.segmentId,
        summary,
      ),
    );
  return (
    <section className="insp-section" aria-label="Calque de cadrage">
      <h3>
        Calque {layer.role === 'facecam' ? 'facecam' : 'jeu'}{' '}
        {target.segmentId ? '(segment)' : '(projet)'}
      </h3>
      <fieldset className="insp-rect">
        <legend>Recadrage (image source)</legend>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <Num
            key={k}
            label={k}
            value={Number(layer.crop[k].toFixed(3))}
            min={0}
            max={1}
            step={0.01}
            disabled={!p.editable}
            onCommit={(v) => set({ crop: { ...layer.crop, [k]: v } }, 'recadrage d’un calque')}
          />
        ))}
      </fieldset>
      <fieldset className="insp-rect">
        <legend>Cadre (image 9:16)</legend>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <Num
            key={k}
            label={k}
            value={Number(layer.frame[k].toFixed(3))}
            min={0}
            max={1}
            step={0.01}
            disabled={!p.editable}
            onCommit={(v) => set({ frame: { ...layer.frame, [k]: v } }, 'cadre d’un calque')}
          />
        ))}
      </fieldset>
      <Num
        label="Ordre"
        value={layer.z}
        min={0}
        max={20}
        step={1}
        disabled={!p.editable}
        onCommit={(v) => set({ z: v }, 'ordre d’un calque')}
      />
      <p className="small muted">
        Les poignées sur l’aperçu déplacent et redimensionnent le cadre.
      </p>
    </section>
  );
}

/* ------------------------------ Piste audio ------------------------------ */

function TrackPanel(p: Props & { audioIndex: number }) {
  const t = p.doc.audio.tracks.find((x) => x.audioIndex === p.audioIndex);
  if (!t) return null;
  const allowed = p.server.audio.selected.some((x) => x.audioIndex === t.audioIndex);
  const reason = p.server.audio.tracks.find((x) => x.audioIndex === t.audioIndex)?.reason;
  const src = editToSource(segmentsV2(p.doc.segments), p.playheadMs as EditMs);
  const srcMs = src?.kind === 'source' ? src.srcMs : null;
  const single = p.server.recording.audioTracks.length === 1;
  return (
    <section className="insp-section" aria-label="Piste audio">
      <h3>Piste {ROLE_LABELS[t.role] ?? t.role}</h3>
      {single && (
        <p className="small muted">
          Enregistrement à piste unique « Tout » : un seul gain global ; aucune séparation du jeu,
          de la voix ou de Discord n’est possible.
        </p>
      )}
      {!allowed && (
        <p className="warning small">Non autorisée à l’export : jamais lue ni exportée. {reason}</p>
      )}
      <label className="insp-field">
        <input
          type="checkbox"
          checked={t.enabled}
          disabled={!p.editable || (!allowed && !t.enabled)}
          onChange={(e) =>
            p.onGesture({
              ops: [{ type: 'setTrack', audioIndex: t.audioIndex, enabled: e.target.checked }],
              summary: `piste ${t.role} ${e.target.checked ? 'activée' : 'désactivée'}`,
            })
          }
        />{' '}
        Activée
      </label>
      <Num
        label="Gain (dB)"
        value={t.gainDb}
        min={-30}
        max={12}
        step={1}
        disabled={!p.editable}
        onCommit={(v) =>
          p.onGesture({
            ops: [{ type: 'setTrack', audioIndex: t.audioIndex, gainDb: v }],
            summary: `gain de la piste ${t.role}`,
          })
        }
      />
      <h4>Automatisation du gain</h4>
      <ul className="small">
        {t.automation.map((pt) => (
          <li key={pt.srcMs}>
            {(pt.srcMs / 1000).toFixed(2)} s (source) : {pt.gainDb} dB{' '}
            <button
              type="button"
              disabled={!p.editable}
              onClick={() =>
                p.onGesture({
                  ops: [
                    {
                      type: 'setTrack',
                      audioIndex: t.audioIndex,
                      automation: t.automation.filter((x) => x.srcMs !== pt.srcMs),
                    },
                  ],
                  summary: 'point d’automatisation retiré',
                })
              }
            >
              retirer
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!p.editable || srcMs === null || t.automation.some((x) => x.srcMs === srcMs)}
        onClick={() =>
          srcMs !== null &&
          p.onGesture({
            ops: [
              {
                type: 'setTrack',
                audioIndex: t.audioIndex,
                automation: [...t.automation, { srcMs, gainDb: -12 }].sort(
                  (a, b) => a.srcMs - b.srcMs,
                ),
              },
            ],
            summary: 'point d’automatisation ajouté',
          })
        }
      >
        Point à −12 dB à la tête de lecture
      </button>
    </section>
  );
}

/* ------------------------------ Projet ------------------------------ */

function ProjectPanel(p: Props) {
  const d = p.doc;
  const src = {
    width: p.server.recording.width ?? 1920,
    height: p.server.recording.height ?? 1080,
  };
  const [effectType, setEffectType] = useState<EffectTypeV2>('zoom');
  const [manualText, setManualText] = useState('');
  const [overlayText, setOverlayText] = useState('');
  const [asMeme, setAsMeme] = useState(false);
  const run = (f: () => Gesture) => {
    try {
      p.onGesture(f());
    } catch (err) {
      p.onGesture({ ops: [], summary: err instanceof Error ? err.message : String(err) });
    }
  };
  const visual = EFFECT_TYPES_V2.filter((t) => EFFECT_CATALOG[t].category === 'visual');
  const audio = EFFECT_TYPES_V2.filter((t) => EFFECT_CATALOG[t].category === 'audio');
  return (
    <section className="insp-section" aria-label="Projet">
      <h3>Projet</h3>
      <label className="insp-field">
        Mode{' '}
        <select
          value={d.mode}
          disabled={!p.editable}
          onChange={(e) =>
            p.onGesture({
              ops: [{ type: 'setMode', mode: e.target.value as 'fidele' | 'enrichi' }],
              summary: `mode ${e.target.value}`,
            })
          }
        >
          <option value="fidele">Fidèle</option>
          <option value="enrichi">Enrichi</option>
        </select>
      </label>

      <h4>Cadrage</h4>
      <label className="insp-field">
        Disposition{' '}
        <select
          value={d.layout.preset}
          disabled={!p.editable}
          data-testid="layout-preset"
          onChange={(e) => {
            const v = e.target.value as ClipProjectV2['layout']['preset'];
            p.onGesture(
              v === 'custom'
                ? setLayers(d, layersFromPreset(d, src), null, 'disposition libre')
                : { ops: [{ type: 'setLayout', preset: v }], summary: `disposition ${v}` },
            );
          }}
        >
          <option value="facecam_top" disabled={!d.layout.facecamRect}>
            Facecam en haut
          </option>
          <option value="gameplay_crop">Recadrage du jeu</option>
          <option value="blurred_fit">Fond flouté</option>
          <option value="custom">Libre (calques)</option>
        </select>
      </label>
      {d.layout.preset === 'custom' && (
        <ul className="small">
          {d.layout.layers.map((l) => (
            <li key={l.id}>
              <button type="button" onClick={() => p.onSelect({ kind: 'layer', id: l.id })}>
                Calque {l.role === 'facecam' ? 'facecam' : 'jeu'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="insp-field">
        Fond{' '}
        <input
          type="color"
          value={d.layout.background}
          disabled={!p.editable}
          onChange={(e) =>
            p.onGesture({
              ops: [{ type: 'setLayout', background: e.target.value.toUpperCase() }],
              summary: 'couleur du fond',
            })
          }
        />
      </label>

      <h4>Zones masquées</h4>
      <ul className="small" data-testid="mask-list">
        {d.masks.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => p.onSelect({ kind: 'mask', id: m.id })}>
              {m.label || m.id}
            </button>{' '}
            {m.srcRange ? 'temporel' : 'permanent'} —{' '}
            {m.mode === 'opaque' ? 'opaque' : <strong className="error">désactivé</strong>}
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!p.editable}
        onClick={() => run(() => addTimedMask(d, p.playheadMs, p.uuid))}
      >
        Ajouter une zone masquée temporelle
      </button>

      <h4>Sous-titres</h4>
      <label className="insp-field">
        <input
          type="checkbox"
          checked={d.captions.enabled}
          disabled={!p.editable}
          onChange={(e) =>
            p.onGesture({
              ops: [{ type: 'setCaptionsConfig', enabled: e.target.checked }],
              summary: e.target.checked ? 'sous-titres activés' : 'sous-titres désactivés',
            })
          }
        />{' '}
        Sous-titres
      </label>
      {(['mic', 'discord', 'mix'] as const).map((r) => {
        const ok = p.server.audio.captionRoles.includes(r);
        const on = d.captions.sources.includes(r);
        return (
          <label key={r} className="insp-field">
            <input
              type="checkbox"
              checked={on}
              disabled={!p.editable || (!ok && !on)}
              onChange={(e) =>
                p.onGesture({
                  ops: [
                    {
                      type: 'setCaptionsConfig',
                      sources: e.target.checked
                        ? [...d.captions.sources, r]
                        : d.captions.sources.filter((x) => x !== r),
                    },
                  ],
                  summary: `sous-titres ${ROLE_LABELS[r]}`,
                })
              }
            />{' '}
            {ROLE_LABELS[r]} {!ok && <span className="small muted">(non autorisé)</span>}
          </label>
        );
      })}
      <StyleFields
        style={null}
        base={d.captions.style}
        disabled={!p.editable}
        onChange={(style) =>
          style &&
          p.onGesture({
            ops: [{ type: 'setCaptionsConfig', style }],
            summary: 'style des sous-titres',
          })
        }
      />
      <p className="insp-actions">
        <input
          type="text"
          placeholder="Sous-titre à ajouter"
          value={manualText}
          maxLength={200}
          disabled={!p.editable}
          onChange={(e) => setManualText(e.target.value)}
          data-testid="manual-new"
        />
        <button
          type="button"
          disabled={!p.editable || !manualText.trim()}
          onClick={() => {
            run(() => addManualCaption(d, p.playheadMs, manualText.trim(), p.uuid));
            setManualText('');
          }}
        >
          Ajouter à la tête de lecture
        </button>
      </p>

      <h4>Effets</h4>
      <p className="insp-actions">
        <select
          value={effectType}
          disabled={!p.editable}
          onChange={(e) => setEffectType(e.target.value as EffectTypeV2)}
          data-testid="effect-type"
        >
          <optgroup label="Visuels">
            {visual.map((t) => (
              <option key={t} value={t}>
                {EFFECT_CATALOG[t].label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Son">
            {audio.map((t) => (
              <option key={t} value={t}>
                {EFFECT_CATALOG[t].label}
              </option>
            ))}
          </optgroup>
        </select>
        <button
          type="button"
          disabled={!p.editable}
          onClick={() => run(() => addEffect(d, effectType, p.playheadMs, p.uuid))}
        >
          Ajouter l’effet
        </button>
      </p>
      {EFFECT_CATALOG[effectType].hint && (
        <p className="warning small">{EFFECT_CATALOG[effectType].hint}</p>
      )}

      <h4>Calques</h4>
      <p className="insp-actions">
        <input
          type="text"
          placeholder="Texte du calque"
          value={overlayText}
          maxLength={120}
          disabled={!p.editable}
          onChange={(e) => setOverlayText(e.target.value)}
        />
        <button
          type="button"
          disabled={!p.editable || !overlayText.trim()}
          onClick={() => {
            run(() => addTextOverlay(d, p.playheadMs, overlayText.trim(), p.uuid));
            setOverlayText('');
          }}
        >
          Ajouter un calque texte
        </button>
      </p>
      <details className="insp-library" data-testid="pick-image">
        <summary>Image ou mème de la bibliothèque…</summary>
        <label className="insp-field">
          <input type="checkbox" checked={asMeme} onChange={(e) => setAsMeme(e.target.checked)} />{' '}
          Ajouter comme mème
        </label>
        <LibraryPanel
          api={p.libraryApi ?? defaultLibraryApi}
          kind="image"
          title="Images"
          onPick={(a) =>
            p.editable &&
            run(() => addImageOverlay(d, p.playheadMs, a, asMeme ? 'meme' : 'image', p.uuid))
          }
        />
      </details>

      <h4>Effets sonores</h4>
      <details className="insp-library" data-testid="pick-sound">
        <summary>Son de la bibliothèque…</summary>
        <LibraryPanel
          api={p.libraryApi ?? defaultLibraryApi}
          kind="audio"
          title="Sons"
          onPick={(a) => p.editable && run(() => addSfx(d, p.playheadMs, a, p.uuid))}
        />
      </details>
      {d.audio.sfx.length > 0 && (
        <ul className="small">
          {d.audio.sfx.map((x) => (
            <li key={x.id}>
              <button type="button" onClick={() => p.onSelect({ kind: 'sfx', id: x.id })}>
                {p.library?.assets?.find((a) => a.id === x.assetId)?.displayName ?? 'Son'} (
                {x.gainDb} dB)
              </button>
            </li>
          ))}
        </ul>
      )}

      <h4>Son</h4>
      <label className="insp-field">
        <input
          type="checkbox"
          checked={d.audio.silent}
          disabled={!p.editable}
          onChange={(e) =>
            p.onGesture({
              ops: [{ type: 'setAudioConfig', silent: e.target.checked }],
              summary: e.target.checked ? 'export sans son' : 'export avec son',
            })
          }
        />{' '}
        Export sans son
      </label>
      <label className="insp-field">
        <input
          type="checkbox"
          checked={d.audio.loudnorm.enabled}
          disabled={!p.editable}
          onChange={(e) =>
            p.onGesture({
              ops: [{ type: 'setAudioConfig', loudnorm: e.target.checked }],
              summary: 'normalisation du volume',
            })
          }
        />{' '}
        Normalisation (−14 LUFS, export seulement)
      </label>
      <ul className="small">
        {d.audio.tracks.map((t) => (
          <li key={t.audioIndex}>
            <button
              type="button"
              onClick={() => p.onSelect({ kind: 'track', audioIndex: t.audioIndex })}
            >
              Piste {ROLE_LABELS[t.role] ?? t.role}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
