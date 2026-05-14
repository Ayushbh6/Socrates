"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Button } from "@/components/ui/Button";
import { ArrowRight } from "lucide-react";

export default function WelcomePage() {
  const router = useRouter();
  const { user } = useCurrentUser();

  const handleOpenWorkspace = () => {
    if (!user || !user.onboardingCompleted) {
      router.push("/onboarding");
    } else {
      router.push("/projects");
    }
  };

  return (
    <main className="min-h-screen bg-background bg-dot-pattern flex flex-col items-center justify-center p-6 text-center font-sans">
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="max-w-2xl w-full flex flex-col items-center"
      >
        {/* Eyebrow */}
        <p className="text-[10px] sm:text-xs font-semibold tracking-[0.25em] text-[#2db3ac] uppercase mb-8">
          Your Thinking Workspace
        </p>

        {/* Title */}
        <h1 className="text-7xl sm:text-8xl md:text-9xl font-serif font-normal tracking-tight mb-8">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#ccebe5] via-[#65c7c2] to-[#04a9a9]">
            Socrates
          </span>
        </h1>

        {/* Subtitles */}
        <div className="flex flex-col gap-4 mb-12">
          <p className="text-lg sm:text-xl text-gray-700 font-light">
            Think clearly. Ask well. Live examined.
          </p>
          <p className="text-sm sm:text-base text-gray-500 font-light">
            Your workspace is ready. Return directly to your projects.
          </p>
        </div>

        {/* Button */}
        <Button
          onClick={handleOpenWorkspace}
          className="group rounded-full pl-6 pr-5 py-6 text-base"
        >
          Open Workspace
          <ArrowRight className="ml-2 size-4 group-hover:translate-x-1 transition-transform duration-200" />
        </Button>
      </motion.div>
    </main>
  );
}
