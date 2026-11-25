import { useEffect, useRef, useState } from 'react';
import type { LayoutPreset, ProjectView } from '../../api';
import type { ClipProjectState } from './useClipProject';
import { useFrame } from './useFrame';
import { LAYOUT_LABELS } from './messages';

export const SLIDER_DEBOUNCE_MS = 400;

/** Curseur : valeur locale fluide, envoi après un délai d'inactivité (pas à chaque mouvement). */
function Slider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  format,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  format: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <label className="slider">
      {label} : {format(local)}{' '}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onCommit(v), SLIDER_DEBOUNCE_MS);
        }}
      />
    </label>
  );
}

export function LayoutSection({ view, p }: { view: ProjectView; p: ClipProjectState }) {
  const l = view.document.layout;
  const disabled = !view.editable;
  // Image actualisée seulement quand le CADRAGE confirmé par le serveur change.
  const trigger = view.editable
    ? JSON.stringify([l.preset, l.focusX, l.facecamShare, l.masks.map((m) => m.mode)])
    : null;
  const frame = useFrame(view.project.id, trigger);
  return (
    <fieldset aria-label="Cadrage">
      <legend>Cadrage</legend>
      <label>
        Disposition{' '}
        <select
          value={l.preset}
          disabled={disabled}
          onChange={(e) =>
            p.update('layout.preset', 'Disposition', {
              layout: { preset: e.target.value as LayoutPreset },
            })
          }
        >
          {Object.entries(LAYOUT_LABELS).map(([k, v]) => (
            <option key={k} value={k} disabled={k === 'facecam_top' && !l.facecamRect}>
              {v}
              {k === 'facecam_top' && !l.facecamRect ? ' (aucune facecam définie)' : ''}
            </option>
          ))}
        </select>
      </label>
      {l.preset !== 'blurred_fit' && (
        <Slider
          key={`focus-${l.focusX}`}
          label="Position horizontale du recadrage"
          value={l.focusX}
          min={0}
          max={1}
          step={0.01}
          disabled={disabled}
          format={(v) => `${Math.round(v * 100)} %`}
          onCommit={(v) => p.update('layout.focusX', 'Recadrage', { layout: { focusX: v } })}
        />
      )}
      {l.preset === 'facecam_top' && (
        <Slider
          key={`share-${l.facecamShare}`}
          label="Part de la facecam"
          value={l.facecamShare}
          min={0.25}
          max={0.45}
          step={0.01}
          disabled={disabled}
          format={(v) => `${Math.round(v * 100)} %`}
          onCommit={(v) =>
            p.update('layout.facecamShare', 'Part de la facecam', { layout: { facecamShare: v } })
          }
        />
      )}
      {view.editable && (
        <div className="frame">
          <button type="button" onClick={frame.refresh}>
            Actualiser l’image
          </button>{' '}
          {frame.loading && <span className="muted small">Génération de l’image…</span>}
          {frame.error && <span className="error small">{frame.error}</span>}
          {frame.url && (
            <div>
              <img src={frame.url} alt="Image fixe du cadrage (masques appliqués)" />
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
