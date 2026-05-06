import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  File,
  FileImage,
  FileText,
  Folder,
  GripVertical,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type {
  TaskArtifact,
  TaskWorkspaceEntry,
  TaskWorkspaceFilePreview,
  TaskWorkspaceTree,
} from '@/types/api'

export type ArtifactPanelMode = 'open' | 'collapsed'

const DEFAULT_PANEL_WIDTH = 720
const MIN_PANEL_WIDTH = 460
const MAX_PANEL_WIDTH = 1080
const MIN_CHAT_WIDTH = 500
const PANEL_WIDTH_STORAGE_KEY = 'artifact-workspace-panel-width-v2'

type WorkspaceTreeNode = {
  path: string
  name: string
  isDir: boolean
  entry?: TaskWorkspaceEntry
  children: WorkspaceTreeNode[]
}

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
  const hasFiles = displayTree.some((root) => hasFileDescendant(root))
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
      <aside className="hidden h-full w-12 shrink-0 border-l border-forest/10 bg-paper/72 transition-[width,background-color] duration-200 ease-out motion-reduce:transition-none lg:flex">
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
          ? 'fixed inset-x-0 bottom-0 z-50 flex h-[82dvh] max-h-[82vh] rounded-t-[1.35rem] border-t border-forest/12 bg-paper shadow-[0_-24px_80px_rgba(27,53,41,0.22)]'
          : 'relative hidden h-full shrink-0 border-l border-forest/10 bg-paper/86 lg:flex',
        'min-w-0 flex-col overflow-hidden transition-[width,transform,background-color] duration-200 ease-out motion-reduce:transition-none',
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => onModeChange('collapsed')}
              aria-label="Collapse artifacts panel"
              title="Collapse artifacts panel"
            >
              <PanelRightClose className="size-4" />
            </Button>
          ) : null}
          {mobile && onCloseMobile ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onCloseMobile}
              aria-label="Close artifacts panel"
              title="Close artifacts panel"
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          'min-h-0 flex-1',
          mobile
            ? 'flex flex-col overflow-hidden'
            : 'grid grid-cols-[minmax(220px,0.32fr)_minmax(0,1fr)]',
        )}
      >
        <div
          className={cn(
            'min-w-0 overflow-y-auto overscroll-contain bg-canvas/38 px-3 py-3',
            mobile ? 'max-h-[32dvh] shrink-0 border-b border-forest/10' : 'border-r border-forest/10',
          )}
        >
          {!hasFiles ? (
            <div className="rounded-[0.95rem] border border-dashed border-forest/18 px-3 py-5 text-center text-xs leading-5 text-ink-soft">
              Files will appear here as Socrates works.
            </div>
          ) : (
            <div className="space-y-1">
              {displayTree.map((root) => (
                <WorkspaceTreeItem
                  key={root.path}
                  node={root}
                  selectedPath={selectedPath}
                  onSelectPath={onSelectPath}
                />
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-paper/96">
          {loadingPreview ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-soft">Loading preview...</div>
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

  const stored = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)
  if (stored == null) {
    return DEFAULT_PANEL_WIDTH
  }

  const parsed = Number(stored)
  return Number.isFinite(parsed)
    ? clamp(parsed, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH)
    : DEFAULT_PANEL_WIDTH
}

function writePersistedPanelWidth(width: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width))
}

function buildDisplayTree(tree: TaskWorkspaceTree | null, artifacts: TaskArtifact[]): WorkspaceTreeNode[] {
  const rootNames = ['inputs', 'work', 'outputs']
  const roots = rootNames.map((name) => createTreeNode(name, name, true))
  const nodesByPath = new Map(roots.map((root) => [root.path, root]))
  const entries = tree?.roots.flatMap((root) => root.entries) ?? []

  for (const entry of entries) {
    addEntryToTree(entry, roots, nodesByPath)
  }

  for (const artifact of artifacts) {
    if (nodesByPath.has(artifact.relative_path)) continue
    addEntryToTree(
      {
        path: artifact.relative_path,
        name: artifact.display_name,
        parent_path: artifact.relative_path.split('/').slice(0, -1).join('/') || null,
        is_dir: false,
        size_bytes: artifact.size_bytes,
        mime_type: artifact.mime_type,
        updated_at: artifact.created_at,
      },
      roots,
      nodesByPath,
    )
  }

  return roots.map(sortTreeNode)
}

function createTreeNode(path: string, name: string, isDir: boolean, entry?: TaskWorkspaceEntry): WorkspaceTreeNode {
  return { path, name, isDir, entry, children: [] }
}

function addEntryToTree(
  entry: TaskWorkspaceEntry,
  roots: WorkspaceTreeNode[],
  nodesByPath: Map<string, WorkspaceTreeNode>,
) {
  const parts = entry.path.split('/').filter(Boolean)
  if (!parts.length) return

  let parent = nodesByPath.get(parts[0])
  if (!parent) {
    parent = createTreeNode(parts[0], parts[0], true)
    roots.push(parent)
    nodesByPath.set(parent.path, parent)
  }

  let currentPath = parts[0]
  for (const part of parts.slice(1, -1)) {
    currentPath = `${currentPath}/${part}`
    let directory = nodesByPath.get(currentPath)
    if (!directory) {
      directory = createTreeNode(currentPath, part, true)
      parent.children.push(directory)
      nodesByPath.set(currentPath, directory)
    }
    parent = directory
  }

  const existing = nodesByPath.get(entry.path)
  if (existing) {
    existing.entry = entry
    existing.isDir = entry.is_dir
    existing.name = entry.name
    return
  }

  const node = createTreeNode(entry.path, entry.name, entry.is_dir, entry)
  parent.children.push(node)
  nodesByPath.set(node.path, node)
}

function sortTreeNode(node: WorkspaceTreeNode): WorkspaceTreeNode {
  return {
    ...node,
    children: node.children
      .map(sortTreeNode)
      .sort((left, right) => {
        if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
        return left.name.localeCompare(right.name)
      }),
  }
}

function hasFileDescendant(node: WorkspaceTreeNode): boolean {
  if (!node.isDir) return true
  return node.children.some(hasFileDescendant)
}

function WorkspaceTreeItem({
  node,
  selectedPath,
  onSelectPath,
  depth = 0,
}: {
  node: WorkspaceTreeNode
  selectedPath: string | null
  onSelectPath: (path: string) => void
  depth?: number
}) {
  const [open, setOpen] = useState(true)
  const hasChildren = node.children.length > 0

  if (!node.isDir) {
    const isImage = node.entry?.mime_type?.startsWith('image/')
    const isCode = isCodeLikePath(node.path, node.entry?.mime_type)
    return (
      <button
        type="button"
        onClick={() => onSelectPath(node.path)}
        className={cn(
          'group flex h-8 w-full min-w-0 items-center gap-2 rounded-[0.55rem] pr-2 text-left text-xs transition',
          selectedPath === node.path
            ? 'bg-forest text-white shadow-[0_8px_18px_rgba(23,49,39,0.18)]'
            : 'text-ink-soft hover:bg-white/88 hover:text-forest',
        )}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        {isImage ? (
          <FileImage className="size-3.5 shrink-0" />
        ) : isCode ? (
          <Code2 className="size-3.5 shrink-0" />
        ) : (
          <FileText className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
    )
  }

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-[0.55rem] pr-2 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-moss transition hover:bg-white/70 hover:text-forest"
        style={{ paddingLeft: depth * 14 + 4 }}
        aria-expanded={open}
      >
        {hasChildren && open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Folder className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      <div className={cn('space-y-0.5', open ? 'block' : 'hidden')}>
        {hasChildren ? (
          node.children.map((child) => (
            <WorkspaceTreeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
              depth={depth + 1}
            />
          ))
        ) : (
          <p className="px-2 py-1.5 text-xs text-ink-soft/70" style={{ paddingLeft: depth * 14 + 22 }}>
            Empty
          </p>
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
  const [fullScreenOpen, setFullScreenOpen] = useState(false)
  return (
    <div className="flex h-full min-w-0 max-w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-forest/10 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {preview.preview_type === 'image' ? <FileImage className="size-4 text-moss" /> : <Code2 className="size-4 text-moss" />}
            <h3 className="truncate text-sm font-semibold text-forest">{preview.name}</h3>
          </div>
          <p className="mt-1 truncate text-[11px] text-ink-soft">{preview.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 text-moss hover:text-forest"
            onClick={() => setFullScreenOpen(true)}
            aria-label="Open full screen"
            title="Open full screen"
          >
            <Maximize2 className="size-4" />
          </Button>
          <OpenRawButton preview={preview} />
          <CopyPathButton path={fullPath} />
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <PreviewBody preview={preview} />
      </div>
      {preview.truncated ? (
        <p className="shrink-0 border-t border-forest/10 px-5 py-2 text-xs text-ink-soft">Preview truncated for performance.</p>
      ) : null}
      <FullScreenPreviewDialog
        preview={preview}
        open={fullScreenOpen}
        onOpenChange={setFullScreenOpen}
      />
    </div>
  )
}

function PreviewBody({ preview, fullScreen = false }: { preview: TaskWorkspaceFilePreview; fullScreen?: boolean }) {
  if (preview.preview_type === 'image' && preview.data_url) {
    return (
      <div className={cn('flex h-full min-h-0 items-center justify-center bg-[#f7f8f5]', fullScreen ? 'p-6' : 'p-4')}>
        <img
          src={preview.data_url}
          alt={preview.name}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }

  if (preview.preview_type === 'text') {
    return (
      <pre className={cn('h-full w-full max-w-full overflow-auto overscroll-contain bg-[#fbfcf8] font-mono text-[12.5px] leading-5 whitespace-pre text-ink', fullScreen ? 'p-6' : 'p-5')}>
        <code>{preview.content_text}</code>
      </pre>
    )
  }

  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-sm leading-6 text-ink-soft">
      <div>
        <File className="mx-auto size-8 text-moss/70" />
        <p className="mt-3 font-medium text-forest">No inline preview available</p>
      </div>
    </div>
  )
}

function FullScreenPreviewDialog({
  preview,
  open,
  onOpenChange,
}: {
  preview: TaskWorkspaceFilePreview
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[92vh] max-h-[92vh] w-[94vw] max-w-[94vw] flex-col gap-0 overflow-hidden rounded-[0.8rem] border-forest/12 bg-paper p-0 sm:max-w-[94vw]"
      >
        <DialogHeader className="shrink-0 border-b border-forest/10 px-5 py-4">
          <DialogTitle className="truncate text-sm font-semibold text-forest">{preview.name}</DialogTitle>
          <DialogDescription className="truncate text-xs text-ink-soft">{preview.path}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <PreviewBody preview={preview} fullScreen />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function OpenRawButton({ preview }: { preview: TaskWorkspaceFilePreview }) {
  const canOpen = Boolean(preview.data_url || preview.content_text)

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-8 text-moss hover:text-forest disabled:opacity-40"
      disabled={!canOpen}
      onClick={() => openPreviewInNewTab(preview)}
      aria-label="Open raw file"
      title="Open raw file"
    >
      <ExternalLink className="size-4" />
    </Button>
  )
}

function openPreviewInNewTab(preview: TaskWorkspaceFilePreview) {
  if (preview.data_url) {
    window.open(preview.data_url, '_blank', 'noopener,noreferrer')
    return
  }

  if (preview.content_text != null) {
    const blob = new Blob([preview.content_text], { type: `${preview.mime_type || 'text/plain'};charset=utf-8` })
    const url = window.URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener,noreferrer')
    window.setTimeout(() => window.URL.revokeObjectURL(url), 30_000)
  }
}

function isCodeLikePath(path: string, mimeType?: string | null) {
  if (mimeType?.includes('json') || mimeType?.includes('javascript') || mimeType?.startsWith('text/')) return true
  return /\.(py|ts|tsx|js|jsx|mjs|cjs|css|html|md|json|yml|yaml|toml|sql|sh|zsh|bash|rs|go|java|kt|swift|c|cpp|h|hpp)$/i.test(path)
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
