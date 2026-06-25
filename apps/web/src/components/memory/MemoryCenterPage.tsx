"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  Brain,
  CalendarClock,
  Clock3,
  Coins,
  FileText,
  FolderOpen,
  Gauge,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import type {
  BuildGlobalSkillRequest,
  GetMemoryAgentResponse,
  MemoryAgentFileSummary,
  MemoryAgentGlobalSettings,
  MemoryAgentTimelineItem,
  ModelOption,
  ModelThinkingOption,
  ProviderId,
  UpdateMemoryAgentGlobalSettingsRequest,
} from "@socrates/contracts";
import { BuildSkillDialog } from "@/components/dashboard/BuildSkillDialog";
import { MemoryFileViewer } from "@/components/memory/MemoryFileViewer";
import { McpServersPanel } from "@/components/mcp/McpServersPanel";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { api } from "@/lib/api";

const cadenceOptions = [
  { value: 10, label: "Every 10 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every hour" },
  { value: 300, label: "Every 5 hours" },
  { value: 1440, label: "Once a day" },
];

const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
};

const thresholds = [
  { key: "fileChangeEvents", label: "File edits", max: 5 },
  { key: "distinctChangedFiles", label: "Changed files", max: 5 },
  { key: "toolCalls", label: "Tool calls", max: 10 },
  { key: "totalTokens", label: "Tokens", max: 5000 },
  { key: "turnCount", label: "Turns", max: 4 },
] as const;

