import { useEffect, useMemo } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  PanelRightOpen,
  LoaderCircle,
  PanelRightClose,
  SquareTerminal,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getWorkerProgressLabel,
  getWorkerTraceSummary,
  type WorkerTraceRun,
  type WorkerToolStatus,
} from '@/lib/workerTrace'

interface WorkerTracePanelProps {
  worker: WorkerTraceRun | null
  mode: 'open' | 'collapsed' | 'hidden'
  onModeChange: (mode: 'open' | 'collapsed' | 'hidden') => void
  className?: string
}

export function WorkerTracePanel({ worker, mode, onModeChange, className }: WorkerTracePanelProps) {
  useEffect(() => {
    if (worker?.status === 'running' && mode === 'hidden') {
      onModeChange('collapsed')
    }
  }, [mode, onModeChange, worker?.status])

  const visibleTools = useMemo(() => {
    if (!worker) return []
    return worker.tools.slice(-8).reverse()
  }, [worker])

  if (!worker) {
    return null
  }

  const progressLabel = getWorkerProgressLabel(worker.progress)
  const summary = getWorkerTraceSummary(worker)
  const terminal = worker.status === 'completed' || worker.status === 'blocked' || worker.status === 'failed'
  const expanded = mode === 'open'

  if (mode === 'hidden') {
    return (
      <aside className={cn('flex justify-end', className)}>
        <button
          type="button"
          onClick={() => onModeChange('collapsed')}
          className="inline-flex items-center gap-2 rounded-full border border-forest/12 bg-paper/96 px-3 py-2 text-xs font-semibold text-forest shadow-sm transition hover:bg-white"
        >
          <PanelRightOpen className="size-3.5" />
          Worker trace
        </button>
      </aside>
    )
  }

  return (
    <aside className={cn('w-full', className)}>
      <div className="overflow-hidden rounded-[1.1rem] border border-forest/12 bg-paper/96 shadow-sm">
        <button
          type="button"
          onClick={() => onModeChange(expanded ? 'collapsed' : 'open')}
          aria-expanded={expanded}
          className="flex w-full items-start gap-3 px-3 py-3 text-left transition hover:bg-sage/20 sm:px-4"
        >
          <WorkerPanelStatusIcon status={worker.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-moss">Worker trace</p>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]',
                  worker.status === 'running'
                    ? 'bg-sage/70 text-forest'
                    : worker.status === 'completed'
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-red-50 text-red-700',
                )}
              >
                {worker.status}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-ink">{summary}</p>
            {progressLabel ? <p className="mt-1 text-[11px] font-medium text-moss">{progressLabel}</p> : null}
          </div>
          <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-white/70 text-moss">
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
        </button>

        {expanded ? (
          <div className="max-h-[34vh] overflow-y-auto border-t border-forest/10 px-3 py-3 sm:max-h-[42vh] sm:px-4">
            <div className="rounded-[1rem] bg-sage/30 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-moss">Current todo</p>
              {worker.currentItem ? (
                <div className="mt-2">
                  <p className="text-sm font-semibold text-forest">
                    {worker.currentItem.id}: {worker.currentItem.text}
                  </p>
                  <p className="mt-1 text-xs capitalize text-ink-soft">{worker.currentItem.status.replaceAll('_', ' ')}</p>
                </div>
              ) : (
                <p className="mt-2 text-sm leading-5 text-ink-soft">
                  {terminal ? 'Worker has finished its current handoff.' : 'Waiting for the worker to claim the next todo item.'}
                </p>
              )}
            </div>

            {worker.warnings.length ? (
              <div className="mt-3 space-y-2">
                {worker.warnings.slice(-3).map((warning, index) => (
                  <div key={`${warning}:${index}`} className="rounded-[0.95rem] bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                    {warning}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mt-3 space-y-2">
              {visibleTools.length ? (
                visibleTools.map((tool) => <WorkerToolRow key={tool.toolCallId} tool={tool} />)
              ) : (
                <div className="rounded-[0.95rem] bg-canvas/80 px-3 py-3 text-sm text-ink-soft">
                  Worker tools will appear here as they run.
                </div>
              )}
            </div>

            {worker.result ? (
              <details className="mt-3 rounded-[0.95rem] bg-white/76 px-3 py-2.5">
                <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-[0.18em] text-moss">
                  Result detail
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded-[0.8rem] bg-canvas/80 p-3 text-[12px] leading-5 text-ink-soft">
                  {formatDetail(worker.result)}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between border-t border-forest/10 px-4 py-2.5">
          <p className="text-[11px] text-ink-soft">
            {terminal ? 'Trace saved with the run.' : 'Live worker activity'}
          </p>
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-ink-soft" onClick={() => onModeChange('hidden')}>
            <PanelRightClose className="size-3.5" />
            Hide
          </Button>
        </div>
      </div>
    </aside>
  )
}

function WorkerToolRow({ tool }: { tool: WorkerTraceRun['tools'][number] }) {
  return (
    <div className="rounded-[0.95rem] bg-canvas/82 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <WorkerToolStatusIcon status={tool.status} />
            <p className="min-w-0 truncate text-sm font-medium text-forest">{tool.label}</p>
          </div>
          {tool.resultSummary ? <p className="mt-1 pl-6 text-xs leading-5 text-ink-soft">{tool.resultSummary}</p> : null}
        </div>
        <span className="shrink-0 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-moss">
          {tool.status === 'running' ? 'Running' : tool.status === 'failed' ? 'Failed' : 'Done'}
        </span>
      </div>
      {tool.arguments || tool.rawResult ? (
        <details className="mt-2 pl-6">
          <summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.16em] text-moss">
            Raw detail
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded-[0.75rem] bg-white/80 p-2.5 text-[11px] leading-4 text-ink-soft">
            {formatDetail({ arguments: tool.arguments, result: tool.rawResult })}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function WorkerPanelStatusIcon({ status }: { status: WorkerTraceRun['status'] }) {
  if (status === 'running') {
    return <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-moss" />
  }
  if (status === 'failed' || status === 'blocked') {
    return <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-600" />
  }
  return <SquareTerminal className="mt-0.5 size-5 shrink-0 text-forest" />
}

function WorkerToolStatusIcon({ status }: { status: WorkerToolStatus }) {
  if (status === 'running') {
    return <LoaderCircle className="size-4 shrink-0 animate-spin text-moss" />
  }
  if (status === 'failed') {
    return <AlertCircle className="size-4 shrink-0 text-red-600" />
  }
  return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
}

function formatDetail(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
