import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Attachment, DeciderClient, DecisionRequest } from "@socrates/contracts";
import { DECIDER_INPUT_TOKENS, decisionTokens } from "@socrates/providers";
import type { Evidence } from "@socrates/store";
import { MemoryGate, GATE_QUESTIONS } from "../src/gates";
import { buildWorkDecision, workFallbackState } from "../src/work-memory";
import { decisionImages } from "../src/attachments";
import { requestTokens } from "../src/model-budget";
import { call, final, tempDir, world } from "./helpers";
import { continueTask } from "../../router/test/helpers";

function fake() {
  const requests: DecisionRequest[] = [];
  const decider: DeciderClient = { id: "fake", async decide(r) { requests.push(r); return { model: "fake", probabilities: { recall: 0, save: 0, work: 0 }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, id: null }; } };
  return { requests, gate: new MemoryGate({ decider }) };
}
const attachment = (file: string): Attachment => ({ id: "a".repeat(32), name: "image.png", path: file, width: 400, height: 400, media_type: "image/png", bytes: 10 });
const ev = (i: number, tool = "read", result: unknown = {path: "a", lines: []}, status = "ok"): Evidence => ({ number: i, handle: `e${i}`, tool, input: { path: "a", command: "pnpm test" }, result: { result }, status, createdAt: "", turnId: "turn", taskId: "task", callId: `c${i}` }) as Evidence;

it("uses exactly 60%, includes questions and pixels, and accepts image-only requests", async () => {
  expect(DECIDER_INPUT_TOKENS).toBe(157286);
  const f = fake();
  const images = [{ mediaType: "image/png" as const, data: "data", width: 1536, height: 1536 }];
  expect(decisionTokens({ state: "a", questions: GATE_QUESTIONS, images })).toBeGreaterThan(12_000);
  await f.gate.read({ message: "", attachments: ["image.png"], images, previousAnswer: null, ask: { recall: true, save: true }, trace: { role: "decision" } });
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.images).toEqual(images);
  const no = await f.gate.read({ message: "x", context: "word ".repeat(160000), attachments: [], previousAnswer: null, ask: { recall: true, save: true }, trace: { role: "decision" } });
  expect(no).toMatchObject({ recall: null, save: null, fallback: true });
  expect(f.requests).toHaveLength(1);
});

it("preserves the full request and late answer conclusion, includes middle tool evidence and explicit failures", () => {
  const request = "request ".repeat(1000) + "QUESTION_END";
  const answer = "answer ".repeat(2000) + "VERIFIED_LESSON_AT_END";
  const calls = Array.from({length: 60}, (_,i) => ev(i + 1));
  calls[29] = ev(30, "terminal", { status: "completed", exit_code: 1, output: "failed" });
  calls[30] = ev(31, "edit", { path: "fix.ts", diff: "+fixed\n" });
  calls[31] = ev(32, "terminal", { status: "completed", exit_code: 0, output: "passed" });
  const p = buildWorkDecision({request, answer, calls, reference: "turn_number 7"});
  expect(p.state).toContain(request); expect(p.state).toContain(answer);
  expect(p.state).toContain("exit_code: 1"); expect(p.state).toContain("exit_code: 0");
  expect(p.state.indexOf("[e30]")).toBeLessThan(p.state.indexOf("[e31]"));
  expect(p.omitted).toBe(0); expect(p.overflow).toBe(false);
  expect(p.estimatedTokens).toBeLessThanOrEqual(DECIDER_INPUT_TOKENS);
});

it("prioritizes changes/checks over routine reads, retains order, and marks omissions", () => {
  const calls = Array.from({length: 100}, (_,i) => ev(i + 1));
  calls[50] = ev(51, "edit", {path:"fix.ts", diff:"+fixed"});
  calls[51] = ev(52, "terminal", {status:"completed",exit_code:0,output:"passed"});
  const p = buildWorkDecision({request:"fix",answer:"done",calls}, 1500);
  expect(p.state).toContain("[e51]"); expect(p.state).toContain("[e52]");
  expect(p.omitted).toBeGreaterThan(0); expect(p.estimatedTokens).toBeLessThanOrEqual(1500);
});

it("never trims mandatory fields for classification and creates a referenced, bounded fallback", () => {
  const input = { request: "request ".repeat(90000), answer: "answer ".repeat(90000), calls: [ev(1)], reference: "turn_number 3" };
  const p = buildWorkDecision(input);
  expect(p.overflow).toBe(true); expect(p.state).toContain(input.answer); expect(p.state).toContain(input.request);
  const bounded = workFallbackState(input);
  expect(bounded).toContain("EXCERPT"); expect(bounded).toContain("turn_number 3");
  expect(decisionTokens({state:bounded, questions:GATE_QUESTIONS})).toBeLessThan(27000);
});

it("normalizes real pixels, keeps every supported image, and fails closed for missing/animated attachments", async () => {
  const dir = tempDir();
  const large = path.join(dir, "large.png");
  await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "blue" }}).png().toFile(large);
  const gif = path.join(dir,"still.gif"); await sharp(large).gif().toFile(gif);
  const p = await decisionImages([attachment(large), attachment(gif)]);
  expect(p.images).toHaveLength(2); expect(p.images[0]).toMatchObject({width:1536,height:512,mediaType:"image/png"});
  expect((await sharp(Buffer.from(p.images[0]!.data,"base64")).metadata()).width).toBe(1536);
  const missing = await decisionImages([attachment(large),attachment(path.join(dir,"missing.png"))]);
  expect(missing.images).toEqual([]); expect(missing.unavailable).toContain("no partial");
  const controller = new AbortController(); controller.abort();
  await expect(decisionImages([attachment(large)],controller.signal)).rejects.toThrow();
});

