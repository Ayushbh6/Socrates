"use client";

import Link from "next/link";
import { SentientOrb } from "@/components/sentient/sentient-orb";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function WelcomeLanding() {
  return (
    <div className="relative flex h-svh flex-col items-center justify-center overflow-hidden bg-[#020609] px-4 py-[max(1rem,4svh)] sm:px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_62%_at_50%_38%,#0b2a3a_0%,#061018_52%,#020609_100%)]"
      />

      <div className="relative z-10 flex h-full w-full max-w-[42rem] flex-col items-center justify-center text-center">
        <div className="flex w-full max-w-[38rem] flex-col items-center gap-[clamp(0.75rem,1.6svh,1.1rem)]">
          <p className="font-label text-[11px] tracking-[0.4em] text-[#4ecdc4]/50 uppercase">
            PremChat
          </p>
          <h1 className="font-heading text-[clamp(2.15rem,6vw,4rem)] font-light leading-[0.98] tracking-[-0.05em] text-[#dff2f0]">
            A calmer way to think
            <span className="block">with light</span>
          </h1>
          <p className="max-w-[32rem] text-[clamp(0.88rem,1.7vw,0.95rem)] leading-[1.7] font-light text-[#6a9aaa]">
            Step into your workspace when you are ready.
            <span className="block">Nothing here rushes you.</span>
          </p>
        </div>

        <SentientOrb className="my-[clamp(1.1rem,4.5svh,2.5rem)]" status="Awake" variant="hero" />

        <div className="flex flex-col items-center gap-[clamp(0.85rem,1.8svh,1.35rem)]">
          <Link
            href="/chat"
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "font-label h-12 rounded-full border border-[#4ecdc4]/25 bg-white/4 px-8 text-[11px] tracking-[0.3em] text-[#e0faf8] uppercase sm:h-14 sm:px-10",
              "transition-[background-color,border-color,color] duration-300 ease-out",
              "hover:border-[#4ecdc4]/50 hover:bg-[#4ecdc4]/12 hover:text-[#f1fffe]"
            )}
          >
            Start talking to Prem
          </Link>

          <p className="text-sm text-[#4ecdc4]/55">
            Already in a thread?{" "}
            <Link
              href="/chat"
              className="text-[#4ecdc4]/75 transition-colors duration-200 hover:text-[#85f0e7]"
            >
              Open chat
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
