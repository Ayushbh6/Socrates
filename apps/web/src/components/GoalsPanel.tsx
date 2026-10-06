import { Check, ChevronRight, Circle, Minus } from "lucide-react";
import { useState } from "react";
import type { Exchange } from "../lib/model";
import type { GoalView } from "../lib/types";

/** Standard mode's left side: every goal with its tasks; the current one open, with its notes. */
export function GoalsPanel({ goals, route }: { goals: GoalView[]; route: Exchange["route"] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const shown = goals.filter((g) => !g.general);
  return (
    <nav className="goals-panel" aria-label="Goals">
      <p className="panel-label">Goals</p>
      {!shown.length && <p className="thread-empty">Goals appear here as you work with Socrates.</p>}
      <ul className="goal-list">
        {shown.map((goal) => {
          const current = route?.goal.number === goal.number;
          const expanded = open[goal.number] ?? current;
          const done = goal.tasks.filter((t) => t.status === "completed").length;
          return (
            <li key={goal.number} className="goal" data-current={current}>
              <button type="button" className="goal-head" onClick={() => setOpen({ ...open, [goal.number]: !expanded })} aria-expanded={expanded}>
                <ChevronRight aria-hidden className="goal-chevron" />
                <span className="goal-title">{goal.title}</span>
                <small>{done}/{goal.tasks.length}</small>
              </button>
              {expanded && (
                <div className="goal-body">
                  {goal.objective && <p className="goal-text">{goal.objective}</p>}
                  {goal.note && <p className="goal-text muted">{goal.note}</p>}
                  <ul className="task-list">
                    {goal.tasks.map((task) => {
                      const now = current && route?.task.number === task.number;
                      return (
                        <li key={task.number} className="task" data-current={now} data-status={task.status}>
                          {task.status === "completed" ? <Check aria-label="Completed" /> : task.status === "superseded" ? <Minus aria-label="Superseded" /> : <Circle aria-label="Open" />}
                          <div>
                            <span>{task.title}</span>
                            {now && task.note && <p className="goal-text muted">{task.note}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
