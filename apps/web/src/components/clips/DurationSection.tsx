/**
 * Durée et bornes : ajustement à ±10 s de la proposition (temps SOURCE, recalé sur les mots par
 * le serveur), alertes du serveur, confirmation explicite d'une durée hors plage.
 */
import { useState } from 'react';
import type { ProjectView } from '../../api';
import { formatSourceMs } from '../../format';
import type { ClipProjectState } from './useClipProject';

export const MAX_SHIFT_MS = 10_000;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Remonté à chaque changement de bornes confirmé par le serveur (champs réinitialisés). */
export function DurationSection({ view, p }: { view: ProjectView; p: ClipProjectState }) {
  const seg = view.document.segments[0]!;
  return <DurationFields key={`${seg.srcStartMs}-${seg.srcEndMs}`} view={view} p={p} />;
}

function DurationFields({ view, p }: { view: ProjectView; p: ClipProjectState }) {
  const d = view.document;
  const disabled = !view.editable;
  const seg = d.segments[0]!;
  const prop = d.origin.proposalBounds;
  const [startOff, setStartOff] = useState((seg.srcStartMs - prop.srcStartMs) / 1000);
  const [endOff, setEndOff] = useState((seg.srcEndMs - prop.srcEndMs) / 1000);
  const valid = (v: number) => Number.isFinite(v) && Math.abs(v * 1000) <= MAX_SHIFT_MS;
  const boundsWarnings = view.warnings.filter((w) =>
    ['CONTEXT_MAY_BE_CUT', 'REACTION_MAY_BE_CUT', 'WORD_CUT', 'DURATION_OUT_OF_RANGE'].includes(
      w.code,
    ),
  );
  return (
    <fieldset aria-label="Durée">
      <legend>Durée</legend>
      <p>
        Durée actuelle : <strong>{sec(view.durationMs)}</strong> · plage du profil :{' '}
        {sec(d.durationPolicy.minMs)} – {sec(d.durationPolicy.maxMs)} · bornes absolues 5–180 s
      </p>
      <p className="small muted">
        Clip : {formatSourceMs(seg.srcStartMs)} → {formatSourceMs(seg.srcEndMs)} (proposition :{' '}
        {formatSourceMs(prop.srcStartMs)} → {formatSourceMs(prop.srcEndMs)})
      </p>
      <label>
        Décalage du début (s){' '}
        <input
          type="number"
          step={0.5}
          min={-10}
          max={10}
          value={startOff}
          disabled={disabled}
          onChange={(e) => setStartOff(Number(e.target.value))}
        />
      </label>{' '}
      <label>
        Décalage de la fin (s){' '}
        <input
          type="number"
          step={0.5}
          min={-10}
          max={10}
          value={endOff}
          disabled={disabled}
          onChange={(e) => setEndOff(Number(e.target.value))}
        />
      </label>{' '}
      <button
        type="button"
        disabled={disabled || !valid(startOff) || !valid(endOff)}
        onClick={() =>
          p.update('bounds', 'Bornes', {
            bounds: {
              startMs: Math.round(prop.srcStartMs + startOff * 1000),
              endMs: Math.round(prop.srcEndMs + endOff * 1000),
            },
          })
        }
      >
        Appliquer les bornes
      </button>
      {(!valid(startOff) || !valid(endOff)) && (
        <p className="warn small">Les bornes doivent rester à ±10 s de la proposition.</p>
      )}
      {boundsWarnings.map((w) => (
        <p key={w.code} className="warn small">
          ⚠ {w.message}
        </p>
      ))}
      {!view.durationAccepted && view.editable && (
        <button
          type="button"
          onClick={() =>
            p.update('confirmDuration', 'Confirmation de durée', { confirmDuration: true })
          }
        >
          Confirmer la durée hors plage
        </button>
      )}
    </fieldset>
  );
}
