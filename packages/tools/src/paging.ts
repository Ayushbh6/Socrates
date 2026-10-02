import { countTokens } from "@socrates/shared";
import { RESULT_CEILING_TOKENS } from "./bounds";
import type { HandlerContext } from "./context";

const FRAME_TOKENS = 300;

/**
 * Return one page of a frozen result set, stopping early when the page would
 * pass the result ceiling, and a cursor for whatever remains.
 */
export function page<T>(ctx: HandlerContext, key: string, items: T[], offset: number, limit: number, render: (item: T) => string, options: { capped?: boolean; maxBytes?: number; maxLines?: number } = {}) {
  const out: T[] = [];
  let tokens = 0;
  let bytes = 0;
  let lines = 0;
  for (let i = offset; i < items.length && out.length < limit; i++) {
    const text = render(items[i]!);
    const cost = countTokens(text) + 2;
    const byteCost = Buffer.byteLength(text) + 2;
    const lineCost = text.split(/\n|\\n/).length;
    if (out.length > 0 && (tokens + cost > RESULT_CEILING_TOKENS - FRAME_TOKENS || bytes + byteCost > (options.maxBytes ?? Infinity) - 2048 || lines + lineCost > (options.maxLines ?? Infinity) - 100)) break;
    tokens += cost;
    bytes += byteCost;
    lines += lineCost;
    out.push(items[i]!);
  }
  const next = offset + out.length;
  const nextCursor = next < items.length ? ctx.run.saveCursor(key, items, next, options.capped) : null;
  return { out, nextCursor };
}
