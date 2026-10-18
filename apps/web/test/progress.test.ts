import { describe, expect, it } from "vitest";
import { emptyModel, reduce } from "../src/lib/model";
import { SLOW_ROUTING_MS, orientedLine, progressLine, progressTrail } from "../src/lib/progress";
import type { ProgressStep } from "../src/lib/types";

const at = "2026-10-18T10:00:00.000Z";
const t = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const route = { goal: { number: 1, title: "Algebra" }, task: { number: 2, title: "Linear equations" } };
const flow: ProgressStep[] = [{ stage: "remembering", at: t(50) }, { stage: "routing", at: t(400) }, { stage: "searching", at: t(1800) }, { stage: "routing", at: t(2300) }, { stage: "preparing", at: t(3100) }, { stage: "starting", at: t(3400) }];
const ex = (progress: ProgressStep[], over: Partial<{ state: "sending" | "working" | "done"; route: typeof route | null }> = {}) => ({ at, state: "working" as const, route: null, progress, ...over });

describe("the routing line", () => {
  it("says what the message is doing at each reported stage", () => {
    expect(progressLine(ex([], { state: "sending" }), 0, Date.parse(at))).toBe("Sending…");
    expect(progressLine(ex([]), 0, Date.parse(at))).toBe("Reading your message…");
    const now = Date.parse(t(2000));
    expect(progressLine(ex(flow), 0, now)).toBe("Checking what I remember…");
    expect(progressLine(ex(flow), 1, now)).toBe("Finding the goal and task…");
    expect(progressLine(ex(flow), 2, now)).toBe("Looking through earlier tasks…");
    expect(progressLine(ex(flow), 5, now)).toBe("Starting work…");
  });

  it("names the place once routed, and says Standard prepares its chosen chat", () => {
    expect(progressLine(ex(flow.slice(0, 4), { route }), 3, Date.parse(t(2500)))).toBe("Opening Algebra → Linear equations");
    expect(progressLine(ex(flow.slice(0, 5), { route }), 4, Date.parse(t(3200)))).toBe("Opening Algebra → Linear equations");
    const standard: ProgressStep[] = [{ stage: "preparing", at: t(30) }];
    expect(progressLine(ex(standard, { route }), 0, Date.parse(t(100)))).toBe("Preparing this task…");
  });

  it("says routing is still going only after it really has been slow", () => {
    const slow: ProgressStep[] = [{ stage: "routing", at: t(0) }];
    expect(progressLine(ex(slow), 0, Date.parse(t(SLOW_ROUTING_MS - 1)))).toBe("Finding the goal and task…");
    expect(progressLine(ex(slow), 0, Date.parse(t(SLOW_ROUTING_MS)))).toBe("Still finding the right task…");
  });

  it("lists passed stages in past tense with their times, and sums up once work shows", () => {
    const trail = progressTrail(ex(flow, { route }), 4);
    expect(trail.map(i => i.label)).toEqual(["Checked what I remember", "Looked for the goal and task", "Looked through earlier tasks", "Looked for the goal and task", "Opening Algebra / Linear equations"]);
    expect(trail.at(-1)).toMatchObject({ done: false, offsetMs: 3100 });
    expect(progressTrail(ex(flow, { route }), 5, true).every(i => i.done)).toBe(true);
    expect(orientedLine(ex(flow, { route }))).toEqual({ label: "Found where this belongs", ms: 3400 });
    expect(orientedLine(ex([{ stage: "preparing", at: t(10) }, { stage: "starting", at: t(800) }]))).toEqual({ label: "Prepared this task", ms: 800 });
    expect(orientedLine(ex([]))).toBeNull();
  });

  it("attaches progress to the sending page's message by id, and to other pages' by saved seq", () => {
    let m = reduce(emptyModel(), { type: "sent", id: "c1", text: "Why?", to: "main", at });
    m = reduce(m, { type: "server", message: { type: "progress", id: "c1", conversation: "main", trail: flow.slice(0, 1) } });
    expect(m.conversations.main![0]!.progress).toEqual(flow.slice(0, 1));
    let other = reduce(emptyModel(), { type: "server", message: { type: "activity", seq: 7, at, conversation: "main", kind: "message", text: "Why?", attachments: [] } as never });
    other = reduce(other, { type: "server", message: { type: "progress", id: "c1", conversation: "main", seq: 7, trail: flow.slice(0, 2) } });
    expect(other.conversations.main![0]!.progress).toEqual(flow.slice(0, 2));
  });
});