it("passes the original image to BOTH runtime stages and preserves the full final answer", async () => {
  const f = fake(); const dir = tempDir(); const file = path.join(dir,"image.png");
  writeFileSync(file,readFileSync(path.join(import.meta.dirname,"../../tools/test/fixture-label.png")));
  const w = await world(); const answer = "Detail. ".repeat(300) + "The final verified lesson.";
  const {socrates} = w.socrates([continueTask()], [{toolCalls:[call("edit",{path:"new.txt",old_text:"",new_text:"done"})]},final({full_answer:answer})], {gate:()=>f.gate,attachments:dir});
  await socrates.handle("Use the supplied diagram.",{attachments:[attachment(file)]}); await socrates.workMemoryIdle();
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]!.images).toHaveLength(1); expect(f.requests[1]!.images).toEqual(f.requests[0]!.images);
  expect(f.requests[1]!.state).toContain(answer);
  expect(w.store.listEvents({type:"work_memory_step"}).at(-1)!.payload).toMatchObject({outcome:"not_worth",decision:{images:1,fallback:null}});
});

it("overflow runs bounded main-agent assessment, can save NOTHING, preserves the answer and never repeats edits", async () => {
  const f = fake(); const w = await world(); const answer = "word ".repeat(160000) + "DONE";
  const {socrates,model} = w.socrates([continueTask()],[{toolCalls:[call("edit",{path:"once.txt",old_text:"",new_text:"once"})]},final({full_answer:answer}),{text:"Nothing to record."}],{gate:()=>f.gate});
  const result = await socrates.handle("Make a one-off edit."); await socrates.workMemoryIdle();
  expect(result.kind === "answered" && result.text).toBe(answer);
  expect(f.requests).toHaveLength(1); // no prefix classified by the work decider
  const r = model.requests.at(-1)!;
  expect(r.trace?.role).toBe("work");
  expect(requestTokens(r.system,r.messages,r.tools)).toBeLessThan(60_000);
  expect(r.tools?.map(t=>t.name)).toEqual(["work_memory","context_retrieve"]);
  expect(w.store.listEvents({type:"work_memory_written"})).toHaveLength(0);
  expect(w.store.listEvents({type:"work_memory_step"}).at(-1)!.payload).toMatchObject({outcome:"nothing",writes:0,decision:{fallback:expect.stringContaining("exceeds")}});
  expect(readFileSync(path.join(w.root,"once.txt"),"utf8")).toBe("once");
}, 30000);

it("rejects a text-plus-images overflow even when text alone fits, and never sends missing-image partials", async () => {
  const f = fake();
  const input = { message: "x", context: "word ".repeat(97000), attachments: ["image.png"], previousAnswer: null, ask: {recall:true,save:true}, trace: {role:"decision" as const} };
  expect(await f.gate.read({...input,images:[{mediaType:"image/png",data:"x",width:1536,height:1536}]})).toMatchObject({fallback:true,recall:null,save:null});
  expect(await f.gate.read({...input,context:"short",imageFailure:"Image unavailable"})).toMatchObject({fallback:true,unavailableReason:"Image unavailable"});
  expect(f.requests).toHaveLength(0);
});

it("does not load or classify images when both memory switches are off", async () => {
  const f = fake(); const w = await world();
  const {socrates} = w.socrates([continueTask()],[final()],{gate:()=>f.gate,memory:()=>({use:false,save:false})});
  await socrates.handle("Hello",{attachments:[attachment("/missing.png")]});
  expect(f.requests).toHaveLength(0);
});

it("keeps the original query and images through a linked routing clarification at both stages", async () => {
  const f = fake(); const dir = tempDir(); const file = path.join(dir,"image.png");
  writeFileSync(file,readFileSync(path.join(import.meta.dirname,"../../tools/test/fixture-label.png")));
  const w = await world();
  const ask = {toolCalls:[{name:"ask_user",input:{question:"Which folder?",candidates:[{label:"Work",detail:"Use Work",goal_label:"current",task_label:"current"}],allow_new:false}}]};
  const {socrates} = w.socrates([ask,continueTask()],[{toolCalls:[call("edit",{path:"once.txt",old_text:"",new_text:"done"})]},final()],{gate:()=>f.gate,attachments:dir});
  expect((await socrates.handle("Original query",{attachments:[attachment(file)],newRequest:true})).kind).toBe("clarify");
  const pending = w.store.pendingClarification()!;
  await socrates.handle("Use Work",{replyTo:pending.id}); await socrates.workMemoryIdle();
  expect(f.requests).toHaveLength(3);
  expect(f.requests[1]!.images).toEqual(f.requests[0]!.images);
  expect(f.requests[2]!.images).toEqual(f.requests[0]!.images);
  expect(f.requests[2]!.state).toContain("Original query");
  expect(f.requests[2]!.state).toContain("Which folder?");
  expect(f.requests[2]!.state).toContain("Use Work");
});

it("explicitly bypasses animated images instead of pretending a first frame is the whole image", async () => {
  const frame = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==","base64");
  const offset = frame.indexOf(0x2c);
  const animated = Buffer.concat([frame.subarray(0,frame.length-1),frame.subarray(offset,frame.length-1),Buffer.from([0x3b])]);
  const file = path.join(tempDir(),"animated.gif"); writeFileSync(file,animated);
  expect((await sharp(animated).metadata()).pages).toBe(2);
  const result = await decisionImages([attachment(file)]);
  expect(result.images).toEqual([]); expect(result.unavailable).toContain("Animated");
});
