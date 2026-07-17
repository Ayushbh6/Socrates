"use client";

import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Button } from "@/components/ui/Button";
import { V2ModeChooser } from "@/components/v2/V2ModeChooser";
import { ArrowRight, RefreshCw } from "lucide-react";

export default function WelcomePage() {
  const router = useRouter();
  const { user, isLoading, error, refetch } = useCurrentUser();

  const handleOpenWorkspace = () => {
    if (isLoading) {
      return;
    }

    if (!user || !user.onboardingCompleted) {
      router.push("/onboarding");
    } else {
      router.push("/projects");
    }
  };

  if (!isLoading && user?.onboardingCompleted) {
    return <V2ModeChooser displayName={user.displayName} />;
  }

  return (
    <main className="min-h-screen bg-background bg-dot-pattern flex flex-col items-center justify-center p-6 text-center font-sans">
      <div className="max-w-2xl w-full flex flex-col items-center">
        <p className="text-[10px] sm:text-xs font-semibold tracking-[0.25em] text-[#2db3ac] uppercase mb-8">
          Your Thinking Workspace
        </p>
        <h1 className="text-7xl sm:text-8xl md:text-9xl font-serif font-normal tracking-tight mb-8">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#ccebe5] via-[#65c7c2] to-[#04a9a9]">
            Socrates
          </span>
        </h1>
        <div className="flex flex-col gap-4 mb-12">
          <p className="text-lg sm:text-xl text-gray-700 font-light">
            Think clearly. Ask well. Live examined.
          </p>
          <p className="text-sm sm:text-base text-gray-500 font-light">
            {error ? "Socrates could not check this workspace." : isLoading ? "Checking your workspace…" : "A short setup comes first."}
          </p>
        </div>
        {error ? (
          <Button onClick={() => void refetch()} className="group rounded-full pl-6 pr-5 py-6 text-base">
            Try Again
            <RefreshCw className="ml-2 size-4 transition-transform duration-200 group-hover:rotate-45" />
          </Button>
        ) : (
          <Button
            onClick={handleOpenWorkspace}
            disabled={isLoading}
            className="group rounded-full pl-6 pr-5 py-6 text-base"
          >
            {isLoading ? "Checking Workspace" : "Set Up Socrates"}
            <ArrowRight className="ml-2 size-4 transition-transform duration-200 group-hover:translate-x-1" />
          </Button>
        )}
      </div>
    </main>
  );
}
