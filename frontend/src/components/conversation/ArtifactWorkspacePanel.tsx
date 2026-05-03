import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  File,
  FileImage,
  Folder,
  GripVertical,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  TaskArtifact,
  TaskWorkspaceFilePreview,
  TaskWorkspaceRoot,
  TaskWorkspaceTree,
} from '@/types/api'

export type ArtifactPanelMode = 'open' | 'collapsed'

const DEFAULT_PANEL_WIDTH = 430
const MIN_PANEL_WIDTH = 360
const MAX_PANEL_WIDTH = 760
const MIN_CHAT_WIDTH = 560
const PANEL_WIDTH_STORAGE_KEY = 'artifact-workspace-panel-width'

interface ArtifactWorkspacePanelProps {
  taskId: string | null
  tree: TaskWorkspaceTree | null
  preview: TaskWorkspaceFilePreview | null
  artifacts: TaskArtifact[]
  workspaceRoot: string | null
  selectedPath: string | null
  mode: ArtifactPanelMode
  loadingPreview: boolean
  onSelectPath: (path: string) => void
  onModeChange: (mode: ArtifactPanelMode) => void
  onCloseMobile?: () => void
  mobile?: boolean
}

export function ArtifactWorkspacePanel({
  taskId,
  tree,
  preview,
  artifacts,
  workspaceRoot,
  selectedPath,
  mode,
  loadingPreview,
  onSelectPath,
  onModeChange,
  onCloseMobile,
  mobile = false,
}: ArtifactWorkspacePanelProps) {
  const dragStartRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const displayTree = useMemo(() => buildDisplayTree(tree, artifacts), [artifacts, tree])
  const hasFiles = displayTree.roots.some((root) => root.entries.some((entry) => !entry.is_dir))
  const [panelWidth, setPanelWidth] = useState(() => readPersistedPanelWidth())

  const clampPanelWidth = useCallback((nextWidth: number) => {
    if (typeof window === 'undefined') {
      return clamp(nextWidth, MIN_PANEL_WIDTH, DEFAULT_PANEL_WIDTH)
    }

    const viewportMax = Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_CHAT_WIDTH)
    return clamp(nextWidth, MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, viewportMax))
  }, [])

  useEffect(() => {
    if (mobile) return

    setPanelWidth((current) => clampPanelWidth(current))

    const handleResize = () => {
      setPanelWidth((current) => {
        const clamped = clampPanelWidth(current)
        writePersistedPanelWidth(clamped)
        return clamped
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [clampPanelWidth, mobile])

  const commitPanelWidth = useCallback(
    (nextWidth: number) => {
      const clamped = clampPanelWidth(nextWidth)
      setPanelWidth(clamped)
      writePersistedPanelWidth(clamped)
    },
    [clampPanelWidth],
  )

  const stopResize = useCallback(() => {
    dragStartRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragStartRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: panelWidth,
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [panelWidth],
  )

  const resizePanel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragStart = dragStartRef.current
      if (!dragStart || dragStart.pointerId !== event.pointerId) return

      const delta = dragStart.startX - event.clientX
      commitPanelWidth(dragStart.startWidth + delta)
    },
    [commitPanelWidth],
  )

  if (!taskId) return null

  if (mode === 'collapsed' && !mobile) {
    return (
      <aside className="hidden h-full w-12 shrink-0 border-l border-forest/10 bg-paper/72 lg:flex">
        <button
          type="button"
          onClick={() => onModeChange('open')}
          className="flex h-full w-full flex-col items-center justify-start gap-3 px-2 py-5 text-moss transition hover:bg-sage/20 hover:text-forest"
          aria-label="Open artifacts"
        >
          <PanelRightOpen className="size-4" />
          <span className="[writing-mode:vertical-rl] rotate-180 text-[11px] font-semibold uppercase tracking-[0.18em]">
            Artifacts
          </span>
        </button>
      </aside>
    )
  }

  return (
    <aside
      className={cn(
        mobile
          ? 'fixed inset-x-0 bottom-0 z-50 max-h-[82vh] rounded-t-[1.35rem] border-t border-forest/12 bg-paper shadow-[0_-24px_80px_rgba(27,53,41,0.22)]'
          : 'relative hidden h-full shrink-0 border-l border-forest/10 bg-paper/86 lg:flex',
        'min-w-0 flex-col overflow-hidden',
      )}
      style={mobile ? undefined : { width: panelWidth }}
    >
      {!mobile ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace panel"
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={resizePanel}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              commitPanelWidth(panelWidth + 24)
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              commitPanelWidth(panelWidth - 24)
            }
          }}
          className="group absolute inset-y-0 left-0 z-20 w-4 -translate-x-2 cursor-col-resize touch-none outline-none"
        >
          <div className="mx-auto h-full w-px bg-forest/12 transition group-hover:bg-forest/22" />
          <div className="absolute left-1/2 top-1/2 flex h-12 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-forest/14 bg-paper text-moss shadow-[0_10px_28px_rgba(27,53,41,0.16)] transition hover:border-forest/28 hover:bg-sage/20 hover:text-forest focus-visible:border-forest/35">
            <GripVertical className="size-3.5" />
          </div>
        </div>
      ) : null}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-forest/10 px-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-moss">Workspace</p>
          <p className="truncate text-sm font-semibold text-forest">{selectedPath ?? 'Task files'}</p>
        </div>
        <div className="flex items-center gap-1">
          {!mobile ? (
            <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => onModeChange('collapsed')}>
              <PanelRightClose className="size-4" />
            </Button>
          ) : null}
          {mobile && onCloseMobile ? (
            <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onCloseMobile}>
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(150px,0.9fr)_minmax(0,1.4fr)]">
        <div className="min-w-0 overflow-y-auto border-r border-forest/10 bg-canvas/44 px-3 py-3">
          {!hasFiles ? (
            <div className="rounded-[0.95rem] border border-dashed border-forest/18 px-3 py-5 text-center text-xs leading-5 text-ink-soft">
              Files will appear here as Socrates works.
            </div>
          ) : (
            <div className="space-y-3">
              {displayTree.roots.map((root) => (
                <WorkspaceRoot
                  key={root.path}
                  root={root}
                  selectedPath={selectedPath}
                  onSelectPath={onSelectPath}
                />
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 overflow-y-auto px-4 py-4">
          {loadingPreview ? (
            <p className="text-sm text-ink-soft">Loading preview...</p>
          ) : preview ? (
            <FilePreview
              preview={preview}
              workspaceRoot={workspaceRoot}
            />
          ) : selectedPath ? (
            <SelectedPathFallback selectedPath={selectedPath} workspaceRoot={workspaceRoot} />
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <div className="max-w-[220px]">
                <Folder className="mx-auto size-8 text-moss/70" />
                <p className="mt-3 text-sm font-medium text-forest">Select a file</p>
                <p className="mt-1 text-xs leading-5 text-ink-soft">Open inputs, work files, and outputs from this task workspace.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function readPersistedPanelWidth() {
  if (typeof window === 'undefined') {
    return DEFAULT_PANEL_WIDTH
  }

  const parsed = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY))
  return Number.isFinite(parsed)
    ? clamp(parsed, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH)
    : DEFAULT_PANEL_WIDTH
}

function writePersistedPanelWidth(width: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width))
}

function buildDisplayTree(tree: TaskWorkspaceTree | null, artifacts: TaskArtifact[]): TaskWorkspaceTree {
  const roots = tree?.roots.map((root) => ({ ...root, entries: [...root.entries] })) ?? [
    { path: 'inputs', name: 'inputs', entries: [] },
    { path: 'work', name: 'work', entries: [] },
    { path: 'outputs', name: 'outputs', entries: [] },
  ]
  const entriesByPath = new Map(roots.flatMap((root) => root.entries.map((entry) => [entry.path, entry])))

  for (const artifact of artifacts) {
    if (entriesByPath.has(artifact.relative_path)) continue
    const rootName = artifact.relative_path.split('/')[0]
    let root = roots.find((entry) => entry.path === rootName)
    if (!root) {
      root = { path: rootName, name: rootName, entries: [] }
      roots.push(root)
    }
    root.entries.push({
      path: artifact.relative_path,
      name: artifact.display_name,
      parent_path: rootName,
      is_dir: false,
      size_bytes: artifact.size_bytes,
      mime_type: artifact.mime_type,
      updated_at: artifact.created_at,
    })
    entriesByPath.set(artifact.relative_path, root.entries[root.entries.length - 1])
  }

  return { task_id: tree?.task_id ?? artifacts[0]?.task_id ?? '', roots }
}

function WorkspaceRoot({
  root,
  selectedPath,
  onSelectPath,
}: {
  root: TaskWorkspaceRoot
  selectedPath: string | null
  onSelectPath: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  const files = root.entries.filter((entry) => !entry.is_dir)
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 rounded-[0.7rem] px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-moss transition hover:bg-white/70 hover:text-forest"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Folder className="size-3.5 shrink-0" />
        {root.name}
      </button>
      <div className={cn('mt-1 space-y-1', open ? 'block' : 'hidden')}>
        {files.length ? (
          files.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => onSelectPath(entry.path)}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-[0.8rem] px-2 py-2 text-left text-xs transition',
                selectedPath === entry.path
                  ? 'bg-forest text-white'
                  : 'text-ink-soft hover:bg-white/82 hover:text-forest',
              )}
            >
              {entry.mime_type?.startsWith('image/') ? <FileImage className="size-3.5 shrink-0" /> : <File className="size-3.5 shrink-0" />}
              <span className="min-w-0 truncate">{entry.path.replace(`${root.path}/`, '')}</span>
            </button>
          ))
        ) : (
          <p className="px-2 py-2 text-xs text-ink-soft/70">Empty</p>
        )}
      </div>
    </section>
  )
}

