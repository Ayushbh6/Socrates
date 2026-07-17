"use client";

import { motion, useReducedMotion } from "framer-motion";
import clsx from "clsx";
import styles from "./seamless.module.css";
import type { FlowPresenceState } from "./types";

interface LivingSphereProps {
  state: FlowPresenceState;
  size?: "compact" | "full" | "mini";
  statusLabel: string;
}

const stateClass: Record<FlowPresenceState, string> = {
  offline: styles.sphereOffline,
  idle: styles.sphereIdle,
  listening: styles.sphereListening,
  routing: styles.sphereRouting,
  thinking: styles.sphereThinking,
  working: styles.sphereWorking,
  awaiting_input: styles.sphereAwaiting,
  complete: styles.sphereComplete,
  error: styles.sphereError,
};

export function LivingSphere({ state, size = "full", statusLabel }: LivingSphereProps) {
  const reduceMotion = useReducedMotion();
  const active = state !== "offline" && state !== "error";

  return (
    <div className={styles.sphereAssembly} data-size={size}>
      <motion.div
        aria-hidden="true"
        className={styles.sphereHalo}
        animate={
          reduceMotion || !active
            ? undefined
            : {
                opacity: [0.25, 0.52, 0.25],
                scale: [0.94, 1.06, 0.94],
              }
        }
        transition={{ duration: state === "working" ? 2.2 : 4.8, ease: "easeInOut", repeat: Infinity }}
      />
      <motion.div
        aria-hidden="true"
        className={clsx(styles.sphere, stateClass[state])}
        animate={
          reduceMotion
            ? undefined
            : state === "routing"
              ? { rotate: 360 }
              : state === "listening"
                ? { scale: [1, 1.035, 1] }
                : state === "complete"
                  ? { scale: [1, 1.08, 1] }
                  : { y: [0, -4, 0] }
        }
        transition={{
          duration: state === "routing" ? 7 : state === "complete" ? 1.4 : 5.5,
          ease: "easeInOut",
          repeat: state === "complete" ? 0 : Infinity,
        }}
      >
        <span className={styles.sphereTexture} />
        <span className={styles.sphereWave} data-wave="one" />
        <span className={styles.sphereWave} data-wave="two" />
        <span className={styles.sphereWave} data-wave="three" />
        <span className={styles.sphereGlint} />
      </motion.div>
      <p className={styles.sphereStatus} role="status" aria-live="polite" aria-atomic="true">
        <span className={styles.sphereStatusDot} data-state={state} aria-hidden="true" />
        {statusLabel}
      </p>
    </div>
  );
}
