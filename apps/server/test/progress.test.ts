import { describe, expect, it } from 'vitest';
import { final } from '../../../packages/agent/test/helpers';
import { createGoal } from '../../../packages/router/test/helpers';
import { Responder, liveServer } from './helpers';

describe('routing progress (web.md, "Routing line")', () => {
  it('broadcasts each stage live and replays the trail to a page that joins mid-routing', async () => {
    let release!: () => void;
    const routing = new Promise<void>(r => release = r);
    const router = new Responder('r', async () => { await routing; return createGoal('Algebra', 'Linear equations'); });
    const agent = new Responder('a', async text => final({ full_answer: `Answer: ${text}` }));
    const s = await liveServer(router, agent);
    const page = await s.page();
    page.send({ type: 'hello' });
    page.send({ type: 'send', id: 'm1', text: 'Why subtract first?', to: 'main' });
    const first = await page.next(m => m.type === 'progress' && m.id === 'm1');
    expect(first).toMatchObject({ conversation: 'main', seq: expect.any(Number), trail: [{ stage: 'routing', at: expect.any(String) }] });
    const late = await s.page();
    late.send({ type: 'hello' });
    await expect(late.next(m => m.type === 'progress' && m.id === 'm1')).resolves.toMatchObject({ trail: [{ stage: 'routing' }] });
    release();
    const started = await page.next(m => m.type === 'progress' && m.id === 'm1' && m.trail.at(-1).stage === 'starting');
    expect(started.trail.map((x: { stage: string }) => x.stage)).toEqual(['routing', 'preparing', 'starting']);
    await page.next(m => m.type === 'result' && m.id === 'm1');
    // Live only: nothing about progress is saved to the ledger.
    expect(s.rt.store.listEvents().some(e => JSON.stringify(e.payload).includes('"preparing"'))).toBe(false);
  });
});
