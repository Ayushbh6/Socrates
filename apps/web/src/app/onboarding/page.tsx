"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ProviderCredentialsPanel } from "@/components/settings/ProviderCredentialsPanel";
import { api } from "@/lib/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export default function OnboardingPage() {
  const router = useRouter();
  const { user, isLoading } = useCurrentUser();
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modelSourceReady, setModelSourceReady] = useState(false);

  useEffect(() => {
    if (!isLoading && user?.onboardingCompleted) {
      router.replace("/projects");
    }
  }, [isLoading, router, user]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError("Enter your name to continue.");
      return;
    }
    if (!modelSourceReady) {
      setError("Connect a model provider or start Ollama with at least one chat model to continue.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await api.completeOnboarding({ displayName: trimmedName });
      router.push("/projects");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete onboarding.");
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    void api.listModels().then(
      (models) => {
        if (mounted) {
          setModelSourceReady(models.models.length > 0);
        }
      },
      () => {
        if (mounted) {
          setModelSourceReady(false);
        }
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <main className="min-h-screen bg-brand-bg flex items-center justify-center p-6">
      <div className="max-w-3xl w-full">
        <h1 className="text-3xl font-serif mb-6 text-brand-text-dark text-center">Welcome to Socrates</h1>
        <p className="text-brand-text-light mb-8 text-center text-lg">Set up your local workspace and provider access.</p>
        <form onSubmit={handleSubmit} className="mx-auto max-w-md flex flex-col gap-4">
          <input 
            type="text" 
            placeholder="Your name" 
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="px-5 py-4 bg-white border border-gray-200 rounded-xl outline-none focus:border-brand-teal-dark shadow-sm text-lg transition-colors"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={isSubmitting || isLoading || !modelSourceReady} className="w-full py-6 rounded-xl text-base">
            {isSubmitting ? "Saving" : "Continue"}
          </Button>
        </form>
        <div className="mt-8">
          <ProviderCredentialsPanel onConfiguredProviderReadyChange={setModelSourceReady} />
        </div>
      </div>
    </main>
  );
}
