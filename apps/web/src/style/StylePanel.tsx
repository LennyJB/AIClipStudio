import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  styleApi,
  type FeatureDef,
  type FeatureValue,
  type ProfileDetail,
  type ProfileSummary,
  type Scalar,
  type StyleReference,
} from './api';

const TYPE_LABELS: Record<string, string> = {
  gaming: 'Gaming',
  just_chatting: 'Just Chatting',
  reaction: 'Réaction',
  podcast: 'Podcast',
  irl: 'IRL',
  mixed: 'Mixte (tout format)',
};
const SOURCE_LABELS: Record<string, string> = {
  reference: 'référence',
  pair: 'paire brut/montage',
  editor: 'vos montages',
};

export function formatValue(def: FeatureDef | undefined, v: Scalar | undefined): string {
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'number' && def?.type.kind === 'number') {
    if (def.type.unit === 'ratio') return `${Math.round(v * 100)} %`;
    if (def.type.unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
    return `${v} ${def.type.unit}`;
  }
  return String(v);
}

const describe = (fv: FeatureValue | undefined) =>
  !fv
    ? ''
    : fv.origin === 'manual'
      ? 'réglé par vous'
      : `appris (${fv.samples} obs. · ${fv.sources.map((s) => SOURCE_LABELS[s]).join(', ')})`;

