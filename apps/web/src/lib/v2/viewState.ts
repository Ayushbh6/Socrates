import { V2_STORAGE_KEYS, type SocratesViewMode } from "./storageKeys";

export function rememberSelectedView(view: SocratesViewMode): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(V2_STORAGE_KEYS.lastSelectedView, view);
}

export function readBooleanViewState(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }

  const stored = window.localStorage.getItem(key);
  if (stored === null) {
    return fallback;
  }

  return stored === "true";
}

export function writeBooleanViewState(key: string, value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, String(value));
}
