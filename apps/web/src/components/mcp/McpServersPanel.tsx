"use client";

import { Cable, CheckCircle2, Loader2, Plus, RefreshCw, Server, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { McpServerScope, McpServerStatus } from "@socrates/contracts";
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
  enabled: boolean;
  requiresSecrets: boolean;
};

const emptyForm: FormState = {
  id: "",
  label: "",
  command: "",
  args: "",
  env: "",
  enabled: true,
  requiresSecrets: false,
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
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [checkingServerId, setCheckingServerId] = useState<string | null>(null);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load MCP servers.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, scope]);

  const openForm = () => {
    setForm(emptyForm);
    setError(null);
    setMessage(null);
    setIsFormOpen(true);
  };

  const saveServer = async () => {
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.upsertMcpServer({
        scope,
        ...(projectId ? { projectId } : {}),
        server: {
          id: form.id.trim(),
          ...(form.label.trim() ? { label: form.label.trim() } : {}),
          command: form.command.trim(),
          args: parseLines(form.args),
          env: parseEnv(form.env),
          enabled: form.enabled,
          requiresSecrets: form.requiresSecrets,
        },
      });
      setServers((current) => [response.server, ...current.filter((server) => !(server.id === response.server.id && server.scope === response.server.scope))]);
      setIsFormOpen(false);
      setMessage(`${response.server.label} saved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save MCP server.");
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
          description="Enter the server command Socrates should launch over stdio."
          footer={
            <>
              <Button type="button" variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void saveServer()} disabled={isSaving || !form.id.trim() || !form.command.trim()}>
                {isSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Server className="mr-2 size-4" />}
                Save server
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-800">
              Server id
              <input
                value={form.id}
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
                placeholder={"API_KEY=value\nMODE=local"}
                rows={5}
                className="mt-2 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs leading-5 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
              />
            </label>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
              <div>
                <div className="text-sm font-medium text-slate-900">Enabled</div>
                <div className="text-xs text-slate-500">Expose tools to Socrates.</div>
              </div>
              <Switch
                checked={form.enabled}
                ariaLabel="Enable MCP server"
                onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
              <div>
                <div className="text-sm font-medium text-slate-900">Requires secrets</div>
                <div className="text-xs text-slate-500">Mark servers that need private env.</div>
              </div>
              <Switch
                checked={form.requiresSecrets}
                ariaLabel="Mark MCP server as requiring secrets"
                onCheckedChange={(requiresSecrets) => setForm((current) => ({ ...current, requiresSecrets }))}
              />
            </div>
          </div>
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
  onDelete,
}: {
  server: McpServerStatus;
  scope: McpServerScope;
  busy: boolean;
  checking: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onCheck: () => void;
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
        <Button type="button" variant="outline" size="sm" onClick={onCheck} disabled={checking || !server.enabled}>
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

const parseLines = (value: string): string[] | undefined => {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
};

const parseEnv = (value: string): Record<string, string> | undefined => {
  const entries = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      if (index < 0) {
        return [line, ""] as const;
      }
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const;
    })
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
