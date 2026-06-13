"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Clock3, Cpu, FileCheck2, Route, Wrench } from "lucide-react";
import type { MemoryAgentRunDetail } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";

const sectionLabels = [
  ["investigated", "Investigated"],
  ["changed", "Changed"],
  ["skipped", "Skipped"],
  ["blocked", "Blocked"],
] as const;

export function MemoryRunDetailPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<MemoryAgentRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const response = await api.getMemoryAgentRun(runId);
        if (mounted) {
          setRun(response.run);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Could not load memory run.");
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [runId]);

  return (
    <main className="min-h-screen bg-[#f7f9fb] px-6 py-8 text-slate-950">
      <div className="mx-auto w-full max-w-5xl">
        <Button asChild variant="ghost" className="-ml-3 mb-5">
          <Link href="/memory">
            <ArrowLeft className="mr-2 size-4" />
            Back to Memory Center
          </Link>
        </Button>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {run ? (
          <>
            <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/50">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={statusClass(run.status)}>{run.status}</span>
                    <span className="text-sm font-medium text-slate-500">{run.trigger}</span>
                  </div>
                  <h1 className="mt-3 text-3xl font-serif text-slate-950">{run.title}</h1>
                  <p className="mt-2 text-sm text-slate-600">{run.displayReason ?? "Memory run detail."}</p>
                </div>
                <div className="grid min-w-64 gap-2 text-sm">
                  <RunFact icon={<Clock3 className="size-4" />} label="Started" value={formatDate(run.startedAt ?? "")} />
                  <RunFact icon={<Cpu className="size-4" />} label="Model" value={`${run.providerId} / ${run.modelId}`} />
                  <RunFact icon={<Route className="size-4" />} label="Sequence" value={`${run.sequenceFrom ?? "?"}-${run.sequenceTo ?? "?"}`} />
                </div>
              </div>
            </header>

            <section className="mt-6 grid gap-4 md:grid-cols-4">
              <MiniMetric label="Evidence turns" value={String(run.evidenceTurnCount)} />
              <MiniMetric label="Evidence estimate" value={`${run.evidenceTokensEstimate.toLocaleString()} tokens`} />
              <MiniMetric label="Run tokens" value={run.totalTokens ? run.totalTokens.toLocaleString() : "Not reported"} />
              <MiniMetric label="Cost" value={run.costUsd ? `$${run.costUsd.toFixed(4)}` : "Not reported"} />
            </section>

            <section className="mt-6 grid gap-4 md:grid-cols-2">
              {sectionLabels.map(([key, label]) => (
                <div key={key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-teal-700">{label}</h2>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">{run.summary[key].trim() || "None."}</p>
                </div>
              ))}
            </section>

            <section className="mt-6 grid gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50">
                <div className="flex items-center gap-2 text-lg font-semibold text-slate-950">
                  <FileCheck2 className="size-5 text-teal-700" />
                  Actions
                </div>
                <div className="mt-4 space-y-3">
                  {run.actions.length === 0 && <p className="text-sm text-slate-500">No file actions.</p>}
                  {run.actions.map((action) => (
                    <div key={action.id} className="rounded-xl border border-slate-100 px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-950">{action.targetKind}</span>
                        <span className={statusClass(action.status)}>{action.status}</span>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-500">{shortPath(action.targetPath)}</p>
                      {action.rationale && <p className="mt-2 text-sm leading-6 text-slate-600">{action.rationale}</p>}
                      {action.error && <p className="mt-2 text-sm leading-6 text-red-600">{action.error}</p>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50">
                <div className="flex items-center gap-2 text-lg font-semibold text-slate-950">
                  <Wrench className="size-5 text-teal-700" />
                  Tool Activity
                </div>
                <div className="mt-4 space-y-3">
                  {run.toolEvents.length === 0 && <p className="text-sm text-slate-500">No tool events recorded.</p>}
                  {run.toolEvents.map((event, index) => (
                    <ToolEventRow key={index} event={event} />
                  ))}
                </div>
              </div>
            </section>
          </>
        ) : !error ? (
          <div className="text-sm text-slate-500">Loading memory run...</div>
        ) : null}
      </div>
    </main>
  );
}

function RunFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
      <span className="text-teal-700">{icon}</span>
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <span className="ml-auto truncate text-xs text-slate-700">{value}</span>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/50">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-lg font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function ToolEventRow({ event }: { event: unknown }) {
  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  return (
    <div className="rounded-xl border border-slate-100 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-950">{typeof record.toolName === "string" ? record.toolName : "tool"}</span>
        <span className="text-xs text-slate-500">{typeof record.type === "string" ? record.type : "event"}</span>
      </div>
      {typeof record.summary === "string" && <p className="mt-2 text-sm text-slate-600">{record.summary}</p>}
      {typeof record.error === "string" && <p className="mt-2 text-sm text-red-600">{record.error}</p>}
    </div>
  );
}

const statusClass = (status: string): string => {
  if (status === "completed" || status === "applied") {
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

const formatDate = (value: string): string => (value ? new Date(value).toLocaleString() : "Unknown");

const shortPath = (value: string): string => value.replace(/^.*\/\.Socrates\//, "~/.Socrates/");
