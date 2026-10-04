import type { Access, AttachmentView, Evidence, Folders, GoalView, History, Provider, Settings, Status } from "./types";

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

/** Store one image for a message; the server answers with what it stored. */
async function upload(image: Blob, name: string): Promise<AttachmentView> {
  const response = await fetch(`/api/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": image.type }, body: image });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error?.code ?? "failed", data?.error?.message ?? "The image could not be attached.");
  return data as AttachmentView;
}

export const api = {
  upload,
  status: () => call<Status>("GET", "/api/status"),
  settings: () => call<Settings>("GET", "/api/settings"),
  setAccess: (access: Partial<Access>) => call<Settings>("PUT", "/api/settings", { access }),
  setWorkingFolder: (id: string) => call<Settings>("PUT", "/api/settings", { workingFolder: id }),
  setSettings: (patch: Partial<Omit<Settings, "access" | "workingFolder">>) => call<Settings>("PUT", "/api/settings", patch),
  providers: () => call<Provider[]>("GET", "/api/providers"),
  removeKey: (name: string) => call<null>("DELETE", `/api/keys/${encodeURIComponent(name)}`),
  keys: () => call<Record<string, boolean>>("GET", "/api/keys"),
  setKey: (name: string, value: string) => call<null>("PUT", `/api/keys/${encodeURIComponent(name)}`, { value }),
  goals: () => call<GoalView[]>("GET", "/api/goals"),
  history: (conversation: string, before?: number) => call<History>("GET", `/api/history?conversation=${encodeURIComponent(conversation)}${before ? `&before=${before}` : ""}`),
  folders: (path?: string) => call<Folders>("GET", `/api/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  addWorkspace: (path: string) => call<{ id: string; name: string; path: string }>("POST", "/api/workspaces", { path }),
  evidence: (task: string, handle: string) => call<Evidence>("GET", `/api/evidence?task=${encodeURIComponent(task)}&handle=${encodeURIComponent(handle)}`),
};
