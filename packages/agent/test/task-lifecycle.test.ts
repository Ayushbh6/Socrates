import { describe, expect, it } from 'vitest';
import { taskStatusRequest } from '@socrates/contracts';
import { LedgerStore } from '@socrates/store';
import { continueTask } from '../../router/test/helpers';
import { contextText, final, world } from './helpers';

describe('human-controlled task lifecycle', () => {
  it.each(['Thanks!', 'The answer is correct.', 'Do not close this task.', 'Should I close this task?', 'Say "mark this task complete"', 'If the tests pass, close this task.', 'Mark all tasks complete.'])('does not authorize closure from %s', text => {
    expect(taskStatusRequest(text)).toBeNull();
  });
  it.each(['Mark this task complete.', 'Okay, I think this task is complete now.', 'That resolves it. Mark this task completed.', 'Please close this task.'])('recognizes a direct instruction: %s', text => {
    expect(taskStatusRequest(text)).toEqual({status:'completed',conditional:false});
  });
  for (const mode of ['Flow', 'Standard']) {
    it(`${mode}: ignores autonomous completion, persists explicit closure, preserves follow-ups, and reopens on request`, async () => {
      const w = await world();
      const options = mode === 'Standard' ? {target:{taskId:w.taskId},alongside:true} : {};
      const {socrates, model} = w.socrates([continueTask(), continueTask()], [
        final({task_complete:{reason:'Criteria met'}}),
        () => { expect(w.store.requireTask(w.taskId).status).toBe('open'); return final({full_answer:'Marked complete.', task_complete:{reason:'Mark this task complete.'}}); },
        final({full_answer:'Here is why.',task_complete:{reason:'Already explained'}}),
        final({full_answer:'Reopened.'}),
      ]);
      await socrates.handle('Solve the equation.', options);
      expect(w.store.requireTask(w.taskId).status).toBe('open');
      await socrates.handle('Mark this task complete.', options);
      expect(w.store.requireTask(w.taskId).status).toBe('completed');
      expect(w.store.statusSource(w.taskId)).toMatchObject({by:'user',reason:'Mark this task complete.'});
      const event = w.store.listEvents({type:'task_status_set'}).at(-1)!;
      expect(event.payload).toMatchObject({source:'message',request_id:expect.any(String)});
      await socrates.handle('Why does that equation work?', options);
      expect(w.store.requireTask(w.taskId).status).toBe('completed');
      expect(contextText(model.requests[2]!)).toContain('status: completed');
      expect(contextText(model.requests[2]!)).toContain('status_source: user');
      await socrates.handle('Reopen this task.', options);
      expect(w.store.requireTask(w.taskId).status).toBe('open');
      expect(w.store.listTasks(w.goalId)).toHaveLength(1);
      const replay = LedgerStore.open({path:':memory:'});
      try { replay.restoreEvents(w.store.listEvents()); expect(replay.requireTask(w.taskId).status).toBe('open'); expect(replay.statusSource(w.taskId)?.by).toBe('user'); } finally { replay.close(); }
    });
  }
  it('defers an explicit closure while later work is queued for the task', async () => {
    const w = await world();
    const {socrates} = w.socrates([], [final({task_complete:{reason:'User requested completion'}})], {hasQueuedTask: () => true});
    const result = await socrates.handle('Mark this task complete.');
    expect(w.store.requireTask(w.taskId).status).toBe('open');
    expect(w.store.listEvents({type:'task_status_set'})).toHaveLength(0);
    expect(result.kind === 'answered' && result.text).toContain('Task status was not changed');
  });
  it('does not close conditional work after a failed command', async () => {
    const w = await world();
    const {socrates} = w.socrates([], [
      {toolCalls:[{name:'terminal',input:{command:'exit 1',timeout_ms:1000}}]},
      final({task_complete:{reason:'Run the test and then mark this task complete.'}}),
    ]);
    const result = await socrates.handle('Run the test and then mark this task complete.');
    expect(w.store.requireTask(w.taskId).status).toBe('open');
    expect(result.kind === 'answered' && result.text).toContain('Task status was not changed');
  });
});
