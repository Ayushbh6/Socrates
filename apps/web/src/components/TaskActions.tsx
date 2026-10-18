import { useEffect, useState } from 'react';
import { store, useApp } from '../lib/store';
import type { GoalView } from '../lib/types';
import { Popover } from './Popover';

/** Shared lifecycle controls: the task id and revision are frozen while confirming. */
export function TaskActions({ goal, task, advanced = false }: { goal: GoalView; task: GoalView['tasks'][number]; advanced?: boolean }) {
  const app = useApp();
  const [confirm, setConfirm] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(false);
  const live = app.model.live;
  const busy = !!live?.working?.some(t => t.goal === goal.number && t.task === task.number) ||
    !!live?.queue.length || (!!live?.busy && !live.working?.length);
  useEffect(() => { setConfirm(null); setNotice(false); }, [goal.number, task.number]);
  const setStatus = async (status: 'open' | 'completed' | 'superseded', revision = task.revision) => {
    setSaving(true);
    try {
      if (await store.setStatus({ goal: goal.number, task: task.number }, status, revision)) { setConfirm(null); setNotice(status === 'completed'); }
    } finally { setSaving(false); }
  };
  if (goal.general) return null;
  return <div className="task-actions" onClick={e => e.stopPropagation()}>
    <span className="task-state" role="status">{busy ? 'Working…' : task.status === 'completed' ? (task.closed?.by === 'user' ? 'Completed by you' : 'Completed') : task.status === 'superseded' ? 'Superseded' : 'Open'}</span>
    <button type="button" className="quiet-button" aria-haspopup={task.status === "open" ? "dialog" : undefined} aria-expanded={task.status === "open" ? confirm !== null : undefined} disabled={busy || saving} title={busy ? 'Available after this response and queued work finish.' : undefined}
      onClick={() => task.status === 'open' ? setConfirm(task.revision ?? 0) : void setStatus('open')}>
      {saving ? 'Saving…' : task.status === 'open' ? 'Mark complete' : notice ? 'Undo' : 'Reopen'}
    </button>
    {advanced && task.status !== 'superseded' && <button type="button" className="quiet-button" disabled={busy || saving} title="This task was replaced by other work." onClick={() => void setStatus('superseded')}>Mark superseded</button>}
    {confirm !== null && <Popover role="dialog" label={`Complete ${task.title}`} align="left" onClose={() => setConfirm(null)} className="task-confirm">
      <strong>Mark “{task.title}” complete?</strong>
      <p>Its history stays available. You can reopen it anytime.</p>
      <div className="task-confirm-actions">
        <button type="button" autoFocus className="quiet-button" onClick={() => setConfirm(null)}>Cancel</button>
        <button type="button" className="solid-button" disabled={saving || busy} onClick={() => void setStatus('completed', confirm || undefined)}>Mark complete</button>
      </div>
    </Popover>}
    {notice && task.status === 'completed' && <span className="sr-only" role="status">Task marked complete. Undo is available.</span>}
  </div>;
}
