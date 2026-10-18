import { describe, expect, it } from 'vitest';
import { LedgerStore } from '@socrates/store';
import { fixedClock } from '@socrates/shared';
import { archiveInactiveTasks, inactivityCutoff } from '../src/task-archive';
import { Settings, SettingsPatch } from '../src/settings';

describe('inactive task archiving', () => {
  it('defaults to 12 months and accepts 3, 24, or disabled, rejecting invalid periods', () => {
    expect(Settings.parse({}).inactiveTaskMonths).toBe(12);
    for (const value of [3,12,24,null]) expect(SettingsPatch.parse({inactiveTaskMonths:value}).inactiveTaskMonths).toBe(value);
    for (const value of [0,25,1.5,-1]) expect(SettingsPatch.safeParse({inactiveTaskMonths:value}).success).toBe(false);
    expect(inactivityCutoff(new Date('2026-03-31T12:00:00Z'),1).toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(inactivityCutoff(new Date('2024-03-31T12:00:00Z'),1).toISOString()).toBe('2024-02-29T12:00:00.000Z');
  });
  it('archives idle tasks without completing them, skips busy and General, and gives restored tasks a fresh period', () => {
    const clock=fixedClock('2025-10-18T10:00:00Z');
    const store=LedgerStore.open({path:':memory:',clock});
    try {
      const g=store.createGoal({title:'Study'});
      const idle=store.createTask(g.id,{title:'Old work'});
      const busy=store.createTask(g.id,{title:'Still running'});
      const done=store.createTask(g.id,{title:'Finished'});
      store.setTaskStatus(done.id,'completed');
      const general=store.createGoal({title:'General',general:true});
      const daily=store.createTask(general.id,{title:'General day',general:true});
      clock.set(new Date('2026-10-18T10:00:00Z'));
      expect(archiveInactiveTasks(store,null,()=>false)).toBe(0);
      expect(archiveInactiveTasks(store,12,id=>id===busy.id)).toBe(2);
      expect(store.requireTask(idle.id)).toMatchObject({status:'open',archivedAt:expect.any(String)});
      expect(store.requireTask(done.id).status).toBe('completed');
      expect(store.requireTask(busy.id).archivedAt).toBeNull();
      expect(store.requireTask(daily.id).archivedAt).toBeNull();
      expect(store.requireGoal(g.id).status).toBe('open');
      expect(store.listEvents({type:'task_archived'})[0]!.payload).toMatchObject({source:'inactivity',months:12});
      store.restoreTask(idle.id);
      expect(archiveInactiveTasks(store,12,()=>true)).toBe(0);
      archiveInactiveTasks(store,12,id=>id===busy.id);
      expect(store.requireTask(idle.id).archivedAt).toBeNull();
      const replay=LedgerStore.open({path:':memory:',clock});
      try { replay.restoreEvents(store.listEvents()); expect(replay.requireTask(idle.id).archivedAt).toBeNull(); expect(replay.requireTask(done.id).archivedAt).not.toBeNull(); } finally { replay.close(); }
    } finally { store.close(); }
  });
});
