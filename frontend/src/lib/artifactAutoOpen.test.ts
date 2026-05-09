import { describe, expect, it } from 'vitest'

import {
  decideArtifactRegistrationAutoOpen,
  decidePendingArtifactAutoOpen,
} from './artifactAutoOpen'

describe('artifact auto-open decisions', () => {
  it('defers opening when a worker is running and the artifact panel is collapsed', () => {
    expect(
      decideArtifactRegistrationAutoOpen({
        artifactPath: 'outputs/notes.txt',
        artifactPanelMode: 'collapsed',
        mobileArtifactsOpen: false,
        workerStatus: 'running',
        isMobileViewport: false,
      }),
    ).toEqual({
      selectedPath: 'outputs/notes.txt',
      artifactPanelMode: 'collapsed',
      mobileArtifactsOpen: false,
      pendingArtifactPath: 'outputs/notes.txt',
    })
  })

  it('keeps an open artifact panel open and selects the new artifact during a worker run', () => {
    expect(
      decideArtifactRegistrationAutoOpen({
        artifactPath: 'outputs/notes.txt',
        artifactPanelMode: 'open',
        mobileArtifactsOpen: false,
        workerStatus: 'running',
        isMobileViewport: false,
      }),
    ).toEqual({
      selectedPath: 'outputs/notes.txt',
      artifactPanelMode: 'open',
      mobileArtifactsOpen: false,
      pendingArtifactPath: null,
    })
  })

  it('opens the artifact panel when a worker reaches a terminal status with a pending artifact', () => {
    expect(
      decidePendingArtifactAutoOpen({
        pendingArtifactPath: 'outputs/notes.txt',
        artifactPanelMode: 'collapsed',
        mobileArtifactsOpen: false,
        workerStatus: 'completed',
        manualCollapseAfterPending: false,
        isMobileViewport: false,
      }),
    ).toEqual({
      selectedPath: 'outputs/notes.txt',
      artifactPanelMode: 'open',
      mobileArtifactsOpen: false,
      pendingArtifactPath: null,
    })
  })

  it('does not auto-open if the user manually collapsed artifacts after a pending artifact appeared', () => {
    expect(
      decidePendingArtifactAutoOpen({
        pendingArtifactPath: 'outputs/notes.txt',
        artifactPanelMode: 'collapsed',
        mobileArtifactsOpen: false,
        workerStatus: 'blocked',
        manualCollapseAfterPending: true,
        isMobileViewport: false,
      }),
    ).toEqual({
      selectedPath: 'outputs/notes.txt',
      artifactPanelMode: 'collapsed',
      mobileArtifactsOpen: false,
      pendingArtifactPath: null,
    })
  })
})
