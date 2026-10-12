/** Synthetic isolated probes: real Perplexity image decisions and real configured
 * DeepSeek work-memory assessment on a deliberately oversized recorded turn.
 * No user ledger is copied. All fixture files/DBs are removed in finally. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Attachment, DecisionRequest, ModelClient, EventPayloads } from "@socrates/contracts";
import { DECIDER_INPUT_TOKENS, OpenRouterDecider, ScriptedModel, makeModel, decisionTokens } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { MemoryGate, GATE_QUESTIONS, WORK_QUESTION, Socrates, workState } from "../src";
import { decisionImages } from "../src/attachments";
import { requestTokens } from "../src/model-budget";

loadEvaluationEnvironment();
assert(process.env.OPENROUTER_API_KEY, "OpenRouter key required");
const settings = process.env.SOCRATES_SETTINGS_FILE ? JSON.parse(readFileSync(process.env.SOCRATES_SETTINGS_FILE,"utf8")) : {};
const chat = settings.chat ?? {provider:"deepseek",model:"deepseek-flash",effort:"high"};
const raw = new OpenRouterDecider({apiKey:process.env.OPENROUTER_API_KEY});
let cost = 0; let inputTokens = 0;
const requests: DecisionRequest[] = [];
const decider = {id:raw.id, async decide(r:DecisionRequest, signal?:AbortSignal) {
  requests.push(r);
  const start = performance.now();
  const out = await raw.decide(r, signal);
  cost += out.usage.costUsd ?? 0; inputTokens += out.usage.inputTokens;
  console.log(JSON.stringify({stage:Object.keys(r.questions).join("+"),images:r.images?.length??0,estimate:decisionTokens(r),actual:out.usage.inputTokens,ms:Math.round(performance.now()-start),scores:out.probabilities,model:out.model}));
  return out;
}};
const base = path.resolve(".socrates/evals"); mkdirSync(base,{recursive:true});
const dir = realpathSync(mkdtempSync(path.join(base,"decision-input-")));
const pause = () => new Promise(resolve=>setTimeout(resolve,1200));
const image = (file:string):Attachment => ({id:"a".repeat(32),name:"attachment.png",path:file,width:1000,height:500,media_type:"image/png",bytes:100});
const final = (answer:string) => ({text:JSON.stringify({full_answer:answer,continuation_note:"Verified one-off edit completed; no remaining work.",goal_note:null,task_complete:null,anchors:[]})});

async function main() {
  // The answer to these control questions is available ONLY in the pixels.
  const file = path.join(dir,"attachment.png");
  await sharp(Buffer.from('<svg width="1000" height="400"><rect width="1000" height="400" fill="white"/><text x="35" y="140" font-size="42" fill="black">Remember my standing preference:</text><text x="35" y="220" font-size="42" fill="black">Always use pnpm, never npm.</text></svg>')).png().toFile(file);
  const images = (await decisionImages([image(file)])).images;
  const control = {yes:{instructions:"Does the image say to ALWAYS use pnpm?",yes:"It says always use pnpm.",no:"It says otherwise."},no:{instructions:"Does the image say to ALWAYS use npm instead of pnpm?",yes:"It says always use npm.",no:"It says otherwise."}};
  if (!process.env.DECISION_RUNTIME_ONLY) {
  for (let i=0;i<3;i++) {
    await pause();
    const vision = await decider.decide({state:"Read the attached image.",images,questions:control},AbortSignal.timeout(30000));
    assert(vision.probabilities.yes!>.8 && vision.probabilities.no!<.2,"Pixel-only contrast must distinguish the words");
    await pause();
    const before = await decider.decide({state:"# RECENT_CONVERSATION\nnone\n# CURRENT_REQUEST\nRead my attached note.",images,questions:GATE_QUESTIONS},AbortSignal.timeout(30000));
    assert(before.probabilities.save!>=.4,"Image-only preference must be considered for saving");
  }
  // A long answer's decisive verified lesson is beyond the old 800-character prefix.
  await pause();
  const answer = "I inspected the worker and its build logs. ".repeat(300) + "The work is now verified: we repeatedly reproduced the stale generated-client failure, fixed it by regenerating the client BEFORE building, and ran the complete regression suite successfully twice. For every future schema change the reliable procedure is update schema, regenerate client, rebuild, run the regression suite. This ordering avoids the same failure.";
  const state = workState({request:"Investigate and fix the recurring generated-client failure.",answer,calls:[]});
  assert(state.includes(answer));
  const after = await decider.decide({state,images,questions:{work:WORK_QUESTION}},AbortSignal.timeout(30000));
  assert(after.probabilities.work!>=.5,"Late verified procedure must reach the work classifier");
  await pause();
  const large = workState({request:"Investigate the recurring generated-client failure.",calls:[],answer:"Inspection log row: unchanged.\n".repeat(15000)+"Verified the recurring fix: regenerate client BEFORE build, then run regressions. Two full test passes confirm the procedure for all future schema changes."});
  const largeRequest = {state:large,images,questions:{work:WORK_QUESTION}};
  assert(decisionTokens(largeRequest)>100000 && decisionTokens(largeRequest)<=DECIDER_INPUT_TOKENS);
  const largeGate = new MemoryGate({decider});
  const largeResult = await largeGate.readWork({...largeRequest,trace:{role:"decision"}});
  assert(largeResult!==null && largeResult>=.5,"Large complete finished turn must classify within the background allowance");

  }

  // Real runtime, real gates at BOTH stages; deterministic foreground makes
  // the input oracle exact, while the overflow assessor is the real main model.
  for (const overflow of [false,true]) {
    await pause();
    const root = path.join(dir,overflow?"overflow":"images"); mkdirSync(root);
    const store = LedgerStore.open({path:path.join(root,"ledger.db")});
    const goal = store.createGoal({title:"Synthetic memory fixture"});
    store.bindGoalWorkspace(goal.id,store.createWorkspace("fixture",root).id);
    const task = store.createTask(goal.id,{title:"One-off edit"});
    const answer = overflow ? "A one-off cosmetic note was changed; no procedure was established. ".repeat(17000)+"Finished, nothing reusable." : "Updated the one-off note, no recurring lesson was established.";
    const scripted = new ScriptedModel("fixture",[{toolCalls:[{name:"edit",input:{path:"note.txt",old_text:"",new_text:"one-off"}}]},final(answer)]);
    const inner = makeModel(chat.provider,chat.model);
    let assessments = 0;
    const model:ModelClient = {id:inner.id,vision:inner.vision,async complete(r) {
      if(!r.tools?.some(t=>t.name==="work_memory")) return scripted.complete(r);
      assessments++;
      assert(requestTokens(r.system,r.messages,r.tools)<=60000);
      assert.deepEqual(r.tools?.map(t=>t.name),["work_memory","context_retrieve"]);
      const response = await inner.complete({...r,effort:chat.effort??"high"});
      console.log(JSON.stringify({stage:"main-agent-assessment",model:response.servedBy??inner.id,input:response.usage.promptTokens,cached:response.usage.cacheReadTokens,tools:response.toolCalls.map(t=>t.name)}));
      return response;
    }};
    const gate = new MemoryGate({decider,log:m=>console.log(m)});
    const socrates = new Socrates({store,model,timeZone:settings.timeZone??"Europe/Vienna",gate:()=>gate,memory:()=>({use:true,save:true}),approve:async()=>true,workMemoryDir:path.join(root,"memory")});
    const before = requests.length;
    try {
      const result = await socrates.handle("Update note.txt to one-off. This is only a temporary cosmetic change.",{target:{taskId:task.id},...(!overflow?{attachments:[image(file)]}:{})});
      if (result.kind !== "answered" || result.text !== answer) console.log(JSON.stringify({kind:result.kind, detail:result.kind === "answered" ? result.text.slice(0,300) : result, warnings:store.listEvents({type:"agent_warning"}).map(e=>e.payload)}));
      assert(result.kind==="answered" && result.text===answer,"Original full answer must survive");
      await socrates.workMemoryIdle();
      const step = store.listEvents({type:"work_memory_step"}).at(-1)!.payload as EventPayloads["work_memory_step"];
      if(overflow) {
        assert(step.decision?.fallback?.includes("exceeds")); assert(assessments>0);
        assert.equal(requests.length-before,1,"Overflow must bypass work classifier");
        assert.equal(step.outcome,"nothing"); assert.equal(step.writes,0);
      } else {
        assert.equal(requests.length-before,2); assert.equal(requests.at(-1)!.images?.length,1);
        assert(requests.at(-1)!.state.includes(answer)); assert.equal(step.outcome,"not_worth");
      }
      assert.equal(readFileSync(path.join(root,"note.txt"),"utf8"),"one-off");
      assert.equal(store.listEvents({type:"work_memory_written"}).length,0);
      console.log(`PASS runtime ${overflow?"overflow: real agent correctly saved nothing":"both stages received pixels"}; ${step.outcome}`);
    } finally { await socrates.close(); store.close(); }
  }
  await pause();
  // Entire foreground and memory writer use the real configured agent here.
  const root = path.join(dir,"verified-lesson"); mkdirSync(root);
  writeFileSync(path.join(root,"slug.mjs"), 'export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");\n');
  writeFileSync(path.join(root,"slug.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; import {slug} from "./slug.mjs"; test("accented words",()=>{assert.equal(slug("Crème Brûlée"),"creme-brulee");assert.equal(slug("École"),"ecole");});\n');
  const store = LedgerStore.open({path:path.join(root,"ledger.db")});
  const goal = store.createGoal({title:"Synthetic normalization project"});
  store.bindGoalWorkspace(goal.id,store.createWorkspace("fixture",root).id);
  const task = store.createTask(goal.id,{title:"Verified normalization lesson"});
  const inner = makeModel(chat.provider,chat.model);
  const model:ModelClient = {id:inner.id,vision:inner.vision,async complete(r) {
    const response = await inner.complete({...r,effort:chat.effort??"high"});
    console.log(JSON.stringify({stage:r.tools?.some(t=>t.name==="work_memory")?"real-memory-writer":"real-foreground",model:response.servedBy??inner.id,input:response.usage.promptTokens,cached:response.usage.cacheReadTokens,tools:response.toolCalls.map(t=>t.name)}));
    return response;
  }};
  const socrates = new Socrates({store,model,timeZone:settings.timeZone??"Europe/Vienna",gate:()=>new MemoryGate({decider}),memory:()=>({use:true,save:true}),approve:async()=>true,workMemoryDir:path.join(root,"memory")});
  try {
    const result = await socrates.handle("Our slug helper repeatedly fails on accented input. Reproduce with node --test slug.test.mjs, fix it and rerun the tests. Retain the verified reusable lesson about normalization order for our future text helpers in project memory; do not document unverified guesses.",{target:{taskId:task.id}});
    assert.equal(result.kind,"answered"); await socrates.workMemoryIdle();
    const step = store.listEvents({type:"work_memory_step"}).at(-1)!.payload as EventPayloads["work_memory_step"];
    assert.equal(step.outcome,"written",JSON.stringify(step)); assert(step.writes>0);
    const fresh = store.createTask(goal.id,{title:"Recall verified procedure"});
    const recalled = await socrates.handle("Open our project memory about the accent bug and tell me the verified normalization order. Do not run commands or change files.",{target:{taskId:fresh.id}});
    assert.equal(recalled.kind,"answered");
    const evidence = store.evidenceForTurn(store.turnsForTask(fresh.id).at(-1)!.id);
    assert(evidence.some(e=>e.tool==="context_retrieve" && /topic:/.test(JSON.stringify(e.input))),"Fresh chat must actually retrieve the topic");
    console.log("PASS real DeepSeek foreground, verified lesson saved, fresh-task topic retrieval");
  } finally {await socrates.close(); store.close();}
  console.log(JSON.stringify({result:"PASS",budget:DECIDER_INPUT_TOKENS,decisionCalls:requests.length,decisionInputTokens:inputTokens,decisionCost:cost}));
}
main().catch(e=>{console.error(`FAIL ${e.message}`);process.exitCode=1;}).finally(()=>rmSync(dir,{recursive:true,force:true}));
