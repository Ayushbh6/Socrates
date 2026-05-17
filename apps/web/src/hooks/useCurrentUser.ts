"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "@socrates/contracts";
import { api } from "@/lib/api";

export function useCurrentUser(): {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUser = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await api.getMe();
      setUser(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load user");
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialUser() {
      try {
        const data = await api.getMe();
        if (isMounted) {
          setUser(data.user);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to load user");
          setUser(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadInitialUser();

    return () => {
      isMounted = false;
    };
  }, []);

  return { user, isLoading, error, refetch: loadUser };
}
