import {describe,it,expect} from 'vitest';
import {general,routerWith,setup} from './helpers';
const input=()=>JSON.parse(general().text!);
describe('native routing result transport',()=>{
 it('preserves logical schema and records a native decision without a repair',async()=>{
  const {store}=setup(); const {router,routerModel}=routerWith(store,[{toolCalls:[{name:'routing_result',input:input()}]}]);
  const result=await router.route('Hello'); expect(result.kind).toBe('routed');
  expect(routerModel.requests[0]!.tools!.map(t=>t.name)).toContain('routing_result');
  expect(store.listEvents({type:'routing_completed'}).at(-1)!.payload).toMatchObject({diagnostics:{invalidFinal:0,invalidTools:0,semanticErrors:0,resultTransport:'native routing_result'}});
 });
 it('distinguishes a malformed tool call from an invalid final and bounds correction',async()=>{
  const {store}=setup(); const {router}=routerWith(store,[{toolCalls:[{name:'ledger_query',input:{limit:'invalid'}}]}, {toolCalls:[{name:'routing_result',input:{bad:true}}]}, {toolCalls:[{name:'routing_result',input:input()}]}]);
  await router.route('Hello');
  expect(store.listEvents({type:'routing_completed'}).at(-1)!.payload).toMatchObject({diagnostics:{invalidFinal:1,invalidTools:1,semanticErrors:0}});
 });
 it('rejects a final bundled with lookups before executing either',async()=>{
  const {store}=setup(); const {router}=routerWith(store,[{toolCalls:[{name:'routing_result',input:input()},{name:'ledger_query',input:{action:'search',query:'x'}}]},{toolCalls:[{name:'routing_result',input:input()}]}]);
  await router.route('Hello'); expect(store.listEvents({type:'routing_completed'}).at(-1)!.payload).toMatchObject({ledger_queries:0,diagnostics:{invalidFinal:1}});
 });
});
