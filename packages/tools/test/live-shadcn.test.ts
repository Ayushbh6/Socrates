import { appendFileSync } from "node:fs";
import { describe, it } from "vitest";
import { harness } from "./helpers";

/** A real shadcn init, driven through the terminal tools: opt in with LIVE_SHADCN=1 (it needs the network). */
describe.skipIf(!process.env.LIVE_SHADCN)("live: shadcn init in a pseudo-terminal", () => {
  it("shows an agent each prompt as a screen and lets it answer", async () => {
    const h = harness();
    const show = (label: string, json: any) => appendFileSync(process.env.LIVE_SHADCN!, `\n── ${label} ──\n${json.screen?.text ?? json.output ?? JSON.stringify(json).slice(0, 400)}\n[highlighted: ${JSON.stringify(json.screen?.highlighted ?? [])}]\n`);
    await h.call("terminal", { command: "npx --yes shadcn@latest init", pty: true, background: true, name: "shadcn" });
    for (let step = 1; step <= 6; step++) {
      const w = await h.call("terminal_control", { action: "wait", terminal: "shadcn", event: "input_required", timeout_ms: 90_000 });
      show(`step ${step}: ${w.json.event}`, w.json);
      if (w.json.event !== "input_required") break;
      const w2 = await h.call("terminal_control", { action: "write", terminal: "shadcn", keys: ["DOWN"] });
      show(`after DOWN`, w2.json);
      await h.call("terminal_control", { action: "write", terminal: "shadcn", keys: ["ENTER"] });
    }
    await h.call("terminal_control", { action: "terminate", terminal: "shadcn" });
  }, 300_000);
});
