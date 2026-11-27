/**
 * Audio exporté d'un enregistrement (docs/plan-etape-6.md §6.4) : décision du SERVEUR piste par
 * piste, déclarations de composition, accords par catégorie (avec note), révocation, historique.
 * Aucune règle n'est appliquée ici : un accord Discord seul ne rend jamais « Tout » exportable,
 * et seule la réponse du serveur fait foi.
 */
import { useEffect, useState } from 'react';
import {
  clipsApi,
  type DeclarationSubject,
  type ExportAudioBody,
  type ExportAudioView,
  type Presence,
  type VoiceCategory,
} from '../../api';
import { ROLE_LABELS } from '../../format';
import { CATEGORY_LABELS, describeMissing, errorMessage } from './messages';

const DECLARATIONS: {
  subject: DeclarationSubject;
  title: string;
  fields: { key: string; label: string }[];
  /** Rôles de piste concernés : la déclaration n'est proposée que si la piste existe. */
  roles: string[];
}[] = [
  {
    subject: 'mic_composition',
    title: 'Piste Micro',
    roles: ['mic'],
    fields: [
      { key: 'creatorVoice', label: 'Votre voix' },
      { key: 'otherVoices', label: 'Voix de tiers captées par le micro (pièce, haut-parleurs…)' },
    ],
  },
  {
    subject: 'game_composition',
    title: 'Piste Jeu',
    roles: ['game'],
    fields: [{ key: 'gameVoiceChat', label: 'Chat vocal du jeu' }],
  },
  {
    subject: 'mix_composition',
    title: 'Piste Tout / Mix',
    roles: ['mix', 'unknown'],
    fields: [
      { key: 'discord', label: 'Voix Discord' },
      { key: 'gameVoiceChat', label: 'Chat vocal du jeu' },
      { key: 'otherVoices', label: 'Autres voix de tiers' },
    ],
  },
];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const CATEGORIES: VoiceCategory[] = ['discord_voices', 'game_voice_chat', 'other_voices'];
const PRESENCE_LABELS: Record<Presence, string> = { present: 'présente', absent: 'absente' };

function Declaration({
  def,
  current,
  disabled,
  onSubmit,
}: {
  def: (typeof DECLARATIONS)[number];
  current: Record<string, Presence> | null;
  disabled: boolean;
  onSubmit: (payload: Record<string, Presence>, note: string) => void;
}) {
  // Aucun choix par défaut : chaque champ doit être choisi explicitement.
  const [values, setValues] = useState<Record<string, Presence | undefined>>({});
  const [note, setNote] = useState('');
  const complete = def.fields.every((f) => values[f.key]);
  return (
    <fieldset aria-label={`Déclaration : ${def.title}`}>
      <legend>{def.title}</legend>
      <p className="small muted">
        Déclaration actuelle :{' '}
        {current
          ? def.fields
              .map((f) => `${f.label} ${PRESENCE_LABELS[current[f.key] ?? 'present']}`)
              .join(' ; ')
          : 'aucune (piste bloquée)'}
      </p>
      {def.fields.map((f) => (
        <div key={f.key} role="radiogroup" aria-label={f.label}>
          {f.label} :{' '}
          {(['present', 'absent'] as const).map((p) => (
            <label key={p} className="filter">
              <input
                type="radio"
                name={`${def.subject}-${f.key}`}
                checked={values[f.key] === p}
                disabled={disabled}
                onChange={() => setValues((v) => ({ ...v, [f.key]: p }))}
              />{' '}
              {PRESENCE_LABELS[p]}
            </label>
          ))}
        </div>
      ))}
      <label>
        Note (facultative){' '}
        <input
          value={note}
          maxLength={500}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>{' '}
      <button
        type="button"
        disabled={disabled || !complete}
        title={complete ? undefined : 'Choisissez « présente » ou « absente » pour chaque voix'}
        onClick={() => {
          onSubmit(values as Record<string, Presence>, note);
          setValues({});
          setNote('');
        }}
      >
        Enregistrer la déclaration
      </button>
    </fieldset>
  );
}

