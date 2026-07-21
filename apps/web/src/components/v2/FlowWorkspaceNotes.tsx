"use client";

import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Paperclip } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { V2_STORAGE_KEYS } from "@/lib/v2/storageKeys";
import type { FlowContextSummary, FlowGoalView } from "./types";
import styles from "./seamless.module.css";

type StickyNoteId = "context" | "focus";

interface StickyNotePosition {
  x: number;
  y: number;
}

type StickyNotePositions = Record<StickyNoteId, StickyNotePosition>;

const DEFAULT_POSITIONS: StickyNotePositions = {
  context: { x: 0, y: 0 },
  focus: { x: 0, y: 0 },
};

const isFinitePosition = (value: unknown): value is StickyNotePosition => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StickyNotePosition>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
};

const readStoredPositions = (storageKey: string): StickyNotePositions => {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return DEFAULT_POSITIONS;
    const parsed = JSON.parse(stored) as Partial<StickyNotePositions>;
    return {
      context: isFinitePosition(parsed.context) ? parsed.context : DEFAULT_POSITIONS.context,
      focus: isFinitePosition(parsed.focus) ? parsed.focus : DEFAULT_POSITIONS.focus,
    };
  } catch {
    return DEFAULT_POSITIONS;
  }
};

interface StickyNoteProps {
  id: StickyNoteId;
  position: StickyNotePosition;
  draggable: boolean;
  reduceMotion: boolean | null;
  ariaLabel: string;
  moveLabel: string;
  children: ReactNode;
  onOpen: () => void;
  onPositionChange: (id: StickyNoteId, position: StickyNotePosition) => void;
  onNoteRef: (id: StickyNoteId, element: HTMLElement | null) => void;
}

