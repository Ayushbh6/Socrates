import type { ArtifactPanelMode } from '@/components/conversation/ArtifactWorkspacePanel'
import { isTerminalWorkerTraceStatus, type WorkerTraceStatus } from './workerTrace'

interface ArtifactRegistrationInput {
  artifactPath: string
  artifactPanelMode: ArtifactPanelMode
  mobileArtifactsOpen: boolean
  workerStatus: WorkerTraceStatus | null | undefined
  isMobileViewport: boolean
}

interface PendingArtifactInput {
  pendingArtifactPath: string | null
  artifactPanelMode: ArtifactPanelMode
  mobileArtifactsOpen: boolean
  workerStatus: WorkerTraceStatus | null | undefined
  manualCollapseAfterPending: boolean
  isMobileViewport: boolean
}

export interface ArtifactAutoOpenDecision {
  selectedPath: string | null
  artifactPanelMode: ArtifactPanelMode
  mobileArtifactsOpen: boolean
  pendingArtifactPath: string | null
}

function isArtifactSurfaceOpen(artifactPanelMode: ArtifactPanelMode, mobileArtifactsOpen: boolean) {
  return artifactPanelMode === 'open' || mobileArtifactsOpen
}

function openArtifactSurface(
  artifactPanelMode: ArtifactPanelMode,
  mobileArtifactsOpen: boolean,
  isMobileViewport: boolean,
) {
  return {
    artifactPanelMode: isMobileViewport ? artifactPanelMode : 'open',
    mobileArtifactsOpen: isMobileViewport ? true : mobileArtifactsOpen,
  }
}

export function decideArtifactRegistrationAutoOpen({
  artifactPath,
  artifactPanelMode,
  mobileArtifactsOpen,
  workerStatus,
  isMobileViewport,
}: ArtifactRegistrationInput): ArtifactAutoOpenDecision {
  const surfaceOpen = isArtifactSurfaceOpen(artifactPanelMode, mobileArtifactsOpen)

  if (workerStatus === 'running' && !surfaceOpen) {
    return {
      selectedPath: artifactPath,
      artifactPanelMode,
      mobileArtifactsOpen,
      pendingArtifactPath: artifactPath,
    }
  }

  const openSurface = surfaceOpen
    ? { artifactPanelMode, mobileArtifactsOpen }
    : openArtifactSurface(artifactPanelMode, mobileArtifactsOpen, isMobileViewport)

  return {
    selectedPath: artifactPath,
    ...openSurface,
    pendingArtifactPath: null,
  }
}

export function decidePendingArtifactAutoOpen({
  pendingArtifactPath,
  artifactPanelMode,
  mobileArtifactsOpen,
  workerStatus,
  manualCollapseAfterPending,
  isMobileViewport,
}: PendingArtifactInput): ArtifactAutoOpenDecision | null {
  if (!pendingArtifactPath || !isTerminalWorkerTraceStatus(workerStatus)) {
    return null
  }

  if (manualCollapseAfterPending) {
    return {
      selectedPath: pendingArtifactPath,
      artifactPanelMode,
      mobileArtifactsOpen,
      pendingArtifactPath: null,
    }
  }

  return {
    selectedPath: pendingArtifactPath,
    ...openArtifactSurface(artifactPanelMode, mobileArtifactsOpen, isMobileViewport),
    pendingArtifactPath: null,
  }
}