export function ExportAudioPanel({
  recordingId,
  onChanged,
}: {
  recordingId: string;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<ExportAudioView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Partial<Record<VoiceCategory, string>>>({});

  useEffect(() => {
    let alive = true;
    clipsApi
      .exportAudio(recordingId)
      .then((v) => alive && setView(v))
      .catch((err: unknown) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [recordingId]);

  const record = async (body: DistributiveOmit<ExportAudioBody, 'requestId'>) => {
    setBusy(true);
    setError(null);
    try {
      setView(
        await clipsApi.recordExportAudio(recordingId, {
          ...body,
          requestId: crypto.randomUUID(),
        } as ExportAudioBody),
      );
      onChanged?.();
      // Les éditeurs ouverts (autres onglets) relisent aussitôt la décision d'audio exporté.
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel('acs-export-audio');
        ch.postMessage({ recordingId });
        ch.close();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <section aria-label="Audio exporté">
        <h3>Audio exporté</h3>
        {error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>}
      </section>
    );
  }
  const roles = new Set(view.decision.tracks.map((t) => t.role));
  const selected = new Set(view.decision.selected.map((t) => t.audioIndex));
  return (
    <section aria-label="Audio exporté">
      <h3>Audio exporté</h3>
      <p className="small muted">
        Décision calculée par le serveur à chaque rendu. Une composition non déclarée est considérée
        comme pouvant contenir n’importe quelle voix : la piste reste bloquée.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="audio-tracks">
        {view.decision.tracks.map((t) => (
          <li key={t.audioIndex} data-testid={`verdict-${t.audioIndex}`}>
            <strong>
              {ROLE_LABELS[t.role] ?? t.role} (piste {t.audioIndex})
            </strong>{' '}
            {t.exportable ? (
              <span className="badge state-accepted">
                {selected.has(t.audioIndex) ? 'exportable' : 'non utilisée (pistes séparées)'}
              </span>
            ) : (
              <span className="badge state-rejected">bloquée</span>
            )}{' '}
            <span className="small">{t.reason}</span>
            {!t.exportable && t.missing.length > 0 && (
              <div className="small warn">Manque : {describeMissing(t.missing)}</div>
            )}
          </li>
        ))}
      </ul>
      <p className="small">
        {view.decision.mode === 'none'
          ? `Aucun audio exportable : ${describeMissing(view.decision.missing) || 'aucune piste'}`
          : `Export : ${view.decision.selected.map((t) => ROLE_LABELS[t.role] ?? t.role).join(' + ')}`}
      </p>

      <h4>Déclarations</h4>
      {DECLARATIONS.filter((d) => d.roles.some((r) => roles.has(r))).map((d) => (
        <Declaration
          key={d.subject}
          def={d}
          disabled={busy}
          current={
            d.subject === 'mic_composition'
              ? view.state.micComposition
              : d.subject === 'game_composition'
                ? view.state.gameComposition
                : view.state.mixComposition
          }
          onSubmit={(payload, note) =>
            void record({
              kind: 'declaration',
              subject: d.subject,
              payload,
              ...(note.trim() ? { note: note.trim() } : {}),
            })
          }
        />
      ))}

      <h4>Accords des personnes enregistrées</h4>
      <ul className="consents">
        {CATEGORIES.map((c) => {
          const granted = view.state.consents[c];
          return (
            <li key={c}>
              <strong>{CATEGORY_LABELS[c]}</strong> :{' '}
              {granted ? 'accord enregistré' : 'aucun accord'}{' '}
              <input
                aria-label={`Note pour ${CATEGORY_LABELS[c]}`}
                placeholder="note (ex. accord de A et B)"
                maxLength={500}
                value={notes[c] ?? ''}
                disabled={busy}
                onChange={(e) => setNotes((n) => ({ ...n, [c]: e.target.value }))}
              />{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const note = notes[c]?.trim();
                  setNotes((n) => ({ ...n, [c]: '' }));
                  void record({
                    kind: 'consent',
                    subject: c,
                    action: granted ? 'revoked' : 'granted',
                    ...(note ? { note } : {}),
                  });
                }}
              >
                {granted ? 'Révoquer l’accord' : 'Enregistrer l’accord'}
              </button>
            </li>
          );
        })}
      </ul>

      <details>
        <summary>Historique ({view.history.length})</summary>
        <ol className="small">
          {view.history.map((e) => (
            <li key={e.id}>
              {new Date(e.createdAt).toLocaleString('fr-FR')} —{' '}
              {e.kind === 'consent'
                ? `accord ${e.action === 'granted' ? 'donné' : 'révoqué'} : ${
                    CATEGORY_LABELS[e.subject as VoiceCategory] ?? e.subject
                  }`
                : `déclaration ${e.subject}`}
              {e.note ? ` — « ${e.note} »` : ''} ({e.source})
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
