"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { rememberSelectedView } from "@/lib/v2/viewState";
import type { SocratesViewMode } from "@/lib/v2/storageKeys";
import { useV2Capabilities } from "@/lib/v2/useV2Capabilities";

interface V2ViewLinkProps extends ComponentProps<typeof Link> {
  view: SocratesViewMode;
}

export function V2ViewLink({ view, onClick, ...props }: V2ViewLinkProps) {
  const availability = useV2Capabilities();
  const isUnavailable = view === "seamless" && !availability.enabled;

  if (isUnavailable) {
    const accent = (props as ComponentProps<typeof Link> & { "data-accent"?: string })["data-accent"];
    return (
      <span
        className={props.className}
        aria-disabled="true"
        data-accent={accent}
        data-v2-availability={availability.isLoading ? "checking" : "disabled"}
        title={availability.error ?? (availability.isLoading ? "Checking Seamless availability" : "Seamless View is disabled in this build")}
      >
        {props.children}
      </span>
    );
  }

  return (
    <Link
      {...props}
      onClick={(event) => {
        rememberSelectedView(view);
        onClick?.(event);
      }}
    />
  );
}
