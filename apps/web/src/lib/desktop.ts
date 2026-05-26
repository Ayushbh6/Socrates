"use client";

import type { ProviderId } from "@socrates/contracts";

type TauriCredentialStatus = {
  providerId: ProviderId;
  configured: boolean;
};

type TauriImportedCredential = TauriCredentialStatus & {
  apiKey: string;
};

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const tauri = await import("@tauri-apps/api/core");
  return tauri.invoke<T>(command, args);
};

export const desktopCredentials = {
  status: async (): Promise<TauriCredentialStatus[] | null> => {
    if (!isTauriRuntime()) {
      return null;
    }
    return invoke<TauriCredentialStatus[]>("provider_credential_status");
  },

  save: async (providerId: ProviderId, apiKey: string): Promise<TauriCredentialStatus | null> => {
    if (!isTauriRuntime()) {
      return null;
    }
    return invoke<TauriCredentialStatus>("save_provider_credential", { providerId, apiKey });
  },

  delete: async (providerId: ProviderId): Promise<TauriCredentialStatus | null> => {
    if (!isTauriRuntime()) {
      return null;
    }
    return invoke<TauriCredentialStatus>("delete_provider_credential", { providerId });
  },

  importEnvFile: async (path: string): Promise<TauriImportedCredential[] | null> => {
    if (!isTauriRuntime()) {
      return null;
    }
    return invoke<TauriImportedCredential[]>("import_provider_credentials_from_env_file", { path });
  },
};

export type DesktopUpdateStatus =
  | { state: "unavailable"; message: string }
  | { state: "idle" }
  | { state: "available"; version: string; currentVersion: string; body?: string }
  | { state: "not_available"; message: string }
  | { state: "installed"; message: string }
  | { state: "failed"; message: string };

export const desktopUpdates = {
  check: async (): Promise<DesktopUpdateStatus> => {
    if (!isTauriRuntime()) {
      return { state: "unavailable", message: "Updates are available in the packaged desktop app." };
    }
    try {
      const updater = await import("@tauri-apps/plugin-updater");
      const update = await updater.check();
      if (!update) {
        return { state: "not_available", message: "Socrates is up to date." };
      }
      return {
        state: "available",
        version: update.version,
        currentVersion: update.currentVersion,
        ...(update.body ? { body: update.body } : {}),
      };
    } catch (error) {
      return { state: "failed", message: error instanceof Error ? error.message : "Could not check for updates." };
    }
  },

  downloadAndInstall: async (): Promise<DesktopUpdateStatus> => {
    if (!isTauriRuntime()) {
      return { state: "unavailable", message: "Updates are available in the packaged desktop app." };
    }
    try {
      const updater = await import("@tauri-apps/plugin-updater");
      const update = await updater.check();
      if (!update) {
        return { state: "not_available", message: "Socrates is up to date." };
      }
      await update.downloadAndInstall();
      return { state: "installed", message: "Update installed. Restart Socrates to finish." };
    } catch (error) {
      return { state: "failed", message: error instanceof Error ? error.message : "Could not install update." };
    }
  },
};
