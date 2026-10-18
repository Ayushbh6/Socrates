import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { contextDocument, RoutingResult, TraceDocument, ModelOutput } from "../src/components/TraceDocument";

describe("the recorded context reader", () => {
  it("renders the conversation and fenced evidence as one document, retaining inner code", () => {
    const source = "# RECENT_CONVERSATION\n\n## EXCHANGE\n\n### FINAL_ANSWER\n````text\n**A useful answer**\n\n```js\nconst x = 1;\n```\n````";
    const html = renderToStaticMarkup(createElement(TraceDocument, { text: source, evidence: true }));
    expect(html).toContain("<h2>Recent conversation</h2>");
    expect(html).toContain("<strong>A useful answer</strong>");
    expect(html).toContain('class="language-js"');
    expect(html).not.toContain('class="language-text"');
  });
  it("keeps raw recorded text intact, translates only legacy wrappers, and never embeds remote images or HTML", () => {
    const blocks = [{ name: "GOAL", text: "<GOAL>\nBuild **Socrates**\n</GOAL>", tokens: 10, cacheAfter: true }, { name: "TASK", text: "# TASK\n\nImprove traces", tokens: 5, cacheAfter: false }];
    expect(contextDocument(blocks)).toBe("# GOAL\n\nBuild **Socrates**\n\n# TASK\n\nImprove traces");
    expect(blocks[0]!.text).toContain("<GOAL>");
    const html = renderToStaticMarkup(createElement(TraceDocument, { text: '<script>alert(1)</script>\n\n![private](https://example.test/track)\n\n[bad](javascript:alert(1))' }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });
  it("presents a native routing result without implying a missing tool response", () => {
    const html = renderToStaticMarkup(createElement(RoutingResult, { input: { decision: "resume_existing", goal_label: "current", task_label: "current", task_decision: "resume_task", reason: "Continue the same question." } }));
    expect(html).toContain("Use an existing goal");
    expect(html).toContain("Continue a task");
    expect(html).toContain("Recorded decision fields");
    expect(html).not.toContain("no result");
  });
  it("shows the agent answer rather than its JSON envelope and preserves prompt XML labels", () => {
    const html = renderToStaticMarkup(createElement(ModelOutput, { text: JSON.stringify({ full_answer: "**Done**", continuation_note: "Saved note" }) }));
    expect(html).toContain("<strong>Done</strong>");
    expect(html).toContain("Recorded answer fields");
    expect(html).toContain("Saved note");
    const prompt = renderToStaticMarkup(createElement(TraceDocument, { text: "Use <MEMORY> for known facts." }));
    expect(prompt).toContain("&lt;MEMORY&gt;");
  });

});
