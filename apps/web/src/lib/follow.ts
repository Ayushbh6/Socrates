import { type RefObject, useEffect, useRef } from "react";

/**
 * Keeps a scrolling area at its end while its content grows, as long as the
 * reader is at the end. A reader who scrolls up is left alone; the returned
 * ref says whether the area is following, so a caller can resume it.
 */
export function useFollow(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, enabled = true) {
  const following = useRef(true);
  useEffect(() => {
    const area = scroller.current;
    const body = content.current;
    if (!area || !body) return;
    let interacting = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const intent = () => {
      interacting = true;
      clearTimeout(idle);
      idle = setTimeout(() => { interacting = false; }, 500);
    };
    const wheel = (event: WheelEvent) => {
      intent();
      if (event.deltaY < 0) following.current = false;
    };
    const keys = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) intent();
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) following.current = false;
    };
    const touch = () => { intent(); following.current = false; };
    const pointer = (event: PointerEvent) => { if (event.target === area) intent(); };
    const onScroll = () => {
      const atEnd = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
      // Width changes and browser anchoring also emit scroll events. Only a reader
      // moving away from the end should turn following off.
      if (atEnd) following.current = true;
      else if (interacting) following.current = false;
      if (interacting) intent();
    };
    // Instantly: a smooth scroll started on every growth would lag behind the text.
    const follow = () => {
      if (enabled && following.current) area.scrollTo({ top: area.scrollHeight, behavior: "instant" });
    };
    area.addEventListener("scroll", onScroll, { passive: true });
    area.addEventListener("wheel", wheel, { passive: true });
    area.addEventListener("touchstart", intent, { passive: true });
    area.addEventListener("touchmove", touch, { passive: true });
    area.addEventListener("pointerdown", pointer, { passive: true });
    area.addEventListener("keydown", keys);
    const watch = new ResizeObserver(follow);
    watch.observe(body);
    return () => {
      area.removeEventListener("scroll", onScroll);
      area.removeEventListener("wheel", wheel);
      area.removeEventListener("touchstart", intent);
      area.removeEventListener("touchmove", touch);
      area.removeEventListener("pointerdown", pointer);
      area.removeEventListener("keydown", keys);
      clearTimeout(idle);
      watch.disconnect();
    };
  }, [scroller, content, enabled]);
  return following;
}
