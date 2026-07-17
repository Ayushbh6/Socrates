"use client";

import { ArrowRight, ArrowUpRight, MessagesSquare, Waypoints } from "lucide-react";
import { LivingSphere } from "./LivingSphere";
import { V2ViewLink } from "./V2ViewLink";
import { useV2Capabilities } from "@/lib/v2/useV2Capabilities";
import styles from "./seamless.module.css";

interface V2ModeChooserProps {
  displayName?: string;
}

export function V2ModeChooser({ displayName }: V2ModeChooserProps) {
  const availability = useV2Capabilities();
  const seamlessDescription = availability.isLoading
    ? "Checking whether the isolated Flow runtime is available…"
    : availability.error
      ? "Availability could not be verified. Classic View remains ready."
      : availability.enabled
        ? "One persistent flow with goals and context managed behind the scenes."
        : "Disabled in this build. Classic View remains unchanged.";

  return (
    <main className={styles.modePage}>
      <div className={styles.oceanNoise} aria-hidden="true" />
      <header className={styles.modeHeader}>
        <span className={styles.wordmark}>Socrates</span>
        <span className={styles.modeEyebrow}>Choose your workspace</span>
      </header>

      <section className={styles.modeHero} aria-labelledby="mode-title">
        <div className={styles.modeSphere}>
          <LivingSphere state="idle" size="compact" statusLabel="Two views. One Socrates." />
        </div>
        <div className={styles.modeIntro}>
          <p className={styles.kicker}>{displayName ? `Welcome back, ${displayName}` : "Workspace ready"}</p>
          <h1 id="mode-title">How would you like to think today?</h1>
          <p>Classic keeps familiar project chats. Seamless opens one continuous project flow.</p>
        </div>
      </section>

      <nav className={styles.modeChoices} aria-label="Workspace views">
        <V2ViewLink view="classic" href="/projects" className={styles.modeChoice}>
          <span className={styles.modeChoiceIcon} aria-hidden="true">
            <MessagesSquare />
          </span>
          <span className={styles.modeChoiceCopy}>
            <span className={styles.modeChoiceLabel}>Classic View</span>
            <span>Projects, separate chats, and the workspace you already know.</span>
          </span>
          <ArrowUpRight className={styles.modeChoiceArrow} aria-hidden="true" />
        </V2ViewLink>

        <V2ViewLink view="seamless" href="/seamless" className={styles.modeChoice} data-accent="true">
          <span className={styles.modeChoiceIcon} aria-hidden="true">
            <Waypoints />
          </span>
          <span className={styles.modeChoiceCopy}>
            <span className={styles.modeChoiceLabel}>Seamless View</span>
            <span>{seamlessDescription}</span>
          </span>
          <ArrowRight className={styles.modeChoiceArrow} aria-hidden="true" />
        </V2ViewLink>
      </nav>
    </main>
  );
}
