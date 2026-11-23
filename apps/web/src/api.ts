export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
  database: 'ok';
  claudeConfigured: boolean;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch('/api/health', signal ? { signal } : {});
  if (!res.ok) throw new Error(`API indisponible (HTTP ${res.status})`);
  return (await res.json()) as HealthResponse;
}
