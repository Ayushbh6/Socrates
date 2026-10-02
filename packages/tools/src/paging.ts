import { countTokens } from "@socrates/shared";
import { RESULT_CEILING_TOKENS } from "./bounds";
import type { HandlerContext } from "./context";

const FRAME_TOKENS = 300;

/**
 * Return one page of a frozen result set, stopping early when the page would
 * pass the result ceiling, and a cursor for whatever remains.
 */
export function page<T>(ctx: HandlerContext, key: string, items: T[], offset: number, limit: number, render: (item: T) => string) {
  const out: T[] = [];
  let tokens = 0;
  for (let i = offset; i < items.length && out.length < limit; i++) {
    const cost = countTokens(render(items[i]!)) + 2;
    if (out.length > 0 && tokens + cost > RESULT_CEILING_TOKENS - FRAME_TOKENS) break;
    tokens += cost;
    out.push(items[i]!);
  }
  const next = offset + out.length;
  const nextCursor = next < items.length ? ctx.run.saveCursor(key, items, next) : null;
  return { out, nextCursor };
}
