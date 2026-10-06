import type { CallDetail, CallRow, DataOverview, DbPage, DbRow, PriceRow, QuestionDetail, QuestionRow, Range, SeriesData, Summary, Trace } from "./observe";
import type { Access, AttachmentView, Evidence, Folders, GoalView, History, ListedModel, Provider, Settings, Status } from "./types";

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
  setSettings: (patch: SettingsPatch) => call<Settings>("PUT", "/api/settings", patch),
  providers: () => call<Provider[]>("GET", "/api/providers"),
  models: (provider: string) => call<{ models: ListedModel[] }>("GET", `/api/models?provider=${encodeURIComponent(provider)}`).then((r) => r.models),
  removeKey: (name: string) => call<null>("DELETE", `/api/keys/${encodeURIComponent(name)}`),
  keys: () => call<Record<string, boolean>>("GET", "/api/keys"),
  setKey: (name: string, value: string) => call<null>("PUT", `/api/keys/${encodeURIComponent(name)}`, { value }),
  goals: () => call<GoalView[]>("GET", "/api/goals"),
  history: (conversation: string, before?: number) => call<History>("GET", `/api/history?conversation=${encodeURIComponent(conversation)}${before ? `&before=${before}` : ""}`),
  folders: (path?: string) => call<Folders>("GET", `/api/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  addWorkspace: (path: string) => call<{ id: string; name: string; path: string }>("POST", "/api/workspaces", { path }),
  thinking: (seq: number) => call<{ seq: number; text: string }>("GET", `/api/thinking?seq=${seq}`),
  observeSummary: (range: Range) => call<Summary>("GET", `/api/observe/summary?range=${range}`),
  observePrices: () => call<PriceRow[]>("GET", "/api/observe/prices"),
  observeQuestions: (range: Range, before?: string) => call<{ questions: QuestionRow[]; next: string | null }>("GET", `/api/observe/questions?range=${range}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  observeQuestion: (id: string) => call<QuestionDetail>("GET", `/api/observe/questions/${encodeURIComponent(id)}`),
  observeSeries: (range: Range) => call<SeriesData>("GET", `/api/observe/series?range=${range}`),
  observeRecent: (limit = 12) => call<CallRow[]>("GET", `/api/observe/recent?limit=${limit}`),
  observeCostly: (range: Range) => call<QuestionRow[]>("GET", `/api/observe/costly?range=${range}`),
  observeTrace: (id: string) => call<Trace>("GET", `/api/observe/questions/${encodeURIComponent(id)}/trace`),
  observeData: () => call<DataOverview>("GET", "/api/observe/db"),
  observeTable: (db: string, table: string, query: { offset: number; limit: number; q?: string; order?: string; dir?: "asc" | "desc" }) =>
    call<DbPage>("GET", `/api/observe/db/${encodeURIComponent(db)}/${encodeURIComponent(table)}?offset=${query.offset}&limit=${query.limit}&dir=${query.dir ?? "desc"}${query.q ? `&q=${encodeURIComponent(query.q)}` : ""}${query.order ? `&order=${encodeURIComponent(query.order)}` : ""}`),
  observeRow: (db: string, table: string, rowid: number) => call<DbRow>("GET", `/api/observe/db/${encodeURIComponent(db)}/${encodeURIComponent(table)}/${rowid}`),
  observeCall: (id: string) => call<CallDetail>("GET", `/api/observe/calls/${encodeURIComponent(id)}`),
  evidence: (task: string, handle: string) => call<Evidence>("GET", `/api/evidence?task=${encodeURIComponent(task)}&handle=${encodeURIComponent(handle)}`),
};

/** What the page changes in settings besides access and the working folder; the profile may be sent in part. */
export type SettingsPatch = Partial<Omit<Settings, "access" | "workingFolder" | "profile">> & { profile?: Partial<Settings["profile"]> };
