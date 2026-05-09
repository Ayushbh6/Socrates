import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PANEL_WIDTH_PX,
  MAX_PANEL_WIDTH_PX,
  MIN_CHAT_WIDTH_PX,
  MIN_PANEL_WIDTH_PX,
  clampArtifactPanelWidth,
  getMaxArtifactPanelWidth,
  resolvePersistedArtifactPanelWidth,
  shouldUseArtifactSheet,
} from './artifactPanelLayout'

describe('artifact panel layout helpers', () => {
  it('uses the artifact sheet below the split-view breakpoint', () => {
    expect(shouldUseArtifactSheet(1279)).toBe(true)
    expect(shouldUseArtifactSheet(1280)).toBe(false)
  })

  it('clamps wide persisted panel widths to the maximum panel width', () => {
    expect(clampArtifactPanelWidth(1200, 1600)).toBe(MAX_PANEL_WIDTH_PX)
  })

  it('preserves the minimum chat width when the viewport is tighter than the global max', () => {
    const viewportWidth = 1300
    const expectedMax = viewportWidth - MIN_CHAT_WIDTH_PX

    expect(getMaxArtifactPanelWidth(viewportWidth)).toBe(expectedMax)
    expect(clampArtifactPanelWidth(900, viewportWidth)).toBe(expectedMax)
  })

  it('does not shrink the full panel below its minimum width', () => {
    expect(clampArtifactPanelWidth(200, 1600)).toBe(MIN_PANEL_WIDTH_PX)
  })

  it('falls back to the default width when persisted storage is invalid', () => {
    expect(resolvePersistedArtifactPanelWidth('not-a-number', 1600)).toBe(DEFAULT_PANEL_WIDTH_PX)
  })
})
