/**
 * Pistes audio du projet : ajout et retrait selon la décision du SERVEUR.
 *  - ajout ou réactivation : seulement pour une piste que le serveur autorise (`audio.selected`) ;
 *  - piste non autorisée : aucun bouton, la raison et ce qui manque sont affichés ;
 *  - le serveur revérifie tout sous verrou (refus EXPORT_CONSENT_REQUIRED affiché sinon).
 */
import type { ProjectView } from '../../api';
import { ROLE_LABELS } from '../../format';
import type { ClipProjectState } from './useClipProject';
import { describeMissing } from './messages';

export function AudioSection({ view, p }: { view: ProjectView; p: ClipProjectState }) {
  const a = view.document.audio;
  const disabled = !view.editable;
  const allowed = new Set(view.audio.selected.map((t) => t.audioIndex));
  const inProject = new Set(a.tracks.map((t) => t.audioIndex));
  const verdict = (i: number) => view.audio.tracks.find((t) => t.audioIndex === i);
  const label = (t: { audioIndex: number; role: string }) =>
    `${ROLE_LABELS[t.role] ?? t.role} (piste ${t.audioIndex})`;
  const absent = view.audio.tracks.filter((t) => !inProject.has(t.audioIndex));
  const track = (audioIndex: number, change: { enabled?: boolean; gainDb?: number }) =>
    p.update(`audio.${audioIndex}.${'gainDb' in change ? 'gain' : 'on'}`, 'Audio', {
      audio: { tracks: [{ audioIndex, ...change }] },
    });

  return (
    <fieldset aria-label="Audio">
      <legend>Audio</legend>
      <ul className="audio-tracks">
        {a.tracks.map((t) => {
          const ok = allowed.has(t.audioIndex);
          const v = verdict(t.audioIndex);
          return (
            <li key={t.audioIndex} data-testid={`track-${t.audioIndex}`}>
              <strong>{label(t)}</strong> : {t.enabled ? 'dans l’export' : 'retirée'}{' '}
              {t.enabled ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => track(t.audioIndex, { enabled: false })}
                >
                  Retirer
                </button>
              ) : ok ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => track(t.audioIndex, { enabled: true })}
                >
                  Réactiver
                </button>
              ) : null}{' '}
              {t.enabled && !ok && (
                <span className="warn small">
                  non autorisée actuellement : le rendu sera refusé tant qu’elle n’est pas retirée
                </span>
              )}
              {!t.enabled && !ok && v && (
                <span className="small muted">
                  non autorisée : {describeMissing(v.missing) || v.reason}
                </span>
              )}
              <label className="small">
                {' '}
                Gain (dB){' '}
                <input
                  type="number"
                  min={-30}
                  max={12}
                  step={1}
                  value={t.gainDb}
                  disabled={disabled}
                  onChange={(e) => {
                    const g = Number(e.target.value);
                    if (Number.isFinite(g)) track(t.audioIndex, { gainDb: g });
                  }}
                />
              </label>
            </li>
          );
        })}
      </ul>
      {absent.length > 0 && (
        <>
          <h4>Pistes absentes du projet</h4>
          <ul className="audio-tracks">
            {absent.map((t) => (
              <li key={t.audioIndex} data-testid={`absent-${t.audioIndex}`}>
                <strong>{label(t)}</strong>{' '}
                {allowed.has(t.audioIndex) ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => track(t.audioIndex, { enabled: true })}
                  >
                    Ajouter
                  </button>
                ) : t.exportable ? (
                  <span className="small muted">
                    non utilisée : les pistes séparées sont exportées à sa place (jamais les deux)
                  </span>
                ) : (
                  <span className="small muted">
                    non autorisée : {describeMissing(t.missing) || t.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="small muted">
        Rappel : le micro peut capter le retour des haut-parleurs (Discord, jeu). Déclarez-le dans «
        Audio exporté » s’il contient des voix de tiers.
      </p>
      <label>
        <input
          type="checkbox"
          checked={a.loudnorm.enabled}
          disabled={disabled}
          onChange={(e) =>
            p.update('audio.loudnorm', 'Normalisation', { audio: { loudnorm: e.target.checked } })
          }
        />{' '}
        Normaliser le volume (−14 LUFS)
      </label>
      <br />
      <label>
        <input
          type="checkbox"
          checked={a.silent}
          disabled={disabled}
          onChange={(e) =>
            p.update('audio.silent', 'Export sans son', { audio: { silent: e.target.checked } })
          }
        />{' '}
        Exporter volontairement sans son
      </label>
    </fieldset>
  );
}