function FilePreview({
  preview,
  workspaceRoot,
}: {
  preview: TaskWorkspaceFilePreview
  workspaceRoot: string | null
}) {
  const fullPath = workspaceRoot ? `${workspaceRoot}/${preview.path}` : preview.path
  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {preview.preview_type === 'image' ? <FileImage className="size-4 text-moss" /> : <Code2 className="size-4 text-moss" />}
            <h3 className="truncate text-sm font-semibold text-forest">{preview.name}</h3>
          </div>
          <p className="mt-1 truncate text-[11px] text-ink-soft">{preview.path}</p>
        </div>
        <CopyPathButton path={fullPath} />
      </div>

      <div className="mt-4 overflow-hidden rounded-[1rem] border border-forest/10 bg-white/80">
        {preview.preview_type === 'image' && preview.data_url ? (
          <div className="bg-canvas/70 p-3">
            <img src={preview.data_url} alt={preview.name} className="max-h-[58vh] w-full object-contain" />
          </div>
        ) : preview.preview_type === 'text' ? (
          <pre className="max-h-[62vh] overflow-auto p-4 text-[12px] leading-5 text-ink">
            <code>{preview.content_text}</code>
          </pre>
        ) : (
          <div className="px-4 py-8 text-sm leading-6 text-ink-soft">
            No inline preview is available for this file type.
          </div>
        )}
      </div>
      {preview.truncated ? (
        <p className="mt-2 text-xs text-ink-soft">Preview truncated for performance.</p>
      ) : null}
    </div>
  )
}

function SelectedPathFallback({
  selectedPath,
  workspaceRoot,
}: {
  selectedPath: string
  workspaceRoot: string | null
}) {
  const fullPath = workspaceRoot ? `${workspaceRoot}/${selectedPath}` : selectedPath
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="max-w-[260px]">
        <File className="mx-auto size-8 text-moss/70" />
        <p className="mt-3 text-sm font-medium text-forest">{selectedPath.split('/').pop()}</p>
        <p className="mt-1 text-xs leading-5 text-ink-soft">
          Preview is not loaded yet. The file is tracked in the task workspace.
        </p>
        <div className="mt-3 flex justify-center">
          <CopyPathButton path={fullPath} />
        </div>
      </div>
    </div>
  )
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-8 shrink-0 border-forest/15 text-xs"
      onClick={async () => {
        await navigator.clipboard.writeText(path)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? 'Copied path' : 'Copy path'}
    </Button>
  )
}