export function MemoryCenterPage() {
  const [overview, setOverview] = useState<GetMemoryAgentResponse | null>(null);
  const [files, setFiles] = useState<MemoryAgentFileSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedFile, setSelectedFile] = useState<MemoryAgentFileSummary | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isBuildingSkill, setIsBuildingSkill] = useState(false);
  const [deletingSkillName, setDeletingSkillName] = useState<string | null>(null);
  const [showSkillDialog, setShowSkillDialog] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    const [memoryAgent, fileIndex, modelList] = await Promise.all([api.getMemoryAgent(), api.listMemoryAgentFiles(), api.listModels()]);
    setOverview(memoryAgent);
    setFiles(fileIndex.files);
    setModels(modelList.models);
  };

  const refreshNow = async () => {
    setIsLoading(true);
    setMessage(null);
    setError(null);
    try {
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh Memory Center.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [memoryAgent, fileIndex, modelList] = await Promise.all([api.getMemoryAgent(), api.listMemoryAgentFiles(), api.listModels()]);
        if (mounted) {
          setOverview(memoryAgent);
          setFiles(fileIndex.files);
          setModels(modelList.models);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Could not load Memory Center.");
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const saveSettings = async (input: UpdateMemoryAgentGlobalSettingsRequest) => {
    setIsSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await api.updateMemoryAgentSettings(input);
      setOverview((current) => (current ? { ...current, settings: response.settings } : current));
      setMessage("Memory agent settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save memory agent settings.");
    } finally {
      setIsSaving(false);
    }
  };

  const runNow = async () => {
    setIsRunning(true);
    setMessage(null);
    setError(null);
    try {
      const result = await api.runMemoryAgent();
      await loadData();
      setMessage(result.skippedReason ?? result.item?.displayReason ?? "Memory agent run completed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run memory agent.");
    } finally {
      setIsRunning(false);
    }
  };

  const openFile = async (file: MemoryAgentFileSummary) => {
    setSelectedFile(file);
    setFileContent("");
    setIsFileLoading(true);
    setCopiedPath(false);
    try {
      const result = await api.getMemoryAgentFileContent({ kind: file.kind, path: file.path, scope: file.scope });
      setSelectedFile(result.file);
      setFileContent(result.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read memory file.");
    } finally {
      setIsFileLoading(false);
    }
  };

  const buildGlobalSkill = async (input: BuildGlobalSkillRequest) => {
    setIsBuildingSkill(true);
    setMessage(null);
    setError(null);
    try {
      const response = await api.buildGlobalSkill(input);
      await loadData();
      setShowSkillDialog(false);
      setMessage(`Created global skill: ${response.skill.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build global skill.");
    } finally {
      setIsBuildingSkill(false);
    }
  };

  const deleteGlobalSkill = async (file: MemoryAgentFileSummary) => {
    if (file.kind !== "skill" || file.scope !== "global") {
      return;
    }
    setDeletingSkillName(file.name);
    setMessage(null);
    setError(null);
    try {
      const response = await api.deleteGlobalSkill(file.name);
      setFiles((current) => current.filter((item) => !(item.kind === "skill" && item.scope === "global" && item.name === response.deletedSkillName)));
      setSelectedFile((current) => (current?.kind === "skill" && current.name === response.deletedSkillName ? null : current));
      setFileContent("");
      setMessage(`Deleted global skill: ${response.deletedSkillName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete global skill.");
    } finally {
      setDeletingSkillName(null);
    }
  };

  const copySelectedPath = async () => {
    if (!selectedFile) {
      return;
    }
    await navigator.clipboard.writeText(selectedFile.absolutePath);
    setCopiedPath(true);
    window.setTimeout(() => setCopiedPath(false), 1200);
  };

  const settings = overview?.settings;
  const selectedModel = settings ? findModelForSettings(models, settings) : undefined;
  const selectedThinkingOption = settings && selectedModel ? findThinkingOptionForSettings(selectedModel, settings) : undefined;
  const modelKeyValue = selectedModel ? modelKey(selectedModel) : settings ? `${settings.providerId}:${settings.modelId}` : "";
  const thinkingValue = selectedThinkingOption?.id ?? "";
  const nextCheckAt = overview?.state.lastCheckedAt && settings?.enabled ? addMinutes(overview.state.lastCheckedAt, settings.cadenceMinutes) : undefined;
  const groupedFiles = groupFiles(files);

  const tokenSummary = useMemo(() => {
    const runs = overview?.recentItems.filter((item) => item.itemType === "run") ?? [];
    const totalTokens = runs.reduce((sum, run) => sum + (run.totalTokens ?? 0), 0);
    const costUsd = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    return {
      totalTokens,
      costUsd,
      runCount: runs.length,
      checkCount: overview ? overview.recentItems.length - runs.length : 0,
    };
  }, [overview]);

  return (
    <main className="flex h-screen overflow-hidden bg-brand-bg text-slate-950">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex-none border-b border-slate-200 bg-white/95 px-4 py-3 sm:px-6">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <Link href="/projects" className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-slate-900">
                <ArrowLeft className="size-4" />
                Back to projects
              </Link>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                  <Brain className="size-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold text-slate-950 sm:text-2xl">Memory Center</h1>
                  <p className="mt-0.5 hidden text-sm text-slate-600 sm:block">Global memory agent controls, durable files, and run history.</p>
                </div>
                {overview && <span className={statusClass(overview.state.status)}>{overview.state.status}</span>}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 lg:flex lg:flex-wrap lg:justify-end">
              <Button type="button" variant="outline" onClick={() => void refreshNow()} disabled={isLoading} className="min-w-0 px-2 sm:px-6">
                <RefreshCw className={isLoading ? "mr-2 size-4 animate-spin" : "mr-2 size-4"} />
                Refresh
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowSkillDialog(true)} className="min-w-0 px-2 sm:px-6">
                <Plus className="mr-2 size-4" />
                Skills +
              </Button>
              <Button type="button" onClick={() => void runNow()} disabled={isRunning || isLoading} className="min-w-0 px-2 sm:px-6">
                {isRunning ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
                Run now
              </Button>
            </div>
          </div>
        </header>

        <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6" data-memory-scroll-region>
          <div className="mx-auto grid min-h-full w-full max-w-7xl gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-4">
              {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
              {message && <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">{message}</div>}

              {overview && settings ? (
                <>
                  <section className="rounded-lg border border-slate-200 bg-white">
                    <div className="grid gap-px overflow-hidden rounded-lg bg-slate-100 sm:grid-cols-2 2xl:grid-cols-4">
                      <MetricCell icon={<Bot className="size-4" />} label="Agent" value={overview.state.status} detail={settings.enabled ? "Automatic checks enabled" : "Automatic checks paused"} />
                      <MetricCell icon={<CalendarClock className="size-4" />} label="Next check" value={nextCheckAt ? formatDate(nextCheckAt) : settings.enabled ? "Pending" : "Disabled"} detail={`Cadence: ${cadenceLabel(settings.cadenceMinutes)}`} />
                      <MetricCell icon={<Sparkles className="size-4" />} label="Last real run" value={overview.state.lastRealRunAt ? formatDate(overview.state.lastRealRunAt) : "None yet"} detail={overview.state.lastCheckedAt ? `Checked ${formatDate(overview.state.lastCheckedAt)}` : "No checks yet"} />
                      <MetricCell icon={<Coins className="size-4" />} label="Recent usage" value={`${tokenSummary.totalTokens.toLocaleString()} tokens`} detail={tokenSummary.costUsd > 0 ? `$${tokenSummary.costUsd.toFixed(4)} across ${tokenSummary.runCount} runs` : `${tokenSummary.checkCount} checks`} />
                    </div>
                  </section>

                  <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="rounded-lg border border-slate-200 bg-white p-5">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                            <Gauge className="size-4 text-teal-700" />
                            Pending signal
                          </div>
                          <p className="mt-1 text-sm leading-6 text-slate-600">{overview.pending.displayReason}</p>
                        </div>
                        <span className={overview.pending.shouldRun ? "rounded-full bg-teal-100 px-3 py-1 text-xs font-semibold text-teal-800" : "rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600"}>
                          {overview.pending.shouldRun ? "Ready" : "Accumulating"}
                        </span>
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        {thresholds.map((threshold) => (
                          <ThresholdBar
                            key={threshold.key}
                            label={threshold.label}
                            value={overview.pending[threshold.key]}
                            max={threshold.max}
                            suffix={threshold.key === "totalTokens" ? " tokens" : ""}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-white p-5">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                        <Settings2 className="size-4 text-teal-700" />
                        Agent settings
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-600">Model, thinking, cadence, and scheduled checks live here.</p>

                      <div className="mt-4 space-y-4">
                        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                          <div>
                            <div className="text-sm font-medium text-slate-900">Scheduled checks</div>
                            <div className="text-xs text-slate-500">{settings.enabled ? "Memory checks run automatically." : "Automatic checks are paused."}</div>
                          </div>
                          <Switch
                            checked={settings.enabled}
                            disabled={isSaving}
                            ariaLabel="Enable memory agent"
                            onCheckedChange={(checked) => void saveSettings({ enabled: checked })}
                          />
                        </div>

                        <label className="block text-sm font-medium text-slate-800">
                          Model
                          <select
                            value={modelKeyValue}
                            onChange={(event) => {
                              const nextModel = models.find((model) => modelKey(model) === event.target.value);
                              const thinkingOption = nextModel
                                ? nextModel.thinkingOptions.find((option) => option.id === nextModel.defaultThinkingOptionId) ?? nextModel.thinkingOptions[0]
                                : undefined;
                              if (nextModel && thinkingOption) {
                                void saveSettings({
                                  providerId: nextModel.providerId,
                                  modelId: nextModel.modelId,
                                  thinkingEnabled: thinkingOption.enabled,
                                  ...(thinkingOption.effort ? { thinkingEffort: thinkingOption.effort } : {}),
                                });
                              }
                            }}
                            disabled={models.length === 0 || isSaving}
                            className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10 disabled:bg-slate-50 disabled:text-slate-500"
                          >
                            {models.length === 0 && <option value={modelKeyValue}>{modelLabel(settings, selectedModel)}</option>}
                            {models.map((model) => (
                              <option key={modelKey(model)} value={modelKey(model)}>
                                {model.label} ({model.providerLabel})
                              </option>
                            ))}
                          </select>
                        </label>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="block text-sm font-medium text-slate-800">
                            Cadence
                            <select
                              value={settings.cadenceMinutes}
                              onChange={(event) => void saveSettings({ cadenceMinutes: Number(event.target.value) })}
                              disabled={isSaving}
                              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
                            >
                              {cadenceOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          {selectedModel && (
                            <label className="block text-sm font-medium text-slate-800">
                              Thinking
                              <select
                                value={thinkingValue}
                                onChange={(event) => {
                                  const option = selectedModel.thinkingOptions.find((item) => item.id === event.target.value);
                                  if (option) {
                                    void saveSettings({
                                      thinkingEnabled: option.enabled,
                                      ...(option.effort ? { thinkingEffort: option.effort } : {}),
                                    });
                                  }
                                }}
                                disabled={isSaving}
                                className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/10"
                              >
                                {selectedModel.thinkingOptions.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-lg border border-slate-200 bg-white p-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h2 className="text-lg font-semibold text-slate-950">Timeline</h2>
                        <p className="mt-1 text-sm text-slate-600">Real model runs and low-cost checks, newest first.</p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                        {tokenSummary.runCount} runs / {tokenSummary.checkCount} checks
                      </span>
                    </div>
                    <div className="mt-5 space-y-3">
                      {overview.recentItems.length === 0 && <p className="text-sm text-slate-500">No memory checks yet.</p>}
                      {overview.recentItems.map((item) => (
                        <TimelineRow key={item.id} item={item} />
                      ))}
                    </div>
                  </section>

                  <McpServersPanel
                    scope="global"
                    title="Global MCP servers"
                    description="Bundled and user-added MCP servers available to Socrates in every workspace."
                    variant="section"
                  />
                </>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-500">Loading Memory Center...</div>
              )}
            </div>

            <aside className="min-h-0 rounded-lg border border-slate-200 bg-white xl:sticky xl:top-0 xl:max-h-full">
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-950">Memory files</h2>
                  <p className="mt-1 text-sm text-slate-600">Read-only global files and skills.</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{files.length} files</span>
              </div>

              <div className="max-h-[40rem] overflow-y-auto px-4 py-4 xl:max-h-[calc(100vh-17rem)]">
                {Object.entries(groupedFiles).map(([group, groupFiles]) => (
                  <div key={group} className="mb-5 last:mb-0">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <span className="flex items-center gap-2">
                        <FolderOpen className="size-4" />
                        {group}
                      </span>
                      <span>{groupFiles.length}</span>
                    </div>
                    <div className="space-y-2">
                      {groupFiles.length === 0 && <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-sm text-slate-500">No files in this group.</p>}
                      {groupFiles.map((file) => (
                        <div
                          key={file.id}
                          className={file.id === selectedFile?.id ? "flex items-start gap-2 rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 transition" : "flex items-start gap-2 rounded-lg border border-slate-100 px-3 py-2 transition hover:border-teal-200 hover:bg-teal-50/50"}
                        >
                          <button type="button" onClick={() => void openFile(file)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                            <FileIcon file={file} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-slate-900">{file.name}</span>
                              <span className="block truncate text-xs text-slate-500">{file.description ?? file.path}</span>
                              {file.updatedAt && <span className="mt-1 block text-[11px] text-slate-400">Updated {formatDate(file.updatedAt)}</span>}
                            </span>
                          </button>
                          {file.kind === "skill" && file.scope === "global" && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => void deleteGlobalSkill(file)}
                              disabled={deletingSkillName === file.name}
                              className="h-8 shrink-0 rounded-lg px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                              aria-label={`Delete ${file.name}`}
                            >
                              {deletingSkillName === file.name ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </section>

        <footer className="flex-none border-t border-slate-200 bg-white px-4 py-2 sm:px-6">
          <div className="mx-auto grid w-full max-w-7xl gap-2 text-xs text-slate-600 sm:grid-cols-4">
            <FooterFact icon={<Clock3 className="size-3.5" />} label="Last checked" value={overview?.state.lastCheckedAt ? formatDate(overview.state.lastCheckedAt) : "Never"} />
            <FooterFact icon={<Activity className="size-3.5" />} label="Last real run" value={overview?.state.lastRealRunAt ? formatDate(overview.state.lastRealRunAt) : "None yet"} />
            <FooterFact icon={<CalendarClock className="size-3.5" />} label="Next check" value={nextCheckAt ? formatDate(nextCheckAt) : settings?.enabled ? "Pending" : "Disabled"} />
            <FooterFact icon={<Bot className="size-3.5" />} label="Model" value={settings ? modelLabel(settings, selectedModel) : "Loading"} />
          </div>
        </footer>
      </div>

      <MemoryFileViewer
        file={selectedFile}
        content={fileContent}
        isLoading={isFileLoading}
        copied={copiedPath}
        onCopyPath={() => void copySelectedPath()}
        onClose={() => setSelectedFile(null)}
      />

      {showSkillDialog && (
        <BuildSkillDialog
          title="Build global skill"
          description="Describe the reusable Socrates workflow to save globally."
          formId="global-skill-form"
          placeholder="Create a skill for how Socrates should handle recurring repo-memory architecture decisions."
          isBuilding={isBuildingSkill}
          onCancel={() => setShowSkillDialog(false)}
          onBuild={buildGlobalSkill}
        />
      )}
    </main>
  );
}

function MetricCell({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-white p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-teal-700">
        {icon}
        {label}
      </div>
      <div className="mt-2 break-words text-lg font-semibold leading-6 text-slate-950">{value}</div>
      <div className="mt-1 break-words text-xs leading-5 text-slate-500">{detail}</div>
    </div>
  );
}

function ThresholdBar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  const percent = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="shrink-0 text-slate-500">
          {value.toLocaleString()}{suffix} / {max.toLocaleString()}{suffix}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function TimelineRow({ item }: { item: MemoryAgentTimelineItem }) {
  const time = item.startedAt ?? item.checkedAt ?? item.completedAt;
  const content = (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-100 px-4 py-3 transition hover:border-teal-200 hover:bg-teal-50/40 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={statusClass(item.status)}>{item.status}</span>
          <span className="text-sm font-medium text-slate-950">{item.title}</span>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">{item.displayReason ?? `${item.trigger} / ${item.evidenceTurnCount} turns`}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
          <span>{item.itemType}</span>
          <span>{item.trigger}</span>
          <span>seq {item.sequenceFrom ?? "?"}-{item.sequenceTo ?? "?"}</span>
          <span>{item.evidenceTurnCount} turns</span>
          {item.totalTokens ? <span>{item.totalTokens.toLocaleString()} tokens</span> : null}
        </div>
      </div>
      <div className="shrink-0 text-xs text-slate-500">{time ? formatDate(time) : ""}</div>
    </div>
  );

  if (item.itemType === "run" && item.runId) {
    return <Link href={`/memory/runs/${encodeURIComponent(item.runId)}`}>{content}</Link>;
  }
  return content;
}

function FooterFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-teal-700">{icon}</span>
      <span className="shrink-0 font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <span className="truncate text-slate-700">{value}</span>
    </div>
  );
}

function FileIcon({ file }: { file: MemoryAgentFileSummary }) {
  if (file.kind === "user_profile") {
    return <UserRound className="mt-0.5 size-4 shrink-0 text-teal-700" />;
  }
  return <FileText className="mt-0.5 size-4 shrink-0 text-teal-700" />;
}

const groupFiles = (files: MemoryAgentFileSummary[]): Record<string, MemoryAgentFileSummary[]> => ({
  "Core Memory": files.filter((file) => file.kind === "identity" || file.kind === "operating_principles" || file.kind === "user_profile"),
  "Tool Docs": files.filter((file) => file.kind === "tool_doc"),
  Skills: files.filter((file) => file.kind === "skill"),
});

const modelKey = (model: Pick<ModelOption, "providerId" | "modelId">): string => `${model.providerId}:${model.modelId}`;

const findModelForSettings = (models: ModelOption[], settings: Pick<MemoryAgentGlobalSettings, "providerId" | "modelId">): ModelOption | undefined =>
  models.find((model) => model.providerId === settings.providerId && model.modelId === settings.modelId);

const findThinkingOptionForSettings = (
  model: ModelOption,
  settings: Pick<MemoryAgentGlobalSettings, "thinkingEnabled" | "thinkingEffort">,
): ModelThinkingOption | undefined =>
  model.thinkingOptions.find((option) => option.enabled === settings.thinkingEnabled && option.effort === settings.thinkingEffort) ??
  (!settings.thinkingEnabled ? model.thinkingOptions.find((option) => !option.enabled) : undefined) ??
  (settings.thinkingEnabled && (!settings.thinkingEffort || settings.thinkingEffort === "none")
    ? model.thinkingOptions.find((option) => option.enabled && !option.effort)
    : undefined);

const modelLabel = (settings: MemoryAgentGlobalSettings, model?: ModelOption): string =>
  model ? `${model.providerLabel} / ${model.label}` : `${providerLabels[settings.providerId]} / ${settings.modelId}`;

const cadenceLabel = (minutes: number): string => cadenceOptions.find((option) => option.value === minutes)?.label ?? `Every ${minutes} min`;

const statusClass = (status: string): string => {
  if (status === "completed" || status === "idle" || status === "applied") {
    return "rounded-full bg-teal-100 px-2.5 py-1 text-xs font-semibold text-teal-800";
  }
  if (status === "failed" || status === "rejected") {
    return "rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700";
  }
  if (status === "running" || status === "awaiting_confirmation") {
    return "rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800";
  }
  return "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600";
};

const addMinutes = (value: string, minutes: number): string => new Date(Date.parse(value) + minutes * 60_000).toISOString();

const formatDate = (value: string): string => new Date(value).toLocaleString();
