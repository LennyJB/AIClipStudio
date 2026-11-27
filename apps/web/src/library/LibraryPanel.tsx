/**
 * Bibliothèque de médias (étape 7, PR 7f) : import (avec déclaration de droits obligatoire),
 * aperçus, métadonnées, fichiers manquants signalés, suppression (refusée par le serveur tant
 * qu'un projet utilise le média). Utilisée seule (page d'accueil) ou comme sélecteur dans
 * l'éditeur (`onPick`).
 */
import { useRef, useState } from 'react';
import {
  ACCEPT,
  formatBytes,
  libraryApi,
  libraryError,
  notifyLibraryChanged,
  RIGHTS_LABELS,
  type AssetDto,
  type AssetRights,
  type LibraryApi,
} from './api';
import { useLibrary } from './useLibrary';

/** Forme d'onde d'un son (pics 0..1) : SVG léger, aucun décodage dans le navigateur. */
export function Peaks({ peaks }: { peaks: readonly number[] }) {
  const w = peaks.length;
  return (
    <svg
      viewBox={`0 0 ${w} 20`}
      className="lib-peaks"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      {peaks.map((p, i) => (
        <rect key={i} x={i} y={10 - p * 10} width={0.8} height={Math.max(0.3, p * 20)} />
      ))}
    </svg>
  );
}

interface Props {
  api?: LibraryApi;
  /** Mode sélecteur (éditeur) : un clic choisit le média ; seuls les médias présents. */
  onPick?: (a: AssetDto) => void;
  kind?: 'image' | 'audio';
  title?: string;
}

export function LibraryPanel({ api = libraryApi, onPick, kind, title }: Props) {
  const lib = useLibrary(api);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [rights, setRights] = useState<AssetRights | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const shown = (lib.assets ?? []).filter((a) => !kind || a.kind === kind);

  const importFile = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !rights) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.upload(file, { name: file.name, rights, rightsNote: note });
      setMessage({
        kind: 'ok',
        text: r.duplicate
          ? `« ${r.asset.displayName} » était déjà dans la bibliothèque (aucune copie ajoutée).`
          : `« ${r.asset.displayName} » importé.`,
      });
      if (fileRef.current) fileRef.current.value = '';
      notifyLibraryChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: `Import refusé : ${libraryError(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: AssetDto) => {
    if (!window.confirm(`Supprimer « ${a.displayName} » de la bibliothèque ?`)) return;
    setMessage(null);
    try {
      await api.remove(a.id);
      setMessage({ kind: 'ok', text: `« ${a.displayName} » supprimé.` });
      notifyLibraryChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: libraryError(err) });
    }
  };

  return (
    <section className="card library" aria-label="Bibliothèque de médias">
      <h2>{title ?? 'Bibliothèque de médias'}</h2>
      <p className="small muted">
        Images fixes (PNG, JPEG, WebP, GIF non animé) et effets sonores courts (WAV, MP3, OGG, FLAC,
        M4A). Chaque fichier est vérifié puis ré-encodé par le serveur ; il reste sur cet
        ordinateur. N’importez que des médias que vous avez le droit d’utiliser.
      </p>
      <div className="lib-import">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          data-testid="library-file"
          aria-label="Fichier à importer"
          disabled={busy}
        />
        <label>
          Droits{' '}
          <select
            value={rights}
            onChange={(e) => setRights(e.target.value as AssetRights | '')}
            data-testid="library-rights"
            disabled={busy}
          >
            <option value="">— à déclarer —</option>
            {(Object.keys(RIGHTS_LABELS) as AssetRights[]).map((r) => (
              <option key={r} value={r}>
                {RIGHTS_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          placeholder="Source ou licence (facultatif)"
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => void importFile()}
          disabled={busy || !rights}
          data-testid="library-import"
        >
          {busy ? 'Import…' : 'Importer'}
        </button>
      </div>
      {message && (
        <p
          className={message.kind === 'error' ? 'error' : 'small'}
          role="status"
          data-testid="library-message"
        >
          {message.text}
        </p>
      )}
      {lib.error && (
        <p className="error" role="alert">
          Bibliothèque illisible : {lib.error}
        </p>
      )}
      {lib.assets === null && !lib.error && <p className="small muted">Chargement…</p>}
      {lib.assets !== null && !shown.length && (
        <p className="small muted">Aucun média pour l’instant.</p>
      )}
      <ul className="lib-grid">
        {shown.map((a) => (
          <li
            key={a.id}
            className={`lib-item${a.status === 'missing' ? ' missing' : ''}`}
            data-testid="library-item"
            data-asset-id={a.id}
          >
            {a.kind === 'image' ? (
              a.status === 'ok' ? (
                <img
                  src={api.previewUrl(a.id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  width={128}
                  height={Math.max(1, Math.round((128 * (a.height ?? 1)) / (a.width ?? 1)))}
                />
              ) : (
                <div className="lib-missing">Fichier manquant</div>
              )
            ) : a.peaks ? (
              <Peaks peaks={a.peaks} />
            ) : null}
            <div className="lib-meta">
              <strong title={a.displayName}>{a.displayName}</strong>
              <span className="small muted">
                {a.kind === 'image'
                  ? `${a.width}×${a.height}`
                  : `${((a.durationMs ?? 0) / 1000).toFixed(2)} s`}{' '}
                · {formatBytes(a.sizeBytes)} · {RIGHTS_LABELS[a.rights]}
              </span>
              {a.status === 'missing' && (
                <span className="error small">
                  Fichier manquant : réimportez le même fichier pour le réparer. Les rendus qui
                  l’utilisent sont refusés.
                </span>
              )}
            </div>
            <div className="lib-actions">
              {a.kind === 'audio' && a.status === 'ok' && (
                <audio
                  controls
                  preload="none"
                  src={api.fileUrl(a.id)}
                  aria-label={`Écouter ${a.displayName}`}
                />
              )}
              {onPick && (
                <button
                  type="button"
                  disabled={a.status !== 'ok'}
                  onClick={() => onPick(a)}
                  data-testid="library-pick"
                >
                  Ajouter au clip
                </button>
              )}
              {!onPick && (
                <button type="button" onClick={() => void remove(a)} data-testid="library-delete">
                  Supprimer
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