function FeatureInput({
  def,
  value,
  onChange,
}: {
  def: FeatureDef;
  value: Scalar | undefined;
  onChange: (v: Scalar) => void;
}) {
  const t = def.type;
  const label = `Valeur : ${def.label}`;
  if (t.kind === 'boolean')
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  if (t.kind === 'enum')
    return (
      <select
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          —
        </option>
        {t.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  if (t.kind === 'color')
    return (
      <input
        type="color"
        aria-label={label}
        value={typeof value === 'string' ? value : '#ffffff'}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
    );
  return (
    <input
      type="number"
      aria-label={label}
      min={t.min}
      max={t.max}
      step={t.integer ? 1 : 'any'}
      value={typeof value === 'number' ? value : ''}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/**
 * Style de montage (étape 10) : profils par format et personnalisés, caractéristiques apprises
 * (avec leur provenance et ce qui n'est pas mesurable), brouillon, validation, références.
 */
export function StylePanel({ pollMs = 1000 }: { pollMs?: number }) {
  const [catalog, setCatalog] = useState<{
    groups: Record<string, string>;
    features: FeatureDef[];
  } | null>(null);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [selected, setSelected] = useState('gaming');
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [refs, setRefs] = useState<StyleReference[]>([]);
  const [edits, setEdits] = useState<Record<string, Scalar>>({});
  const [clears, setClears] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTypes, setNewTypes] = useState<string[]>([]);
  const [imp, setImp] = useState({ kind: 'edited' as 'edited' | 'pair', path: '', rawPath: '' });

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const reload = useCallback(
    () =>
      Promise.all([styleApi.profiles(), styleApi.references()]).then(([p, r]) => {
        setProfiles(p.profiles);
        setRefs(r.references);
      }),
    [],
  );
  const loadDetail = useCallback((id: string) => styleApi.profile(id).then(setDetail), []);

  useEffect(() => {
    styleApi.catalog().then(setCatalog, fail);
    reload().catch(fail);
  }, [reload]);
  useEffect(() => {
    loadDetail(selected).catch(fail);
  }, [selected, loadDetail]);

  const analyzing = refs.some((r) => r.status === 'analyzing');
  useEffect(() => {
    if (!analyzing) return;
    const t = setInterval(() => {
      reload()
        .then(() => loadDetail(selected))
        .catch(() => undefined);
    }, pollMs);
    return () => clearInterval(t);
  }, [analyzing, pollMs, reload, loadDetail, selected]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await reload();
      await loadDetail(selected);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const shown = detail?.draft ?? detail?.active ?? null;
  const byGroup = useMemo(() => {
    const m = new Map<string, FeatureDef[]>();
    for (const f of catalog?.features ?? []) m.set(f.group, [...(m.get(f.group) ?? []), f]);
    return m;
  }, [catalog]);
  const dirty = Object.keys(edits).length > 0 || clears.length > 0;
  const baseVersion = detail?.versions.at(-1)?.version ?? 0;

  return (
    <section className="card" aria-label="Style de montage" data-testid="style-panel">
      <h2>Style de montage</h2>
      <p className="muted small">
        Tout est analysé sur cet ordinateur : aucune vidéo n’est envoyée. Seules des
        caractéristiques stylistiques mesurables sont apprises (jamais le contenu, les dialogues ni
        les images d’une référence). Un profil ne sert qu’une fois validé, et l’apprentissage ne
        modifie jamais une version validée : il propose un brouillon.
      </p>
      {error && <p className="error">{error}</p>}

      <div className="row">
        <label>
          Profil{' '}
          <select
            aria-label="Profil"
            value={selected}
            onChange={(e) => {
              setEdits({});
              setClears([]);
              setSelected(e.target.value);
            }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archivé)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {detail && (
        <div data-testid="style-profile">
          <p>
            <strong>{detail.profile.name}</strong>{' '}
            <span className="muted small">
              ·{' '}
              {detail.profile.contentTypes.map((t) => TYPE_LABELS[t] ?? t).join(', ') ||
                'aucun format (jamais appliqué)'}
              {' · '}
              {detail.profile.activeVersion
                ? `version validée ${detail.profile.activeVersion}`
                : 'non validé : jamais appliqué'}
              {detail.draft && ` · brouillon v${detail.draft.version} à valider`}
              {` · appliqué à ${detail.profile.applications} projet(s)`}
            </span>
          </p>
          {detail.draft && detail.changes.length > 0 && (
            <p className="warning small" data-testid="style-changes">
              Le brouillon change {detail.changes.length} caractéristique(s) par rapport à la
              version validée (surlignées).
            </p>
          )}
          <table className="style-table">
            <thead>
              <tr>
                <th>Caractéristique</th>
                <th>Validé</th>
                <th>{detail.draft ? 'Brouillon' : 'Valeur'}</th>
                <th>Provenance</th>
                <th>Modifier</th>
              </tr>
            </thead>
            {[...byGroup.entries()].map(([g, defs]) => (
              <tbody key={g}>
                <tr>
                  <th colSpan={5}>{catalog?.groups[g] ?? g}</th>
                </tr>
                {defs.map((d) => {
                  const a = detail.active?.features[d.key];
                  const s = shown?.features[d.key];
                  const changed = detail.changes.includes(d.key);
                  const unmeasurable = d.measuredBy.length === 0;
                  return (
                    <tr
                      key={d.key}
                      className={changed ? 'style-changed' : undefined}
                      data-feature={d.key}
                    >
                      <td>
                        {d.label}
                        {d.note && (
                          <span className="muted small" title={d.note}>
                            {' '}
                            {unmeasurable ? '(non mesurable)' : 'ⓘ'}
                          </span>
                        )}
                      </td>
                      <td>{formatValue(d, a?.value)}</td>
                      <td>
                        {clears.includes(d.key)
                          ? '(retiré)'
                          : formatValue(d, edits[d.key] ?? s?.value)}
                      </td>
                      <td className="muted small">{describe(s)}</td>
                      <td>
                        <FeatureInput
                          def={d}
                          value={edits[d.key] ?? s?.value}
                          onChange={(v) => {
                            setEdits((e) => ({ ...e, [d.key]: v }));
                            setClears((c) => c.filter((k) => k !== d.key));
                          }}
                        />
                        {s && (
                          <button
                            type="button"
                            aria-label={`Retirer ${d.label}`}
                            onClick={() => setClears((c) => [...c, d.key])}
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
          <p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => styleApi.learn(selected))}
            >
              Apprendre (références et montages)
            </button>{' '}
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() =>
                void act(async () => {
                  await styleApi.editDraft(selected, baseVersion, edits, clears);
                  setEdits({});
                  setClears([]);
                })
              }
            >
              Enregistrer mes réglages (brouillon)
            </button>{' '}
            {detail.draft && (
              <button
                type="button"
                disabled={busy || dirty}
                onClick={() =>
                  void act(() =>
                    styleApi.validate(selected, detail.draft!.version, detail.draft!.hash),
                  )
                }
              >
                Valider le brouillon v{detail.draft.version}
              </button>
            )}
          </p>
        </div>
      )}

      <details>
        <summary>Nouveau profil personnalisé</summary>
        <label>
          Nom{' '}
          <input
            aria-label="Nom du profil"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </label>
        {Object.entries(TYPE_LABELS).map(([t, l]) => (
          <label key={t}>
            <input
              type="checkbox"
              checked={newTypes.includes(t)}
              onChange={(e) =>
                setNewTypes((x) => (e.target.checked ? [...x, t] : x.filter((y) => y !== t)))
              }
            />{' '}
            {l}
          </label>
        ))}
        <button
          type="button"
          disabled={busy || !newName.trim()}
          onClick={() =>
            void act(async () => {
              const p = await styleApi.createProfile(newName.trim(), newTypes);
              setNewName('');
              setNewTypes([]);
              setSelected(p.profile.id);
            })
          }
        >
          Créer
        </button>
      </details>

      <h3>Vidéos de référence</h3>
      <p className="muted small">
        Une vidéo montée (même d’un autre créateur) donne rythme, plans, fondus, arrêts sur image,
        sonie et silences. Une paire (vidéo brute + sa version montée) permet en plus de retrouver
        ce qui a été coupé. Sous-titres, facecam, zooms, effets et musique ne sont pas mesurables
        dans une vidéo : ils s’apprennent de vos montages ou se règlent à la main.
      </p>
      <div className="row" data-testid="style-import">
        <select
          aria-label="Type de référence"
          value={imp.kind}
          onChange={(e) => setImp({ ...imp, kind: e.target.value as 'edited' | 'pair' })}
        >
          <option value="edited">Vidéo montée</option>
          <option value="pair">Paire brut + montage</option>
        </select>
        <input
          aria-label="Chemin de la vidéo montée"
          placeholder="C:\\videos\\montage.mp4"
          value={imp.path}
          onChange={(e) => setImp({ ...imp, path: e.target.value })}
        />
        {imp.kind === 'pair' && (
          <input
            aria-label="Chemin de la vidéo brute"
            placeholder="C:\\videos\\brut.mkv"
            value={imp.rawPath}
            onChange={(e) => setImp({ ...imp, rawPath: e.target.value })}
          />
        )}
        <button
          type="button"
          disabled={busy || !imp.path.trim() || (imp.kind === 'pair' && !imp.rawPath.trim())}
          onClick={() =>
            void act(async () => {
              const r = await styleApi.importReference({
                kind: imp.kind,
                path: imp.path.trim(),
                ...(imp.kind === 'pair' ? { rawPath: imp.rawPath.trim() } : {}),
                profileId: selected,
              });
              await styleApi.analyze(r.reference.id);
              setImp({ ...imp, path: '', rawPath: '' });
            })
          }
        >
          Importer et analyser pour « {detail?.profile.name ?? selected} »
        </button>
      </div>
      <ul data-testid="style-references">
        {refs.map((r) => (
          <li key={r.id}>
            <strong>{r.label}</strong>{' '}
            <span className="muted small">
              {r.kind === 'pair' ? `paire (brut : ${r.rawFileName})` : 'vidéo montée'} ·{' '}
              {
                {
                  pending: 'à analyser',
                  analyzing: 'analyse en cours…',
                  analyzed: 'analysée',
                  failed: 'échec',
                }[r.status]
              }
            </span>
            {r.error && <span className="error small"> · {r.error.message}</span>}
            {r.analysis?.pair && (
              <span className="small">
                {' '}
                · {r.analysis.pair.alignedShots}/{r.analysis.pair.totalShots} plans retrouvés dans
                le brut
              </span>
            )}{' '}
            <select
              aria-label={`Profil de ${r.label}`}
              value={r.profileId ?? ''}
              onChange={(e) =>
                void act(() =>
                  styleApi.updateReference(r.id, { profileId: e.target.value || null }),
                )
              }
            >
              <option value="">(aucun profil)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>{' '}
            {r.status !== 'analyzing' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => styleApi.analyze(r.id))}
              >
                {r.status === 'analyzed' ? 'Réanalyser' : 'Analyser'}
              </button>
            )}{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => styleApi.remove(r.id))}
            >
              Retirer
            </button>
            {r.analysis?.limits.length ? (
              <ul className="muted small">
                {r.analysis.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
