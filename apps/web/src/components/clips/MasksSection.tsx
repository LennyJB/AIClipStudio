/**
 * Zones sensibles : masquées par défaut (opaques). Les désactiver exige une confirmation
 * explicite (« Je comprends le risque »), puis un avertissement reste affiché en permanence.
 */
import { useState } from 'react';
import type { ProjectView } from '../../api';
import type { ClipProjectState } from './useClipProject';

export function MasksSection({ view, p }: { view: ProjectView; p: ClipProjectState }) {
  const masks = view.document.layout.masks;
  const disabled = !view.editable;
  const [ack, setAck] = useState(false);
  if (!masks.length) {
    return (
      <fieldset aria-label="Zones masquées">
        <legend>Zones masquées</legend>
        <p className="muted small">Aucune zone sensible définie dans le profil de cadrage.</p>
      </fieldset>
    );
  }
  const send = (index: number, mode: 'opaque' | 'off') => {
    const modes = masks.map((m, i) => ({ index: i, mode: i === index ? mode : m.mode }));
    const anyOff = modes.some((m) => m.mode === 'off');
    p.update(`masks.${index}`, 'Zones masquées', {
      masks: { modes, ...(anyOff ? { acknowledgeMaskRisk: true } : {}) },
    });
  };
  return (
    <fieldset aria-label="Zones masquées">
      <legend>Zones masquées</legend>
      {masks.some((m) => m.mode === 'off') && (
        <p className="warn" role="alert">
          ⚠ Au moins une zone sensible n’est plus masquée : des informations privées peuvent
          apparaître dans l’export.
        </p>
      )}
      <ul>
        {masks.map((m, i) => (
          <li key={i}>
            {m.label || `Zone ${i + 1}`} : {m.mode === 'opaque' ? 'masquée' : 'NON masquée'}{' '}
            {m.mode === 'opaque' ? (
              <button type="button" disabled={disabled || !ack} onClick={() => send(i, 'off')}>
                Ne plus masquer
              </button>
            ) : (
              <button type="button" disabled={disabled} onClick={() => send(i, 'opaque')}>
                Masquer de nouveau
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <label className="small">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Je
          comprends le risque : une zone non masquée peut montrer des informations privées.
        </label>
      )}
    </fieldset>
  );
}
