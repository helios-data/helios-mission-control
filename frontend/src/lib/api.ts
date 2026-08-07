// Thin REST client for the admin console.

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => req<Record<string, unknown>>("/api/config"),
  patchConfig: (patch: Record<string, unknown>) =>
    req("/api/config", { method: "PATCH", body: JSON.stringify(patch) }),

  record: (source: "srad" | "cots" | "ground" | "combined", action: "start" | "stop") =>
    req(`/api/record/${source}`, { method: "POST", body: JSON.stringify({ action }) }),
  recordStatus: () => req<Record<string, { recording: boolean; count?: number }>>("/api/record"),
  listLogs: () => req<{ files: { name: string; size: number; mtime: number }[] }>("/api/logs"),

  command: (type: "rfd_config" | "camera", payload: Record<string, unknown>, operator: string, override = false) =>
    req("/api/command", {
      method: "POST",
      body: JSON.stringify({ type, payload, operator, override }),
    }),
  commands: () => req<{ commands: unknown[]; camera_state: Record<string, boolean> }>("/api/commands"),

  landingConfig: (payload: {
    wind_source_mode: "live" | "manual";
    wind_speed_ms?: number;
    wind_dir_deg?: number;
    operator?: string;
  }) => req("/api/landing/config", { method: "POST", body: JSON.stringify(payload) }),

  clock: (action: "arm" | "reset" | "liftoff", seconds = 0) =>
    req("/api/clock", { method: "POST", body: JSON.stringify({ action, seconds }) }),

  historySrad: (since?: number) =>
    req<{ items: unknown[] }>(`/api/history/srad${since ? `?since=${since}` : ""}`),
};
