/** Isolated, independent and sequential router evaluation. Source transcripts stay local.
 * SOCRATES_ENV_FILE=.env SOCRATES_REPLAY_SOURCE=/path/to/socrates.jsonl JOB_REPLAY_SOURCE=/path/to/job.jsonl pnpm exec tsx packages/router/eval/run-context-routing-eval.ts
 */
import { readFileSync } from 'node:fs';
import { type CallRecord, type EventPayloads } from '@socrates/contracts';
import { makeModel, withRecording, reportedCost } from '@socrates/providers';
import { LedgerStore } from '@socrates/store';
import { fixedClock } from '@socrates/shared';
import { GoalRouter, type RoutingResult } from '../src';
import { loadEvaluationEnvironment } from './environment';
loadEvaluationEnvironment();
interface Source { at: string; request: string; answer: string }
function source(file: string): Source[] {
  const rows: Source[] = [];
  for (const line of readFileSync(file,'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line), p = e.payload;
    if (e.type !== 'response_item' || p?.type !== 'message') continue;
    let text = (p.content ?? []).map((c: {text?: string}) => c.text ?? '').join('\n');
    if (p.role === 'user' && !/^(<environment_context>|# AGENTS.md|<external)/.test(text)) {
      text = text.split('## My request:').at(-1)!.replace(/<image[\s\S]*?<\/image>/g,'').trim();
      rows.push({at:e.timestamp, request:text, answer:''});
    } else if (p.role === 'assistant' && ['final','final_answer'].includes(p.phase) && rows.length) {
      rows.at(-1)!.answer = text.replace(/\/Users\/[^\s)\]>]+/g,'[local path]');
    }
  }
  return rows;
}
if (!process.env.SOCRATES_REPLAY_SOURCE || !process.env.JOB_REPLAY_SOURCE) throw Error('Set both local source log paths; this eval never reads or writes the live ledger.');
const s = source(process.env.SOCRATES_REPLAY_SOURCE), j = source(process.env.JOB_REPLAY_SOURCE);
const grouped = (rows: Source[], from: number, to: number): Source => ({at: rows[from]!.at, request: rows.slice(from,to+1).map(r=>r.request).join('\n\n'), answer: rows.slice(from,to+1).map(r=>r.answer).filter(Boolean).join('\n\n')});
const cases = [
  {id:'S-header', source:s[1]!, history:grouped(s,1,2), goal:'s', task:'header', title:'Standardize Flow and Standard header', objective:'Make the Flow and Standard header and sidebar consistent.', expected:'new'},
  {id:'S-startup', source:s[3]!, history:grouped(s,3,4), goal:'s', task:'startup', title:'Start reopened app in Flow', objective:'Open in Flow after reopening while preserving Standard for the current app session.', expected:'new'},
  {id:'S-header-return', source:s[5]!, history:grouped(s,5,6), goal:'s', task:'header', title:'Standardize Flow and Standard header', objective:'Make the Flow and Standard header and sidebar consistent.', expected:'resume'},
  {id:'S-general-diagnosis', source:s[7]!, history:s[7]!, goal:'s', task:'diagnosis', title:'Diagnose General terminal routing', objective:'Investigate missing Standard General history and terminal workspace routing failures.', expected:'new'},
  {id:'R-recover', source:j[0]!, history:j[0]!, goal:'j', task:'recover', title:'Recover Rabobank role details', objective:'Recover the preserved Rabobank vacancy, CV and application details from the Job search records.', expected:'new'},
  {id:'R-prepare', source:j[1]!, history:j[1]!, goal:'j', task:'prepare', title:'Prepare for the Rabobank interview', objective:'Prepare for the Rabobank role using the submitted application and relevant technical topics.', expected:'either'},
];
function setup() {
  const clock = fixedClock(s[0]!.at), store = LedgerStore.open({path:':memory:', clock});
  const a = store.createGoal({title:'Socrates development', objective:'Develop and improve the Socrates application.', workspaceId:store.createWorkspace('Socrates','/fixture/Socrates').id});
  const b = store.createGoal({title:'Job search', objective:'Manage applications and interview preparation.', workspaceId:store.createWorkspace('job-search','/fixture/job-search').id});
  const tasks = new Map<string,string>();
  const seed = (row: Source, goalId: string, taskId: string) => { clock.set(row.at); const t = store.bindTurn({userEventId:store.recordUserMessage(row.request).id, taskId, route:'continue_current'}); store.completeTurn(t.id,{responseEventId:store.recordResponse(row.answer || '(No final answer recorded in the source session.)').id}); };
  const task = store.createTask(a.id,{title:'Understand the Socrates repository',objective:'Read AGENTS.md, docs and current code to orient before requested changes.',completionCriteria:'Report current repository context.'});
  seed(s[0]!,a.id,task.id);
  return {store,clock,tasks,goals:{s:a.id,j:b.id},seed};
}
const metrics = {calls:0,prompt:0,cache:0,cost:0, models:new Set<string>()};
const sink = (c: CallRecord) => {metrics.calls++; metrics.prompt += c.response?.usage.promptTokens ?? 0; metrics.cache += c.response?.usage.cacheReadTokens ?? 0; metrics.cost += c.cost?.usd ?? reportedCost(c.response?.meta) ?? 0; metrics.models.add(c.model);};
const routerModel = withRecording(makeModel('openrouter','openai/gpt-6-luna'), sink);
const results: unknown[] = [];
function judged(c: typeof cases[number], result: RoutingResult, w: ReturnType<typeof setup>): boolean {
  if (result.kind !== 'routed') return false;
  const parts = result.parts;
  if (parts.some(p=>p.goal.id !== w.goals[c.goal as 's'|'j'])) return false;
  if (c.expected==='resume') return parts.length===1 && parts[0]!.task.id===w.tasks.get(c.task);
  if (c.expected==='either') return parts.length===1 && (parts[0]!.created.task || parts[0]!.task.id===w.tasks.get('recover'));
  return (c.id==='S-general-diagnosis' || parts.length===1) && parts.every(p=>p.created.task && !p.created.goal);
}
for (const mode of ['independent','sequence'] as const) for (let repeat=1;repeat<=3;repeat++) {
  let sequence = setup();
  for (let index=0;index<cases.length;index++) {
    const w = mode==='sequence' ? sequence : setup();
    try {
      if (mode==='independent') for (const prior of cases.slice(0,index)) {
        let id=w.tasks.get(prior.task);
        if (!id) {id=w.store.createTask(w.goals[prior.goal as 's'|'j'],{title:prior.title,objective:prior.objective,completionCriteria:`${prior.objective} Verified and explained.`}).id;w.tasks.set(prior.task,id);}
        w.seed(prior.history,w.goals[prior.goal as 's'|'j'],id);
      }
      const c=cases[index]!; w.clock.set(c.source.at);
      const router = new GoalRouter({store:w.store,routerModel,timeZone:'Europe/Vienna',effort:'off',defaultFolder:()=>'/fixture'});
      const start=Date.now(), result=await router.route(c.source.request);
      const event=w.store.listEvents({type:'routing_completed'}).at(-1)!.payload as EventPayloads['routing_completed'];
      const pass=judged(c,result,w);
      const report={mode,repeat,id:c.id,pass,ms:Date.now()-start,kind:result.kind,destinations:result.kind==='routed'?result.parts.map(p=>({goal:p.goal.title,task:p.task.title,created:p.created})):[],repairs:event.validation_errors??[],diagnostics:event.diagnostics,ledgerQueries:event.ledger_queries,fallback:event.fallback,escalated:event.escalated};
      results.push(report);process.stdout.write(JSON.stringify(report)+'\n');
      if (mode==='sequence') {
        if (result.kind!=='routed') break;
        for (const p of result.parts) w.store.completeTurn(p.turn.id,{responseEventId:w.store.recordResponse(c.history.answer || '(No recorded final answer.)').id});
        if (pass) w.tasks.set(c.task,result.parts[0]!.task.id);
      }
    } finally {if(mode==='independent') w.store.close();}
  }
  sequence.store.close();
}
process.stdout.write(JSON.stringify({summary:results,metrics:{...metrics,models:[...metrics.models]}})+'\n');
