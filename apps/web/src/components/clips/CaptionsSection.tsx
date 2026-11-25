/**
 * Sous-titres : sources autorisées par le SERVEUR (Discord grisé tant qu'il n'est pas autorisé),
 * style limité aux champs du schéma, corrections avec texte d'origine toujours consultable.
 * Tout texte est affiché par React (jamais interprété comme du HTML).
 */
import { useState } from 'react';
import type { CaptionRole, CaptionStyle, DisplayCaption, ProjectView } from '../../api';
import type { ClipProjectState } from './useClipProject';

const SOURCE_LABELS: Record<CaptionRole, string> = {
  mic: 'Micro',
  discord: 'Discord',
  mix: 'Tout / Mix',
};

function Correction({
  c,
  disabled,
  onSave,
}: {
  c: DisplayCaption;
  disabled: boolean;
  onSave: (text: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.text);
  return (
    <li data-testid={`caption-${c.itemId}`}>
      <span className="badge">{SOURCE_LABELS[c.speakerRole]}</span> {c.text}{' '}
      {c.corrected && <span className="badge">corrigé</span>}{' '}
      {c.replacements > 0 && <span className="badge">noms remplacés</span>}{' '}
      {c.editRanges.length === 0 && <span className="muted small">(hors du clip)</span>}
      {(c.corrected || c.replacements > 0) && (
        <details className="small">
          <summary>Texte d’origine</summary>
          {c.originalText}
        </details>
      )}
      {!disabled && !editing && (
        <>
          <button
            type="button"
            className="link"
            onClick={() => {
              setText(c.text);
              setEditing(true);
            }}
          >
            Corriger
          </button>
          {c.corrected && (
            <button type="button" className="link" onClick={() => onSave(null)}>
              Annuler la correction
            </button>
          )}
        </>
      )}
      {editing && (
        <span>
          <input
            aria-label="Texte corrigé"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => {
              onSave(text);
              setEditing(false);
            }}
          >
            Enregistrer
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Fermer
          </button>
        </span>
      )}
    </li>
  );
}

export function CaptionsSection({ view, p }: { view: ProjectView; p: ClipProjectState }) {
  const c = view.document.captions;
  const s = c.style;
  const disabled = !view.editable;
  const allowed = new Set(view.audio.captionRoles);
  const style = (patch: Partial<CaptionStyle>, key: string) =>
    p.update(`captions.style.${key}`, 'Style des sous-titres', { captions: { style: patch } });
  const toggleSource = (r: CaptionRole, on: boolean) => {
    const sources = on ? [...c.sources, r] : c.sources.filter((x) => x !== r);
    p.update('captions.sources', 'Sources des sous-titres', { captions: { sources } });
  };
  return (
    <fieldset aria-label="Sous-titres">
      <legend>Sous-titres</legend>
      <label>
        <input
          type="checkbox"
          checked={c.enabled}
          disabled={disabled}
          onChange={(e) =>
            p.update('captions.enabled', 'Sous-titres', { captions: { enabled: e.target.checked } })
          }
        />{' '}
        Afficher les sous-titres
      </label>
      <div>
        Sources :{' '}
        {(['mic', 'discord', 'mix'] as const).map((r) => {
          const ok = allowed.has(r);
          return (
            <label key={r} className="filter" title={ok ? undefined : 'Non autorisé à l’export'}>
              <input
                type="checkbox"
                checked={c.sources.includes(r)}
                disabled={disabled || (!ok && !c.sources.includes(r))}
                onChange={(e) => toggleSource(r, e.target.checked)}
              />{' '}
              {SOURCE_LABELS[r]}
              {!ok && (
                <span className="small muted">
                  {' '}
                  (non autorisé : accord ou déclaration manquant dans « Audio exporté »)
                </span>
              )}
            </label>
          );
        })}
      </div>
      <details>
        <summary>Style</summary>
        <div className="style-grid">
          <label>
            Police{' '}
            <select
              value={s.font}
              disabled={disabled}
              onChange={(e) => style({ font: e.target.value as CaptionStyle['font'] }, 'font')}
            >
              <option value="Montserrat ExtraBold">Montserrat ExtraBold</option>
              <option value="Inter">Inter</option>
            </select>
          </label>
          <label>
            Taille (px){' '}
            <input
              type="number"
              min={40}
              max={120}
              value={s.sizePx}
              disabled={disabled}
              onChange={(e) => style({ sizePx: Number(e.target.value) }, 'sizePx')}
            />
          </label>
          {(
            [
              ['color', 'Couleur'],
              ['highlightColor', 'Mot en cours'],
              ['outlineColor', 'Contour'],
            ] as const
          ).map(([k, lbl]) => (
            <label key={k}>
              {lbl}{' '}
              <input
                type="color"
                value={s[k].toLowerCase()}
                disabled={disabled}
                onChange={(e) => style({ [k]: e.target.value.toUpperCase() }, k)}
              />
            </label>
          ))}
          <label>
            Épaisseur du contour{' '}
            <input
              type="number"
              min={0}
              max={12}
              value={s.outlinePx}
              disabled={disabled}
              onChange={(e) => style({ outlinePx: Number(e.target.value) }, 'outlinePx')}
            />
          </label>
          <label>
            Position{' '}
            <select
              value={s.position}
              disabled={disabled}
              onChange={(e) =>
                style({ position: e.target.value as CaptionStyle['position'] }, 'position')
              }
            >
              <option value="top">En haut</option>
              <option value="middle">Au milieu</option>
              <option value="bottom_safe">En bas (zone sûre)</option>
            </select>
          </label>
          <label>
            Caractères par ligne{' '}
            <input
              type="number"
              min={16}
              max={42}
              value={s.maxCharsPerLine}
              disabled={disabled}
              onChange={(e) =>
                style({ maxCharsPerLine: Number(e.target.value) }, 'maxCharsPerLine')
              }
            />
          </label>
          <label>
            Lignes{' '}
            <select
              value={s.maxLines}
              disabled={disabled}
              onChange={(e) => style({ maxLines: Number(e.target.value) as 1 | 2 }, 'maxLines')}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          {(
            [
              ['shadow', 'Ombre'],
              ['uppercase', 'Majuscules'],
              ['karaoke', 'Mot en cours surligné'],
              ['emphasizePunchline', 'Chute mise en valeur'],
            ] as const
          ).map(([k, lbl]) => (
            <label key={k}>
              <input
                type="checkbox"
                checked={s[k]}
                disabled={disabled}
                onChange={(e) => style({ [k]: e.target.checked }, k)}
              />{' '}
              {lbl}
            </label>
          ))}
        </div>
      </details>
      <h4>Texte des sous-titres</h4>
      {view.captionsError && <p className="error small">{view.captionsError}</p>}
      {view.captions && view.captions.length > 0 ? (
        <ul className="captions">
          {view.captions.map((x) => (
            <Correction
              key={`${x.itemId}-${x.text}`}
              c={x}
              disabled={disabled}
              onSave={(text) =>
                p.update(`corrections.${x.itemId}`, 'Correction', {
                  corrections: [{ itemId: x.itemId, text }],
                })
              }
            />
          ))}
        </ul>
      ) : (
        <p className="muted small">Aucune ligne de sous-titre à afficher.</p>
      )}
    </fieldset>
  );
}
