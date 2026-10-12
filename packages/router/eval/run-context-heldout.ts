/** Held-out destination checks. No private source material or live ledger. */
import {makeModel} from '@socrates/providers';
import {fixedClock} from '@socrates/shared';
import {LedgerStore} from '@socrates/store';
import {GoalRouter} from '../src';
import {loadEvaluationEnvironment} from './environment';
loadEvaluationEnvironment();
const model=makeModel('openrouter','openai/gpt-6-luna');
const cases=[
 {id:'regression-return',message:'Atlas navigation contrast regressed after the invoice change. Fix the navigation contrast and verify it.',owner:'atlas/nav'},
 {id:'same-objective',message:'The Atlas invoice export still drops the last row. Fix that and update its test results.',owner:'atlas/invoices'},
 {id:'new-deliverable',message:'Add a calendar export to Atlas. This is a new feature separate from invoices.',owner:'atlas/new'},
 {id:'other-project',message:'Return to the Boreal login redirect and check its logout case.',owner:'boreal/login'},
 {id:'plain-general',message:'Good morning! How are you?',owner:'general'},
 {id:'genuine-ambiguity',message:'One of Atlas and Boreal needs its login redirect changed, but I have not told you which one yet. Ask me which app before choosing the task.',owner:'clarify'},
];
for(let repeat=1;repeat<=3;repeat++)for(const c of cases){
 const clock=fixedClock('2026-10-12T10:00:00Z'),store=LedgerStore.open({path:':memory:',clock});
 const owners=new Map<string,string>();
 try {
  for(const [name,tasks] of [['Atlas',['Navigation contrast','Login redirect','Invoice export']],['Boreal',['Login redirect']]] as const){
   const goal=store.createGoal({title:`${name} application`,objective:`Develop ${name}, a separate application.`,workspaceId:store.createWorkspace(name,`/fixture/${name}`).id});owners.set(name.toLowerCase(),goal.id);
   for(const title of tasks){
    const task=store.createTask(goal.id,{title,objective:`Implement and verify ${title.toLowerCase()} in ${name}.`,completionCriteria:`${title} works and its checks pass.`});
    owners.set(`${name.toLowerCase()}/${title==='Navigation contrast'?'nav':title==='Invoice export'?'invoices':'login'}`,task.id);
    const t=store.bindTurn({userEventId:store.recordUserMessage(`Please implement ${title} in ${name}.`).id,taskId:task.id,route:'standard'});
    store.completeTurn(t.id,{responseEventId:store.recordResponse(`${name}: ${title} implemented and checks passed.`).id});clock.advance(120000);
   }
  }
  const result=await new GoalRouter({store,routerModel:model,timeZone:'Europe/Vienna',effort:'off'}).route(c.message);
  const part=result.kind==='routed'?result.parts[0]:null;
  const pass=c.owner==='clarify'?result.kind==='clarify':c.owner==='general'?part?.goal.general===true:c.owner.endsWith('/new')?part?.goal.id===owners.get(c.owner.split('/')[0]!)&&part?.created.task===true:part?.task.id===owners.get(c.owner);
  console.log(JSON.stringify({repeat,id:c.id,pass,kind:result.kind,goal:part?.goal.title,task:part?.task.title,created:part?.created,routing:store.listEvents({type:'routing_completed'}).at(-1)?.payload}));
 }finally{store.close();}
}
