export const ARTIFACT_SHEET_BREAKPOINT_PX = 1280
export const MIN_CHAT_WIDTH_PX = 680
export const MIN_PANEL_WIDTH_PX = 460
export const DEFAULT_PANEL_WIDTH_PX = 640
export const MAX_PANEL_WIDTH_PX = 760

export function shouldUseArtifactSheet(viewportWidth: number): boolean {
  return viewportWidth < ARTIFACT_SHEET_BREAKPOINT_PX
}

export function getMaxArtifactPanelWidth(viewportWidth: number): number {
  return Math.min(
    MAX_PANEL_WIDTH_PX,
    Math.max(MIN_PANEL_WIDTH_PX, viewportWidth - MIN_CHAT_WIDTH_PX),
  )
}

export function clampArtifactPanelWidth(width: number, viewportWidth: number): number {
  const maxWidth = getMaxArtifactPanelWidth(viewportWidth)
  return Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH_PX, width))
}

export function resolvePersistedArtifactPanelWidth(
  storedWidth: string | null,
  viewportWidth: number,
): number {
  const parsed = storedWidth == null ? NaN : Number(storedWidth)
  const width = Number.isFinite(parsed) ? parsed : DEFAULT_PANEL_WIDTH_PX
  return clampArtifactPanelWidth(width, viewportWidth)
}
