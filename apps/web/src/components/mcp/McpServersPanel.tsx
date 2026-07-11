"use client";

import { Cable, CheckCircle2, Clipboard, ExternalLink, FileJson2, Loader2, Pencil, Plus, RefreshCw, Server, SlidersHorizontal, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { McpServerConfigInput, McpServerScope, McpServerStatus } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { api } from "@/lib/api";

type McpServersPanelProps = {
  scope: McpServerScope;
  projectId?: string;
  title?: string;
  description?: string;
  variant?: "panel" | "section";
};

type FormState = {
  id: string;
  label: string;
  command: string;
  args: string;
  env: string;
  secretEnv: string;
};

const emptyForm: FormState = {
  id: "",
  label: "",
  command: "",
  args: "",
  env: "",
  secretEnv: "",
};

export function McpServersPanel({
  scope,
  projectId,
  title = scope === "global" ? "Global MCP servers" : "MCP servers",
  description = scope === "global"
    ? "Reusable tool servers available to Socrates across workspaces."
    : "Project MCP servers plus inherited global tools.",
  variant = "panel",
}: McpServersPanelProps) {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [paths, setPaths] = useState<{ configPath: string; envPath: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [checkingServerId, setCheckingServerId] = useState<string | null>(null);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [setupMode, setSetupMode] = useState<"import" | "manual">("import");
  const [importText, setImportText] = useState("");
  const [importedServers, setImportedServers] = useState<McpServerConfigInput[]>([]);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManageScope = scope === "global" || Boolean(projectId);
  const currentScopeServers = useMemo(() => servers.filter((server) => server.scope === scope), [scope, servers]);
  const inheritedServers = useMemo(() => servers.filter((server) => server.scope !== scope), [scope, servers]);

  const loadServers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.listMcpServers({
        ...(projectId ? { projectId } : {}),
        ...(scope === "global" ? { scope } : {}),
      });
      setServers(response.servers);
      setPaths(response.paths);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load MCP servers.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, scope]);

  const openForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setSetupMode("import");
    setImportText("");
    setImportedServers([]);
    setImportWarnings([]);
    setError(null);
    setMessage(null);
    setIsFormOpen(true);
  };

  const openConfigPath = async (target: "config" | "secrets") => {
    setError(null);
    try {
      const response = await api.openMcpConfig({ scope, target, ...(projectId ? { projectId } : {}) });
      setMessage(`Opened ${response.path} with your system editor.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open MCP configuration.");
    }
  };

  const saveServer = async () => {
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await saveAndCheck({
        id: form.id.trim(),
        ...(form.label.trim() ? { label: form.label.trim() } : {}),
        command: form.command.trim(),
        args: parseLines(form.args),
        env: parseEnv(form.env),
        secretEnv: parseEnv(form.secretEnv),
        enabled: false,
        requiresSecrets: Boolean(parseEnv(form.secretEnv)),
      });
      setServers((current) => [saved, ...current.filter((server) => !(server.id === saved.id && server.scope === saved.scope))]);
      setIsFormOpen(false);
      setMessage(`${saved.label} passed its MCP handshake and is enabled.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not validate and save MCP server.");
    } finally {
      setIsSaving(false);
    }
  };

  const editServer = async (server: McpServerStatus) => {
    if (server.scope !== scope || server.bundled) return;
    setBusyServerId(server.id);
    setError(null);
    try {
      const response = await api.getMcpServerConfig(server.id, { scope, ...(projectId ? { projectId } : {}) });
      setForm({
        id: response.server.id,
        label: response.server.label ?? "",
        command: response.server.command,
        args: formatLines(response.server.args),
        env: formatEnv(response.server.env),
        secretEnv: formatEnv(response.server.secretEnv),
      });
      setEditingId(server.id);
      setSetupMode("manual");
      setIsFormOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load MCP server configuration.");
    } finally {
      setBusyServerId(null);
    }
  };

  const saveAndCheck = async (server: McpServerConfigInput): Promise<McpServerStatus> => {
    const response = await api.upsertMcpServer({
        scope,
        ...(projectId ? { projectId } : {}),
        server: { ...server, enabled: false },
      });
    const checked = await api.checkMcpServer(response.server.id, {
      scope,
      ...(projectId ? { projectId } : {}),
      enableOnSuccess: true,
    });
    if (checked.server.status !== "available") {
      throw new Error(checked.warnings?.join(" ") || `${checked.server.label} failed its MCP handshake and remains disabled.`);
    }
    return checked.server;
  };

  const parseImport = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const parsed = await api.parseMcpConfig({ content: importText, format: "auto" });
      setImportedServers(parsed.servers);
      setImportWarnings(parsed.warnings);
    } catch (err) {
      setImportedServers([]);
      setError(err instanceof Error ? err.message : "Could not parse MCP configuration.");
    } finally {
      setIsSaving(false);
    }
  };

  const importServers = async () => {
    setIsSaving(true);
    setError(null);
    const validated: McpServerStatus[] = [];
    try {
      const conflict = importedServers.find((candidate) => servers.some((server) => server.scope === scope && server.id === candidate.id));
      if (conflict) throw new Error(`${conflict.id} already exists in this scope. Delete it first or use Manual editing.`);
      for (const server of importedServers) {
        try {
          validated.push(await saveAndCheck(server));
        } catch (err) {
          await api.deleteMcpServer(server.id, { scope, ...(projectId ? { projectId } : {}) }).catch(() => undefined);
          throw err;
        }
      }
      setServers((current) => [...validated, ...current.filter((item) => !validated.some((server) => server.id === item.id && server.scope === item.scope))]);
      setIsFormOpen(false);
      setMessage(`${validated.length} MCP server${validated.length === 1 ? "" : "s"} imported, checked, and enabled.`);
    } catch (err) {
      for (const server of validated) {
        await api.deleteMcpServer(server.id, { scope, ...(projectId ? { projectId } : {}) }).catch(() => undefined);
      }
      await loadServers();
      setError(err instanceof Error ? err.message : "Could not import MCP servers.");
    } finally {
      setIsSaving(false);
    }
  };

  const setEnabled = async (server: McpServerStatus, enabled: boolean) => {
    setBusyServerId(server.id);
    setError(null);
    setMessage(null);
    try {
      const response = await api.updateMcpServer(server.id, {
        scope: server.scope,
        ...(projectId ? { projectId } : {}),
        enabled,
      });
      setServers((current) =>
        current.map((item) => (item.id === response.server.id && item.scope === response.server.scope ? response.server : item)),
      );
      setMessage(`${response.server.label} ${enabled ? "enabled" : "disabled"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update MCP server.");
    } finally {
      setBusyServerId(null);
    }
  };

  const checkServer = async (server: McpServerStatus) => {
    setCheckingServerId(server.id);
    setError(null);
    setMessage(null);
    try {
      const response = await api.checkMcpServer(server.id, {
        scope: server.scope,
        ...(projectId ? { projectId } : {}),
        enableOnSuccess: server.scope === scope,
      });
      setServers((current) =>
        current.map((item) => (item.id === response.server.id && item.scope === response.server.scope ? response.server : item)),
      );
      setMessage(
        response.server.status === "available"
          ? `${response.server.label} is available with ${response.tools.length} tools.`
          : `${response.server.label} check returned ${response.server.status}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check MCP server.");
    } finally {
      setCheckingServerId(null);
    }
  };

  const deleteServer = async (server: McpServerStatus) => {
    if (server.bundled || server.scope !== scope) {
      return;
    }
    setBusyServerId(server.id);
    setError(null);
    setMessage(null);
    try {
      await api.deleteMcpServer(server.id, {
        scope: server.scope,
        ...(projectId ? { projectId } : {}),
      });
      setServers((current) => current.filter((item) => !(item.id === server.id && item.scope === server.scope)));
      setMessage(`${server.label} removed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete MCP server.");
    } finally {
      setBusyServerId(null);
    }
  };

  const content = (
    <>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Cable className="size-4 text-teal-700" />
            <h3 className="font-medium text-slate-950">{title}</h3>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadServers()}
            disabled={isLoading}
            className="h-8 rounded-lg px-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label="Refresh MCP servers"
          >
            <RefreshCw className={isLoading ? "size-4 animate-spin" : "size-4"} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={openForm}
            disabled={!canManageScope}
            className="h-8 rounded-lg px-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <Plus className="mr-1 size-4" />
            MCP +
          </Button>
        </div>
      </div>

      {message && <p className="mb-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs leading-5 text-teal-800">{message}</p>}
      {error && <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{error}</p>}

      {paths && (
        <div className="mb-4 space-y-1 border-y border-slate-100 py-3 text-xs text-slate-500">
          <PathLine label="Config" value={paths.configPath} onOpen={() => void openConfigPath("config")} />
          <PathLine label="Secrets" value={paths.envPath} onOpen={() => void openConfigPath("secrets")} />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-3 text-sm text-slate-500">
          <Loader2 className="size-4 animate-spin" />
          Loading MCP servers...
        </div>
      ) : (
        <div className="space-y-3">
          {currentScopeServers.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-sm leading-6 text-slate-500">
              No {scope} MCP servers configured yet.
            </p>
          )}
          {currentScopeServers.map((server) => (
            <McpServerRow
              key={`${server.scope}:${server.id}`}
              server={server}
              scope={scope}
              busy={busyServerId === server.id}
              checking={checkingServerId === server.id}
              onEnabledChange={(enabled) => void setEnabled(server, enabled)}
              onCheck={() => void checkServer(server)}
              onEdit={() => void editServer(server)}
              onDelete={() => void deleteServer(server)}
            />
          ))}

          {inheritedServers.length > 0 && (
            <div className="pt-1">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Inherited</div>
              <div className="space-y-3">
                {inheritedServers.map((server) => (
                  <McpServerRow
                    key={`${server.scope}:${server.id}`}
                    server={server}
                    scope={scope}
                    busy={busyServerId === server.id}
                    checking={checkingServerId === server.id}
                    onEnabledChange={(enabled) => void setEnabled(server, enabled)}
                    onCheck={() => void checkServer(server)}
                    onEdit={() => void editServer(server)}
                    onDelete={() => void deleteServer(server)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {isFormOpen && (
        <Modal
          title={scope === "global" ? "Add global MCP server" : "Add project MCP server"}
          description="Paste the configuration from an MCP provider, or enter a stdio command manually. Socrates will test it before enabling it."
          footer={
            <>
              <Button type="button" variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void (setupMode === "import" ? (importedServers.length ? importServers() : parseImport()) : saveServer())}
                disabled={isSaving || (setupMode === "import" ? !importText.trim() || importedServers.some((server) => Object.values(server.secretEnv ?? {}).some((value) => !value)) : !form.id.trim() || !form.command.trim())}
              >
                {isSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Server className="mr-2 size-4" />}
                {setupMode === "import" ? (importedServers.length ? `Test and add ${importedServers.length}` : "Review configuration") : "Test and add server"}
              </Button>
            </>
          }
        >
          <div className="mb-5 flex rounded-lg bg-slate-100 p-1">
            <button type="button" onClick={() => setSetupMode("import")} className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${setupMode === "import" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}>
              <FileJson2 className="size-4" /> Paste JSON or TOML
            </button>
            <button type="button" onClick={() => setSetupMode("manual")} className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${setupMode === "manual" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}>
              <SlidersHorizontal className="size-4" /> Manual
            </button>
          </div>

          {setupMode === "import" ? (
            <div className="space-y-4">
              <label className="block text-sm font-medium text-slate-800">
                MCP configuration
                <textarea
                  value={importText}
                  onChange={(event) => { setImportText(event.target.value); setImportedServers([]); setImportWarnings([]); }}
                  placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }\n  }\n}'}
                  rows={11}
                  className="mt-2 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs leading-5 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
                />
              </label>
              <p className="text-xs leading-5 text-slate-500">Accepts Claude/Cursor-style <code>mcpServers</code>, Codex TOML <code>mcp_servers</code>, and Socrates <code>servers</code>. Remote HTTP/SSE servers are rejected clearly; this runtime currently launches stdio servers.</p>
              {importWarnings.map((warning) => <p key={warning} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{warning}</p>)}
              {importedServers.map((server, serverIndex) => (
                <div key={server.id} className="border-t border-slate-200 pt-4">
                  <div className="flex items-start justify-between gap-3">
                    <div><div className="font-medium text-slate-950">{server.label ?? server.id}</div><div className="mt-1 font-mono text-xs text-slate-500">{server.command} {(server.args ?? []).join(" ")}</div></div>
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">Will test disabled</span>
                  </div>
                  {server.secretEnv && Object.keys(server.secretEnv).length > 0 && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {Object.entries(server.secretEnv).map(([key, value]) => (
                        <label key={key} className="text-xs font-medium text-slate-700">{key}
                          <input type="password" value={value} onChange={(event) => setImportedServers((current) => current.map((item, index) => index === serverIndex ? { ...item, secretEnv: { ...item.secretEnv, [key]: event.target.value } } : item))} placeholder="Required secret" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs outline-none focus:border-teal-700" />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-800">
              Server id
              <input
                value={form.id}
                disabled={Boolean(editingId)}
                onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))}
                placeholder="browser-tools"
                className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
              />
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Label
              <input
                value={form.label}
                onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                placeholder="Browser Tools"
                className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
              />
            </label>
            <label className="block text-sm font-medium text-slate-800 sm:col-span-2">
              Command
              <input
                value={form.command}
                onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))}
                placeholder="node"
                className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
              />
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Arguments
              <textarea
                value={form.args}
                onChange={(event) => setForm((current) => ({ ...current, args: event.target.value }))}
                placeholder={"server.js\n--stdio"}
                rows={5}
                className="mt-2 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs leading-5 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
              />
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Environment
              <textarea
                value={form.env}
                onChange={(event) => setForm((current) => ({ ...current, env: event.target.value }))}
                placeholder={"MODE=local\nLOG_LEVEL=info"}
                rows={5}
                className="mt-2 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs leading-5 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
              />
            </label>
            <label className="block text-sm font-medium text-slate-800 sm:col-span-2">
              Secrets
              <textarea value={form.secretEnv} onChange={(event) => setForm((current) => ({ ...current, secretEnv: event.target.value }))} placeholder={"API_KEY=value\nACCESS_TOKEN=value"} rows={3} className="mt-2 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs leading-5 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10" />
              <span className="mt-1 block text-xs font-normal leading-5 text-slate-500">Stored in the scope’s private <code>.env</code> file, never in <code>mcp.json</code>.</span>
            </label>
          </div>
          )}
        </Modal>
      )}
    </>
  );

  if (variant === "section") {
    return <section className="rounded-lg border border-slate-200 bg-white p-5">{content}</section>;
  }

  return <div className="border-b border-gray-200 py-6">{content}</div>;
}

function McpServerRow({
  server,
  scope,
  busy,
  checking,
  onEnabledChange,
  onCheck,
  onEdit,
  onDelete,
}: {
  server: McpServerStatus;
  scope: McpServerScope;
  busy: boolean;
  checking: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onCheck: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isInherited = server.scope !== scope;
  const canDelete = !server.bundled && !isInherited;
  return (
    <div className="rounded-lg border border-slate-100 bg-white px-3 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-slate-950">{server.label}</p>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              {server.scope}
            </span>
            {server.bundled && (
              <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-teal-800">
                bundled
              </span>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-slate-500">{server.id}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <StatusPill server={server} />
            {server.toolCount !== undefined && <span>{server.toolCount} tools</span>}
            {server.requiresSecrets && <span>requires secrets</span>}
          </div>
        </div>
        <Switch
          checked={server.enabled}
          disabled={busy || isInherited}
          ariaLabel={`Enable ${server.label}`}
          onCheckedChange={onEnabledChange}
        />
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onEdit} disabled={busy || !canDelete}>
          <Pencil className="mr-1 size-3.5" />
          Edit
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCheck} disabled={checking}>
          {checking ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 size-3.5" />}
          Check
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDelete}
          disabled={busy || !canDelete}
          className="text-red-600 hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="mr-1 size-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

function StatusPill({ server }: { server: McpServerStatus }) {
  if (server.status === "available") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 font-semibold text-teal-800">
        <CheckCircle2 className="size-3" />
        available
      </span>
    );
  }
  if (server.status === "failed" || server.status === "missing") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">
        <XCircle className="size-3" />
        {server.status}
      </span>
    );
  }
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">{server.status}</span>;
}

function PathLine({ label, value, onOpen }: { label: string; value: string; onOpen: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 font-medium text-slate-600">{label}</span>
      <code className="min-w-0 flex-1 truncate" title={value}>{value}</code>
      <button type="button" onClick={() => void navigator.clipboard.writeText(value)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={`Copy ${label.toLowerCase()} path`}>
        <Clipboard className="size-3.5" />
      </button>
      <button type="button" onClick={onOpen} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={`Open ${label.toLowerCase()} file`}>
        <ExternalLink className="size-3.5" />
      </button>
    </div>
  );
}

const parseLines = (value: string): string[] | undefined => {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
};

const formatLines = (value: string[] | undefined): string => value?.join("\n") ?? "";
const formatEnv = (value: Record<string, string> | undefined): string => Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join("\n");

const parseEnv = (value: string): Record<string, string> | undefined => {
  const entries = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      if (index < 0) {
        throw new Error(`Environment line "${line}" must use KEY=value.`);
      }
      const key = line.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Environment key "${key}" is invalid.`);
      return [key, line.slice(index + 1).trim()] as const;
    })
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
