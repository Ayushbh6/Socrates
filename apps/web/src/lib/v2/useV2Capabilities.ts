"use client";

import { useCallback, useEffect, useState } from "react";
import { v2Api, type V2Capabilities } from "./api";

let cachedCapabilities: V2Capabilities | null = null;
let pendingCapabilities: Promise<V2Capabilities> | null = null;

export const loadV2Capabilities = (force = false): Promise<V2Capabilities> => {
  if (!force && cachedCapabilities) return Promise.resolve(cachedCapabilities);
  if (!force && pendingCapabilities) return pendingCapabilities;
  pendingCapabilities = v2Api.getCapabilities().then((capabilities) => {
    cachedCapabilities = capabilities;
    return capabilities;
  }).finally(() => {
    pendingCapabilities = null;
  });
  return pendingCapabilities;
};

export function useV2Capabilities() {
  const [capabilities, setCapabilities] = useState<V2Capabilities | null>(cachedCapabilities);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!cachedCapabilities);

  const refresh = useCallback(async (force = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await loadV2Capabilities(force);
      setCapabilities(next);
    } catch (loadError) {
      setCapabilities(null);
      setError(loadError instanceof Error ? loadError.message : "Could not check Seamless availability.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    void loadV2Capabilities().then((next) => {
      if (!isMounted) return;
      setCapabilities(next);
      setError(null);
      setIsLoading(false);
    }).catch((loadError: unknown) => {
      if (!isMounted) return;
      setCapabilities(null);
      setError(loadError instanceof Error ? loadError.message : "Could not check Seamless availability.");
      setIsLoading(false);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  return {
    capabilities,
    enabled: capabilities?.enabled === true,
    isLoading,
    error,
    refresh,
  };
}
