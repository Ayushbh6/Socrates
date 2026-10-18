import type { LedgerStore } from '@socrates/store';

/** Calendar months, clamped at month end (not a guessed number of days). */
export function inactivityCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const last = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, last));
  return cutoff;
}

export function archiveInactiveTasks(store: LedgerStore, months: number | null, busy: (taskId: string) => boolean): number {
  if (months === null) return 0;
  const cutoff = inactivityCutoff(store.clock.now(), months).toISOString();
  let count = 0;
  for (const goal of store.listGoals()) {
    if (goal.general || goal.archivedAt) continue;
    for (const task of store.listTasks(goal.id)) {
      if (task.general || task.archivedAt || busy(task.id)) continue;
      const last = store.taskLastActivity(task.id);
      if (last <= cutoff) { store.archiveTask(task.id, { source: 'inactivity', months, last_activity_at: last }); count++; }
    }
  }
  return count;
}
