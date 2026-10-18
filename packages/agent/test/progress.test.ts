import { describe, expect, it } from 'vitest';
import { continueTask } from '../../router/test/helpers';
import type { ProgressStage } from '../src';
import { final, world } from './helpers';

describe('progress stages before work (web.md, "Routing line")', () => {
  it('Flow reports routing, an earlier-task search, then preparing and starting, in order', async () => {
    const w = await world();
    const { socrates } = w.socrates([{ toolCalls: [{ name: 'ledger_query', input: { match: 'equation' } }] }, continueTask()], [final({})]);
    const stages: ProgressStage[] = [];
    await socrates.handle('Why subtract first?', { onProgress: s => stages.push(s) });
    expect(stages).toEqual(['routing', 'searching', 'routing', 'preparing', 'starting']);
  });

  it('reports a repair as rechecking', async () => {
    const w = await world();
    const { socrates } = w.socrates([{ text: 'not json' }, continueTask()], [final({})]);
    const stages: ProgressStage[] = [];
    await socrates.handle('Continue.', { onProgress: s => stages.push(s) });
    expect(stages.slice(0, 2)).toEqual(['routing', 'rechecking']);
    expect(stages.slice(-2)).toEqual(['preparing', 'starting']);
  });

  it('Standard skips routing: preparing, then starting', async () => {
    const w = await world();
    const { socrates } = w.socrates([], [final({})]);
    const stages: ProgressStage[] = [];
    await socrates.handle('Next step?', { target: { taskId: w.taskId }, alongside: true, onProgress: s => stages.push(s) });
    expect(stages).toEqual(['preparing', 'starting']);
  });
});
