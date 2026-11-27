/** Client de l'API « style de montage » (étape 10). */
import { getJson, send, type Job } from '../api';

export type StyleSource = 'reference' | 'pair' | 'editor';
export type Scalar = number | boolean | string;

export interface FeatureDef {
  key: string;
  group: string;
  label: string;
  type:
    | { kind: 'number'; min: number; max: number; unit: string; integer?: boolean }
    | { kind: 'boolean' }
    | { kind: 'enum'; options: string[] }
    | { kind: 'color' };
  measuredBy: StyleSource[];
  note?: string;
}

export interface FeatureValue {
  value: Scalar;
  origin: 'learned' | 'manual';
  samples: number;
  sources: StyleSource[];
  spread?: number;
}

export interface StyleVersion {
  version: number;
  features: Record<string, FeatureValue>;
  hash: string;
  origin: 'learned' | 'manual';
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  contentTypes: string[];
  builtin: boolean;
  archived: boolean;
  activeVersion: number | null;
  validatedAt: string | null;
  latestVersion: number | null;
  draftPending: boolean;
  references: number;
  applications: number;
}

export interface StyleReference {
  id: string;
  kind: 'edited' | 'pair';
  label: string;
  fileName: string;
  rawFileName: string | null;
  contentType: string | null;
  profileId: string | null;
  status: 'pending' | 'analyzing' | 'analyzed' | 'failed';
  analysis: {
    observation: { values: Record<string, Scalar> };
    summary: { durationMs: number; shots: number };
    pair: {
      alignedShots: number;
      totalShots: number;
      editorialCuts: number;
      reliable: boolean;
    } | null;
    limits: string[];
  } | null;
  error: { code: string; message: string } | null;
}

export interface ProfileDetail {
  profile: ProfileSummary;
  active: StyleVersion | null;
  draft: StyleVersion | null;
  changes: string[];
  versions: { version: number; origin: string; createdAt: string; validated: boolean }[];
  references: StyleReference[];
  created?: boolean;
}

const rid = () => crypto.randomUUID();

export const styleApi = {
  catalog: () =>
    getJson<{ groups: Record<string, string>; features: FeatureDef[] }>('/api/style/catalog'),
  profiles: () => getJson<{ profiles: ProfileSummary[] }>('/api/style-profiles'),
  profile: (id: string) => getJson<ProfileDetail>(`/api/style-profiles/${id}`),
  createProfile: (name: string, contentTypes: string[]) =>
    getJson<ProfileDetail>('/api/style-profiles', send('POST', { name, contentTypes })),
  learn: (id: string) =>
    getJson<ProfileDetail>(`/api/style-profiles/${id}/learn`, send('POST', { requestId: rid() })),
  editDraft: (id: string, baseVersion: number, set: Record<string, Scalar>, clear: string[]) =>
    getJson<ProfileDetail>(
      `/api/style-profiles/${id}/draft`,
      send('PUT', { requestId: rid(), baseVersion, set, clear }),
    ),
  validate: (id: string, version: number, featuresHash: string) =>
    getJson<ProfileDetail>(
      `/api/style-profiles/${id}/validate`,
      send('POST', { requestId: rid(), version, featuresHash }),
    ),
  references: () => getJson<{ references: StyleReference[] }>('/api/style-references'),
  importReference: (body: {
    kind: 'edited' | 'pair';
    path: string;
    rawPath?: string;
    profileId?: string | null;
  }) =>
    getJson<{ created: boolean; reference: StyleReference }>(
      '/api/style-references',
      send('POST', body),
    ),
  updateReference: (id: string, body: { profileId: string | null }) =>
    getJson<{ reference: StyleReference }>(`/api/style-references/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  analyze: (id: string) =>
    getJson<{ job: Job; reference: StyleReference }>(
      `/api/style-references/${id}/analyze`,
      send('POST', {}),
    ),
  remove: async (id: string) => {
    const res = await fetch(`/api/style-references/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Suppression impossible (HTTP ${res.status})`);
  },
};