function StickyNote({
  id,
  position,
  draggable,
  reduceMotion,
  ariaLabel,
  moveLabel,
  children,
  onOpen,
  onPositionChange,
  onNoteRef,
}: StickyNoteProps) {
  const dragState = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    position: StickyNotePosition;
  } | null>(null);

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggable) return;
    event.preventDefault();
    event.stopPropagation();
    dragState.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      position,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const activeDrag = dragState.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onPositionChange(id, {
      x: activeDrag.position.x + event.clientX - activeDrag.pointerX,
      y: activeDrag.position.y + event.clientY - activeDrag.pointerY,
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const activeDrag = dragState.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const nudgeNote = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 40 : 14;
    const delta = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onPositionChange(id, { x: position.x + delta.x, y: position.y + delta.y });
  };

  return (
    <motion.article
      ref={(element) => onNoteRef(id, element)}
      className={styles.clippedNote}
      data-note={id}
      onPointerDown={(event) => event.stopPropagation()}
      style={draggable ? { x: position.x, y: position.y } : undefined}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
    >
      <button
        type="button"
        className={styles.noteClip}
        aria-label={moveLabel}
        title={draggable ? `${moveLabel}. Use the arrow keys for precise movement.` : "Pinned on smaller screens"}
        disabled={!draggable}
        onPointerDown={startDrag}
        onPointerMove={continueDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={draggable ? nudgeNote : undefined}
      >
        <Paperclip aria-hidden="true" />
      </button>
      <button type="button" className={styles.noteContent} onClick={onOpen} aria-label={ariaLabel}>
        {children}
      </button>
    </motion.article>
  );
}

interface FlowWorkspaceNotesProps {
  projectId: string;
  activeGoal?: FlowGoalView;
  currentTaskLabel: string;
  contextSummary?: FlowContextSummary;
  pausedGoalCount: number;
  compact: boolean;
  onOpenContext: () => void;
  onOpenFocuses: () => void;
}

export function FlowWorkspaceNotes({
  projectId,
  activeGoal,
  currentTaskLabel,
  contextSummary,
  pausedGoalCount,
  compact,
  onOpenContext,
  onOpenFocuses,
}: FlowWorkspaceNotesProps) {
  const reduceMotion = useReducedMotion();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const noteRefs = useRef<Record<StickyNoteId, HTMLElement | null>>({ context: null, focus: null });
  const [positions, setPositions] = useState<StickyNotePositions>(DEFAULT_POSITIONS);
  const [isNarrowLayout, setIsNarrowLayout] = useState(false);
  const positionsRef = useRef<StickyNotePositions>(DEFAULT_POSITIONS);
  const storageKey = `${V2_STORAGE_KEYS.noteLayout}:${projectId}`;
  const visibleContextItems = contextSummary?.items?.slice(0, 2) ?? [];
  const remainingContextItems = Math.max(0, (contextSummary?.items?.length ?? 0) - visibleContextItems.length);

  const persistPositions = useCallback((next: StickyNotePositions) => {
    positionsRef.current = next;
    setPositions(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The notes still work for this session when storage is unavailable.
    }
  }, [storageKey]);

  const updatePosition = useCallback((id: StickyNoteId, position: StickyNotePosition) => {
    const current = positionsRef.current[id];
    const surface = surfaceRef.current;
    const note = noteRefs.current[id];
    let nextX = position.x;
    let nextY = position.y;
    if (surface && note) {
      const surfaceRect = surface.getBoundingClientRect();
      const noteRect = note.getBoundingClientRect();
      const requestedX = position.x - current.x;
      const requestedY = position.y - current.y;
      const boundedX = Math.min(
        Math.max(requestedX, surfaceRect.left - noteRect.left),
        surfaceRect.right - noteRect.right,
      );
      const boundedY = Math.min(
        Math.max(requestedY, surfaceRect.top - noteRect.top),
        surfaceRect.bottom - noteRect.bottom,
      );
      nextX = current.x + boundedX;
      nextY = current.y + boundedY;
    }
    persistPositions({
      ...positionsRef.current,
      [id]: {
        x: Math.round(nextX * 100) / 100,
        y: Math.round(nextY * 100) / 100,
      },
    });
  }, [persistPositions]);

  const clampPositionsToSurface = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const surfaceRect = surface.getBoundingClientRect();
    let next = positionsRef.current;
    let changed = false;

    (["context", "focus"] as const).forEach((id) => {
      const noteRect = noteRefs.current[id]?.getBoundingClientRect();
      if (!noteRect) return;
      const deltaX = Math.max(0, surfaceRect.left - noteRect.left) - Math.max(0, noteRect.right - surfaceRect.right);
      const deltaY = Math.max(0, surfaceRect.top - noteRect.top) - Math.max(0, noteRect.bottom - surfaceRect.bottom);
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
      changed = true;
      next = {
        ...next,
        [id]: {
          x: Math.round((next[id].x + deltaX) * 100) / 100,
          y: Math.round((next[id].y + deltaY) * 100) / 100,
        },
      };
    });

    if (changed) persistPositions(next);
  }, [persistPositions]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 45rem)");
    const updateLayout = () => setIsNarrowLayout(media.matches);
    updateLayout();
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const stored = readStoredPositions(storageKey);
      positionsRef.current = stored;
      setPositions(stored);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [storageKey]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(clampPositionsToSurface);
    return () => window.cancelAnimationFrame(frame);
  }, [positions, clampPositionsToSurface]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    let settleTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(clampPositionsToSurface, 180);
    });
    observer.observe(surface);
    return () => {
      observer.disconnect();
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    };
  }, [clampPositionsToSurface]);

  return (
    <div ref={surfaceRef} className={styles.ambientNotes} data-compact={compact || undefined} aria-label="Movable working notes">
      <StickyNote
        id="context"
        position={positions.context}
        draggable={!isNarrowLayout}
        reduceMotion={reduceMotion}
        ariaLabel="Open working context"
        moveLabel="Move live context note"
        onOpen={onOpenContext}
        onPositionChange={updatePosition}
        onNoteRef={(id, element) => { noteRefs.current[id] = element; }}
      >
        <span className={styles.noteEyebrow}>Live context</span>
        <span className={styles.noteBody}>
          {contextSummary?.unavailableReason ? (
            <span className={styles.noteMuted}>Context is temporarily unavailable</span>
          ) : visibleContextItems.length > 0 ? (
            visibleContextItems.map((item) => (
              <span key={item.id} className={styles.noteLine}>
                <span>{item.label}</span>
                <small>{item.disposition === "keep_exact" ? "Exact" : item.disposition === "distill" ? "Distilled" : "Review"}</small>
              </span>
            ))
          ) : (
            <span className={styles.noteMuted}>No retrieved evidence active yet</span>
          )}
        </span>
        <span className={styles.noteAction}>
          <span>{remainingContextItems > 0 ? `View context · +${remainingContextItems}` : "View context"}</span>
          <ArrowRight aria-hidden="true" />
        </span>
      </StickyNote>

      <StickyNote
        id="focus"
        position={positions.focus}
        draggable={!isNarrowLayout}
        reduceMotion={reduceMotion}
        ariaLabel="Open focus ledger"
        moveLabel="Move current focus note"
        onOpen={onOpenFocuses}
        onPositionChange={updatePosition}
        onNoteRef={(id, element) => { noteRefs.current[id] = element; }}
      >
        <span className={styles.noteEyebrow}>Current focus</span>
        <strong className={styles.noteTitle}>{activeGoal?.title ?? "No current focus"}</strong>
        <span className={styles.noteTask}>
          <small>Current task</small>
          <span>{currentTaskLabel}</span>
        </span>
        <span className={styles.noteAction}>
          <span>{pausedGoalCount > 0 ? `View focuses · ${pausedGoalCount} paused` : "View focuses"}</span>
          <ArrowRight aria-hidden="true" />
        </span>
      </StickyNote>
    </div>
  );
}
