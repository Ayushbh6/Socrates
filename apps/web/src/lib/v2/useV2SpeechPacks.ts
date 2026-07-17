"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  V2_SPEECH_PACK_IDS,
  v2SpeechPacksApi,
  type V2SpeechPack,
  type V2SpeechPackId,
} from "./speechPacksApi";

export type V2SpeechPackAction = "installing" | "removing";

type PackErrors = Partial<Record<V2SpeechPackId, string>>;
type PackActions = Partial<Record<V2SpeechPackId, V2SpeechPackAction>>;

const emptyPacks = (): V2SpeechPack[] =>
  V2_SPEECH_PACK_IDS.map((id) => ({ id, installed: false, verified: false, path: "" }));

const orderedPacks = (packs: V2SpeechPack[]): V2SpeechPack[] => {
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  return V2_SPEECH_PACK_IDS.flatMap((id) => {
    const pack = byId.get(id);
    return pack ? [pack] : [];
  });
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

export function useV2SpeechPacks() {
  const [packs, setPacks] = useState<V2SpeechPack[]>(emptyPacks);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actions, setActions] = useState<PackActions>({});
  const [packErrors, setPackErrors] = useState<PackErrors>({});

  const updatePack = useCallback((updated: V2SpeechPack) => {
    setPacks((current) => orderedPacks([
      ...current.filter((pack) => pack.id !== updated.id),
      updated,
    ]));
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setPacks(orderedPacks(await v2SpeechPacksApi.list(signal)));
    } catch (error) {
      if (signal?.aborted) return;
      setLoadError(errorMessage(error, "Could not load the local voice packs."));
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const runAction = useCallback(async (
    packId: V2SpeechPackId,
    action: V2SpeechPackAction,
  ) => {
    setActions((current) => ({ ...current, [packId]: action }));
    setPackErrors((current) => ({ ...current, [packId]: undefined }));
    try {
      const pack = action === "installing"
        ? await v2SpeechPacksApi.install(packId)
        : await v2SpeechPacksApi.remove(packId);
      updatePack(pack);
    } catch (error) {
      setPackErrors((current) => ({
        ...current,
        [packId]: errorMessage(
          error,
          action === "installing" ? "This voice pack could not be installed." : "This voice pack could not be removed.",
        ),
      }));
    } finally {
      setActions((current) => {
        const next = { ...current };
        delete next[packId];
        return next;
      });
    }
  }, [updatePack]);

  const installedCount = useMemo(
    () => packs.filter((pack) => pack.installed && pack.verified).length,
    [packs],
  );

  return {
    packs,
    isLoading,
    loadError,
    actions,
    packErrors,
    installedCount,
    isBusy: Object.keys(actions).length > 0,
    refresh: () => refresh(),
    install: (packId: V2SpeechPackId) => runAction(packId, "installing"),
    remove: (packId: V2SpeechPackId) => runAction(packId, "removing"),
    clearPackError: (packId: V2SpeechPackId) => {
      setPackErrors((current) => ({ ...current, [packId]: undefined }));
    },
  };
}
