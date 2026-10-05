import { motion, useReducedMotion } from "motion/react";
import type { OrbState } from "../lib/model";

const LABEL: Record<OrbState, string> = {
  idle: "Ready",
  // The answer's own status line says what it waits on.
  thinking: "",
  working: "Working",
  waiting: "Waiting for you",
  done: "",
  stopped: "Stopped",
};

/**
 * Socrates' presence: a slow planet in the middle of the canvas, which
 * shrinks and glides to where the answer starts once work begins. The one
 * shared layout id moves it between the two places (architecture/web.md, "The orb").
 */
export function Orb({ state, docked }: { state: OrbState; docked: boolean }) {
  const still = useReducedMotion();
  return (
    <div className="orb-place" data-docked={docked}>
      <motion.div
        layoutId="orb"
        className="orb"
        data-state={state}
        data-docked={docked}
        transition={{ layout: still ? { duration: 0 } : { duration: 1.1, ease: [0.22, 1, 0.36, 1] } }}
        aria-hidden
      >
        <span className="orb-halo" />
        <span className="orb-sphere">
          <span className="orb-texture" />
          <span className="orb-wave" data-wave="one" />
          <span className="orb-wave" data-wave="two" />
          <span className="orb-wave" data-wave="three" />
          <span className="orb-glint" />
          <span className="orb-rim" />
        </span>
      </motion.div>
      {LABEL[state] && (
        <p className="orb-label" role="status" aria-live="polite">
          <span className="orb-dot" data-state={state} />
          {LABEL[state]}
        </p>
      )}
    </div>
  );
}
