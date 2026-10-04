import type { Access, Folders, GoalView, History, Settings, Status } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** One HTTP call; the session cookie goes with it. Failures carry the server's message for the user. */
async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(response.status, data?.error?.code ?? "failed", data?.error?.message ?? "Socrates could not do that.");
  return data as T;
}

export const api = {
  status: () => call<Status>("GET", "/api/status"),
  settings: () => call<Settings>("GET", "/api/settings"),
  setAccess: (access: Partial<Access>) => call<Settings>("PUT", "/api/settings", { access }),
  setWorkingFolder: (id: string) => call<Settings>("PUT", "/api/settings", { workingFolder: id }),
  keys: () => call<Record<string, boolean>>("GET", "/api/keys"),
  setKey: (name: string, value: string) => call<null>("PUT", `/api/keys/${encodeURIComponent(name)}`, { value }),
  goals: () => call<GoalView[]>("GET", "/api/goals"),
  history: (conversation: string, before?: number) => call<History>("GET", `/api/history?conversation=${encodeURIComponent(conversation)}${before ? `&before=${before}` : ""}`),
  folders: (path?: string) => call<Folders>("GET", `/api/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  addWorkspace: (path: string) => call<{ id: string; name: string; path: string }>("POST", "/api/workspaces", { path }),
  evidence: (task: string, handle: string) => call<{ content: string | null; truncated: boolean }>("GET", `/api/evidence?task=${encodeURIComponent(task)}&handle=${encodeURIComponent(handle)}`),
};
