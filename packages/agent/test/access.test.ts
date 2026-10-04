import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccessPolicy } from "@socrates/tools";
import { continueTask } from "../../router/test/helpers";
import { call, contextText, final, world } from "./helpers";

describe("access", () => {
  it("tells the agent where it may work, asks before each change in ask mode, and omits the block without a policy", async () => {
    const w = await world({ files: { "server.js": "const port = 30;\n" } });
    const policy: AccessPolicy = { folders: [w.root], approvals: "ask", protected: [] };
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("read", { path: "server.js" })] },
      { toolCalls: [call("edit", { path: "server.js", old_text: "30", new_text: "3000" })] },
      final({ full_answer: "The port is fixed." }),
    ], { access: () => policy });
    await socrates.handle("Fix the port.");
    const text = contextText(model.requests[0]!);
    const block = /<ACCESS>\n([\s\S]*?)\n<\/ACCESS>/.exec(text)![1]!;
    expect(block).toBe(`files: ${w.root}. Any other path, including the workspace when it is not listed, asks the user first, who may refuse.\napprovals: the user approves each edit, patch, command and changing MCP call before it runs, and may refuse. Reading and searching need no approval.`);
    expect(text.indexOf("<ACCESS>")).toBeGreaterThan(text.indexOf("<CURRENT_TASK>"));
    expect(text.indexOf("<ACCESS>")).toBeLessThan(text.indexOf("<CURRENT_USER_MESSAGE>"));
    expect(w.approvals).toEqual([{ kind: "action", tool: "edit", detail: "Edit server.js", preview: "--- replace\n30\n+++ with\n3000" }]);
    expect(readFileSync(path.join(w.root, "server.js"), "utf8")).toBe("const port = 3000;\n");

    const plain = await world();
    const classic = plain.socrates([continueTask()], [final()]);
    await classic.socrates.handle("Continue.");
    expect(contextText(classic.model.requests[0]!)).not.toContain("<ACCESS>");
  });
});
