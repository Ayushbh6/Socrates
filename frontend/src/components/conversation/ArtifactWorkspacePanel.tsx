import { useCallback, useMemo, useRef, type PointerEvent } from 'react'
import {
  Code2,
  Download,
  File,
  FileImage,
  Folder,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  TaskArtifact,
  TaskWorkspaceEntry,
  TaskWorkspaceFilePreview,
  TaskWorkspaceRoot,
  TaskWorkspaceTree,
} from '@/types/api'

export type ArtifactPanelMode = 'open' | 'collapsed'

interface ArtifactWorkspacePanelProps {
  taskId: string | null
  tree: TaskWorkspaceTree | null
  preview: TaskWorkspaceFilePreview | null
  artifacts: TaskArtifact[]
  selectedPath: string | null
  mode: ArtifactPanelMode
  loadingPreview: boolean
  exportPending: boolean
  onSelectPath: (path: string) => void
  onModeChange: (mode: ArtifactPanelMode) => void
  onCloseMobile?: () => void
  onExportArtifact: (artifactId: string) => void
  width?: number
  onWidthChange?: (width: number) => void
  mobile?: boolean
}

const MIN_DESKTOP_PANEL_WIDTH = 340
const DEFAULT_DESKTOP_PANEL_WIDTH = 430
const HARD_MAX_DESKTOP_PANEL_WIDTH = 760
const MIN_VISIBLE_CONVERSATION_WIDTH = 560

export function ArtifactWorkspacePanel({
  taskId,
  tree,
  preview,
  artifacts,
  selectedPath,
  mode,
  loadingPreview,
  exportPending,
  onSelectPath,
  onModeChange,
  onCloseMobile,
  onExportArtifact,
  width = DEFAULT_DESKTOP_PANEL_WIDTH,
  onWidthChange,
  mobile = false,
}: ArtifactWorkspacePanelProps) {
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const artifactByPath = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.relative_path, artifact])),
    [artifacts],
  )
  const visibleRoots = useMemo(() => {
    if (tree?.roots.some((root) => root.entries.some((entry) => !entry.is_dir))) {
      return tree.roots
    }
    return rootsFromArtifacts(artifacts)
  }, [artifacts, tree])
  const hasFiles = visibleRoots.some((root) => root.entries.some((entry) => !entry.is_dir))
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const viewportSafeMax = Math.max(
    MIN_DESKTOP_PANEL_WIDTH,
    viewportWidth - MIN_VISIBLE_CONVERSATION_WIDTH,
  )
  const maxPanelWidth = Math.min(HARD_MAX_DESKTOP_PANEL_WIDTH, viewportSafeMax)
  const clampedWidth = Math.min(maxPanelWidth, Math.max(MIN_DESKTOP_PANEL_WIDTH, width))

  const onResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (mobile || !onWidthChange) return
      event.preventDefault()
      resizeStartRef.current = { pointerX: event.clientX, width: clampedWidth }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [clampedWidth, mobile, onWidthChange],
  )

  const onResizePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!resizeStartRef.current || mobile || !onWidthChange) return
      const delta = resizeStartRef.current.pointerX - event.clientX
      const nextWidth = Math.min(
        maxPanelWidth,
        Math.max(MIN_DESKTOP_PANEL_WIDTH, resizeStartRef.current.width + delta),
      )
      onWidthChange(nextWidth)
    },
    [maxPanelWidth, mobile, onWidthChange],
  )

  const onResizePointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

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
      style={mobile ? undefined : { width: clampedWidth }}
    >
      {!mobile ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize artifact panel"
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          className="group absolute inset-y-0 left-0 z-20 flex w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center outline-none"
          title="Drag to resize artifacts"
        >
          <div className="h-16 w-1 rounded-full bg-forest/12 transition group-hover:bg-forest/36 group-focus-visible:bg-forest/36" />
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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(175px,0.82fr)_minmax(0,1.55fr)]">
        <div className="min-w-0 overflow-y-auto border-r border-forest/10 bg-canvas/44 px-3 py-3">
          {!hasFiles ? (
            <div className="rounded-[0.95rem] border border-dashed border-forest/18 px-3 py-5 text-center text-xs leading-5 text-ink-soft">
              Files will appear here as Socrates works.
            </div>
          ) : (
            <div className="space-y-3">
              {visibleRoots.map((root) => (
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
              artifact={artifactByPath.get(preview.path) ?? null}
              exportPending={exportPending}
              onExportArtifact={onExportArtifact}
            />
          ) : selectedPath ? (
            <PreviewUnavailable path={selectedPath} artifact={artifactByPath.get(selectedPath) ?? null} />
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

function rootsFromArtifacts(artifacts: TaskArtifact[]): TaskWorkspaceRoot[] {
  const now = new Date().toISOString()
  const roots = new Map<string, TaskWorkspaceEntry[]>()
  for (const artifact of artifacts) {
    const [rootName] = artifact.relative_path.split('/')
    if (!rootName) continue
    if (!['inputs', 'work', 'outputs'].includes(rootName)) continue
    const entries = roots.get(rootName) ?? []
    entries.push({
      path: artifact.relative_path,
      name: artifact.display_name,
      parent_path: rootName,
      is_dir: false,
      size_bytes: artifact.size_bytes,
      mime_type: artifact.mime_type,
      updated_at: artifact.created_at ?? now,
    })
    roots.set(rootName, entries)
  }
  return ['inputs', 'work', 'outputs'].map((name) => ({
    path: name,
    name,
    entries: roots.get(name) ?? [],
  }))
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
  const files = root.entries.filter((entry) => !entry.is_dir)
  return (
    <section>
      <div className="flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-moss">
        <Folder className="size-3.5" />
        {root.name}
      </div>
      <div className="mt-1 space-y-1">
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
  artifact,
  exportPending,
  onExportArtifact,
}: {
  preview: TaskWorkspaceFilePreview
  artifact: TaskArtifact | null
  exportPending: boolean
  onExportArtifact: (artifactId: string) => void
}) {
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
        {artifact?.artifact_role === 'output' && !artifact.promoted_to_asset ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={exportPending}
            className="h-8 shrink-0 border-forest/15 text-xs"
            onClick={() => onExportArtifact(artifact.id)}
          >
            <Download className="size-3.5" />
            Export
          </Button>
        ) : null}
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

function PreviewUnavailable({
  path,
  artifact,
}: {
  path: string
  artifact: TaskArtifact | null
}) {
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="max-w-[260px] rounded-[1rem] border border-dashed border-forest/18 bg-white/58 px-5 py-6">
        <File className="mx-auto size-8 text-moss/75" />
        <p className="mt-3 text-sm font-semibold text-forest">{artifact?.display_name ?? path.split('/').pop()}</p>
        <p className="mt-1 break-all text-xs leading-5 text-ink-soft">{path}</p>
        <p className="mt-3 text-xs leading-5 text-ink-soft">
          Preview is unavailable until the task workspace endpoint returns this file.
        </p>
      </div>
    </div>
  )
}
