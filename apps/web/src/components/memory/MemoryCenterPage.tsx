"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Bot, Brain, Clock3, Coins, FileText, FolderOpen, Loader2, Play, Plus, RefreshCw, Sparkles } from "lucide-react";
import type { GetMemoryAgentResponse, MemoryAgentFileSummary, MemoryAgentTimelineItem } from "@socrates/contracts";
import { BuildSkillDialog } from "@/components/dashboard/BuildSkillDialog";
import { MemoryFileViewer } from "@/components/memory/MemoryFileViewer";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";

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
  const [selectedFile, setSelectedFile] = useState<MemoryAgentFileSummary | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [isBuildingSkill, setIsBuildingSkill] = useState(false);
  const [showSkillDialog, setShowSkillDialog] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [memoryAgent, fileIndex] = await Promise.all([api.getMemoryAgent(), api.listMemoryAgentFiles()]);
    setOverview(memoryAgent);
    setFiles(fileIndex.files);
  };

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [memoryAgent, fileIndex] = await Promise.all([api.getMemoryAgent(), api.listMemoryAgentFiles()]);
        if (mounted) {
          setOverview(memoryAgent);
          setFiles(fileIndex.files);
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

  const runNow = async () => {
    setIsRunning(true);
    setMessage(null);
    setError(null);
    try {
      const result = await api.runMemoryAgent();
      await load();
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

  const buildGlobalSkill = async (request: string) => {
    setIsBuildingSkill(true);
    setMessage(null);
    setError(null);
    try {
      const response = await api.buildGlobalSkill({ request });
      await load();
      setShowSkillDialog(false);
      setMessage(`Created global skill: ${response.skill.name}`);
    } finally {
      setIsBuildingSkill(false);
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

  const tokenSummary = useMemo(() => {
    const runs = overview?.recentItems.filter((item) => item.itemType === "run") ?? [];
    const totalTokens = runs.reduce((sum, run) => sum + (run.totalTokens ?? 0), 0);
    const costUsd = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    return { totalTokens, costUsd };
  }, [overview?.recentItems]);

  const nextCheckAt = overview?.state.lastCheckedAt && overview.settings.enabled ? addMinutes(overview.state.lastCheckedAt, overview.settings.cadenceMinutes) : undefined;
  const groupedFiles = groupFiles(files);

  return (
    <main className="min-h-screen bg-[#f7f9fb] px-6 py-8 text-slate-950">
      <div className="mx-auto w-full max-w-6xl">
        <BackLink href="/projects" label="Back to projects" />
        <header className="mt-6 flex flex-col gap-5 border-b border-slate-200 pb-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-teal-700">
              <Brain className="size-4" />
              Global memory
            </div>
            <h1 className="mt-3 text-4xl font-serif text-slate-950">Memory Center</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Watch the global memory agent, inspect what it changed, and browse the files Socrates uses for durable personalization.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void load()} disabled={isLoading}>
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowSkillDialog(true)}>
              <Plus className="mr-2 size-4" />
              Skills +
            </Button>
            <Button type="button" onClick={() => void runNow()} disabled={isRunning || isLoading}>
              {isRunning ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
              Run now
            </Button>
          </div>
        </header>

        {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {message && <div className="mt-6 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">{message}</div>}

        {overview ? (
          <>
            <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard icon={<Bot className="size-5" />} label="Status" value={overview.state.status} detail={overview.settings.enabled ? "Enabled" : "Disabled"} />
              <MetricCard icon={<Clock3 className="size-5" />} label="Next check" value={nextCheckAt ? formatDate(nextCheckAt) : "Not scheduled"} detail={`Every ${overview.settings.cadenceMinutes} min`} />
              <MetricCard icon={<Sparkles className="size-5" />} label="Last real run" value={overview.state.lastRealRunAt ? formatDate(overview.state.lastRealRunAt) : "None yet"} detail={overview.state.lastCheckedAt ? `Checked ${formatDate(overview.state.lastCheckedAt)}` : "No checks yet"} />
              <MetricCard icon={<Coins className="size-5" />} label="Recent usage" value={`${tokenSummary.totalTokens.toLocaleString()} tokens`} detail={tokenSummary.costUsd > 0 ? `$${tokenSummary.costUsd.toFixed(4)}` : "No cost reported"} />
            </section>

            <section className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/50">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-950">Pending Signal</h2>
                    <p className="mt-1 text-sm text-slate-600">{overview.pending.displayReason}</p>
                  </div>
                  <span className={overview.pending.shouldRun ? "rounded-full bg-teal-100 px-3 py-1 text-xs font-semibold text-teal-800" : "rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600"}>
                    {overview.pending.shouldRun ? "Ready" : "Accumulating"}
                  </span>
                </div>
                <div className="mt-6 space-y-4">
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

              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/50">
                <h2 className="text-lg font-semibold text-slate-950">Memory Files</h2>
                <p className="mt-1 text-sm text-slate-600">Read-only global files and skills.</p>
                <div className="mt-5 space-y-5">
                  {Object.entries(groupedFiles).map(([group, groupFiles]) => (
                    <div key={group}>
                      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <FolderOpen className="size-4" />
                        {group}
                      </div>
                      <div className="space-y-2">
                        {groupFiles.map((file) => (
                          <button
                            key={file.id}
                            type="button"
                            onClick={() => void openFile(file)}
                            className="flex w-full items-start gap-3 rounded-lg border border-slate-100 px-3 py-2 text-left transition hover:border-teal-200 hover:bg-teal-50/50"
                          >
                            <FileText className="mt-0.5 size-4 shrink-0 text-teal-700" />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-slate-900">{file.name}</span>
                              <span className="block truncate text-xs text-slate-500">{file.description ?? file.path}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/50">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Timeline</h2>
                  <p className="mt-1 text-sm text-slate-600">Real model runs and low-cost checks.</p>
                </div>
              </div>
              <div className="mt-6 space-y-3">
                {overview.recentItems.length === 0 && <p className="text-sm text-slate-500">No memory checks yet.</p>}
                {overview.recentItems.map((item) => (
                  <TimelineRow key={item.id} item={item} />
                ))}
              </div>
            </section>
          </>
        ) : (
          <div className="mt-10 text-sm text-slate-500">Loading Memory Center...</div>
        )}
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

function MetricCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50">
      <div className="flex items-center gap-2 text-sm font-medium text-teal-700">{icon}{label}</div>
      <div className="mt-3 text-xl font-semibold text-slate-950">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{detail}</div>
    </div>
  );
}

function ThresholdBar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  const percent = Math.min(100, Math.round((value / max) * 100));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-slate-600">{label}</span>
        <span className="text-slate-500">{value.toLocaleString()}{suffix} / {max.toLocaleString()}{suffix}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function TimelineRow({ item }: { item: MemoryAgentTimelineItem }) {
  const time = item.startedAt ?? item.checkedAt ?? item.completedAt;
  const content = (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-100 px-4 py-3 transition hover:border-teal-200 hover:bg-teal-50/40 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={statusClass(item.status)}>{item.status}</span>
          <span className="text-sm font-medium text-slate-950">{item.title}</span>
        </div>
        <p className="mt-2 text-sm text-slate-600">{item.displayReason ?? `${item.trigger} / ${item.evidenceTurnCount} turns`}</p>
        <p className="mt-1 text-xs text-slate-500">
          {item.itemType} / {item.trigger} / seq {item.sequenceFrom ?? "?"}-{item.sequenceTo ?? "?"} / {item.evidenceTurnCount} turns
        </p>
      </div>
      <div className="text-xs text-slate-500">{time ? formatDate(time) : ""}</div>
    </div>
  );

  if (item.itemType === "run" && item.runId) {
    return <Link href={`/memory/runs/${encodeURIComponent(item.runId)}`}>{content}</Link>;
  }
  return content;
}

const groupFiles = (files: MemoryAgentFileSummary[]): Record<string, MemoryAgentFileSummary[]> => ({
  Soul: files.filter((file) => file.kind === "identity" || file.kind === "operating_principles"),
  "Tool Docs": files.filter((file) => file.kind === "tool_doc"),
  Skills: files.filter((file) => file.kind === "skill"),
});

const statusClass = (status: string): string => {
  if (status === "completed") {
    return "rounded-full bg-teal-100 px-2.5 py-1 text-xs font-semibold text-teal-800";
  }
  if (status === "failed") {
    return "rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700";
  }
  if (status === "running") {
    return "rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800";
  }
  return "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600";
};

const addMinutes = (value: string, minutes: number): string => new Date(Date.parse(value) + minutes * 60_000).toISOString();

const formatDate = (value: string): string => new Date(value).toLocaleString();
