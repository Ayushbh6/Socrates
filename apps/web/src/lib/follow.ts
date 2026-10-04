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
    const onScroll = () => {
      following.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
    };
    // Instantly: a smooth scroll started on every growth would lag behind the text.
    const follow = () => {
      if (enabled && following.current) area.scrollTo({ top: area.scrollHeight, behavior: "instant" });
    };
    area.addEventListener("scroll", onScroll, { passive: true });
    const watch = new ResizeObserver(follow);
    watch.observe(body);
    return () => {
      area.removeEventListener("scroll", onScroll);
      watch.disconnect();
    };
  }, [scroller, content, enabled]);
  return following;
}
