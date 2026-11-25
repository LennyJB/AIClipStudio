/**
 * Effets : aucune proposition au chargement ; seul « Proposer des effets » appelle le serveur.
 * Les nouveaux effets arrivent DÉSACTIVÉS ; chacun ne s'active que par son interrupteur.
 * Les idées de Claude sont affichées en texte seulement (jamais appliquées).
 */
import { formatSourceMs } from '../../format';
import type { ProjectView } from '../../api';
import type { ClipProjectState } from './useClipProject';
import { EFFECT_LABELS } from './messages';

export function EffectsSection({
  view,
  p,
  ideas,
}: {
  view: ProjectView;
  p: ClipProjectState;
  ideas: string[];
}) {
  const d = view.document;
  const disabled = !view.editable;
  return (
    <fieldset aria-label="Effets">
      <legend>Effets</legend>
      <label>
        Mode{' '}
        <select
          value={d.mode}
          disabled={disabled}
          onChange={(e) =>
            p.update('mode', 'Mode', { mode: e.target.value as 'fidele' | 'enrichi' })
          }
        >
          <option value="fidele">Fidèle (aucun zoom)</option>
          <option value="enrichi">Enrichi (zooms possibles)</option>
        </select>
      </label>{' '}
      {view.editable && (
        <button type="button" onClick={p.suggestEffects}>
          Proposer des effets
        </button>
      )}
      {d.effects.length === 0 ? (
        <p className="muted small">Aucun effet. Rien n’est proposé sans votre demande.</p>
      ) : (
        <ul className="effects">
          {d.effects.map((e) => (
            <li key={e.id} data-testid={`effect-${e.id}`}>
              <label>
                <input
                  type="checkbox"
                  checked={e.enabled}
                  disabled={disabled}
                  onChange={(ev) =>
                    p.update(`effect.${e.id}`, 'Effet', {
                      effects: [{ id: e.id, enabled: ev.target.checked }],
                    })
                  }
                />{' '}
                {EFFECT_LABELS[e.type] ?? e.type}
              </label>{' '}
              <span className="small muted">
                {formatSourceMs(e.timing.srcStartMs)} → {formatSourceMs(e.timing.srcEndMs)}
                {e.origin === 'auto' ? ' · indice technique, à vérifier' : ' · ajouté par vous'}
                {d.mode === 'fidele' && e.type !== 'caption_emphasis'
                  ? ' · inactif en mode fidèle'
                  : ''}
              </span>
              <div className="small">{e.reason}</div>
              {Object.keys(e.signals).length > 0 && (
                <div className="small muted">
                  Mesures :{' '}
                  {Object.entries(e.signals)
                    .map(([k, v]) => `${k} = ${Math.round(v * 1000) / 1000}`)
                    .join(' ; ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {ideas.length > 0 && (
        <div className="small">
          <strong>Idées de montage de Claude (texte seulement, jamais appliquées) :</strong>
          <ul>
            {ideas.map((i, k) => (
              <li key={k}>{i}</li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
