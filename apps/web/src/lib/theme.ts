import { useSyncExternalStore } from "react";

/**
 * Light or dark (architecture/web.md, "Theme"): the user's choice, or the
 * system's when they chose "system". Kept in this browser only; the choice is
 * applied as `data-theme` on <html> before the first paint (index.html).
 */
export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

export const THEME_KEY = "socrates.theme";
const CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

export function readChoice(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemeChoice {
  try {
    const value = storage?.getItem(THEME_KEY);
    return CHOICES.includes(value as ThemeChoice) ? (value as ThemeChoice) : "system";
  } catch {
    return "system";
  }
}

/** The theme a choice comes to, given whether the system prefers dark. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<() => void>();
let choice: ThemeChoice = readChoice();
let snapshot = { choice, theme: resolveTheme(choice, media?.matches ?? false) };

function apply() {
  snapshot = { choice, theme: resolveTheme(choice, media?.matches ?? false) };
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = snapshot.theme;
    document.documentElement.style.colorScheme = snapshot.theme;
  }
  for (const l of listeners) l();
}

media?.addEventListener?.("change", () => { if (choice === "system") apply(); });
// Another tab changing the choice changes it here too.
if (typeof window !== "undefined") window.addEventListener("storage", (e) => { if (e.key === THEME_KEY) { choice = readChoice(); apply(); } });

export function setThemeChoice(next: ThemeChoice) {
  choice = next;
  try { safeStorage()?.setItem(THEME_KEY, next); } catch { /* the choice still holds for this page */ }
  apply();
}

/** Switch between light and dark from whatever shows now. */
export function toggleTheme() {
  setThemeChoice(snapshot.theme === "dark" ? "light" : "dark");
}

export function useTheme(): { choice: ThemeChoice; theme: Theme } {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot, () => snapshot);
}

apply();
