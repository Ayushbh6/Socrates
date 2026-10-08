import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/lib/store';
import { api } from '../src/lib/api';
import type { History, Settings, Status } from '../src/lib/types';

vi.mock('../src/lib/api', () => ({ api: { status: vi.fn(), settings: vi.fn(), goals: vi.fn(), history: vi.fn() } }));
class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(_url: string) { Socket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const settings: Settings = { chat: null, router: null, compactor: null, embeddings: {provider:'ollama', model:null, url:null}, access: {scope:'folders',folders:[],approvals:'ask'}, timeZone:null, workingFolder:null, profile:{name:null,onboarded:true}, prices:{} };
const status: Status = { ready:true, setup:[], home:'/test', access:settings.access, profile:settings.profile, models:{chat:null,router:null,compactor:null}, embeddings:{...settings.embeddings,state:'ready',detail:null,index:null}, timeZone:'UTC', workingFolder:null, busy:false, lanes:[], seq:100 };
const live = (seq = 100, options = {}) => ({ type:'state', ...status, seq, queue:[], approvals:[], settings, ...options });
const snapshot: History = { seq:200, next:null, items:[{ id:'message',seq:10,throughSeq:200,at:'2026-10-04',message:'Still working',unrouted:false,question:null,activities:[],parts:[{turnId:'turn',projectTurn:1,status:'in_progress',goal:{number:1,title:'Goal'},task:{number:1,title:'Task'},chat:1,lane:null,handedOff:false,answer:null,interrupted:null,toolCalls:[]}] }] };

beforeEach(() => {
  vi.resetAllMocks(); Socket.all = [];
  vi.stubGlobal('WebSocket',Socket); vi.stubGlobal('location',{protocol:'http:',host:'127.0.0.1:4208'});
  vi.mocked(api.status).mockResolvedValue(status); vi.mocked(api.settings).mockResolvedValue(settings);
  vi.mocked(api.goals).mockResolvedValue([]); vi.mocked(api.history).mockResolvedValue({ items:[], next:null, seq:100 });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('history recovery and unsent text', () => {
  it('restores a rejected queued message without overwriting a newer draft', async () => {
    const store = new Store(); await store.start(); const socket = Socket.all[0]!; socket.open();
    expect(store.queue('The rejected message')).toEqual(expect.any(String));
    const id = socket.sent.at(-1)!.id;
    store.setDraft('main','A newer unsent draft');
    socket.receive({type:'error',id,code:'queue_full',message:'The queue is full.'});
    expect(store.get().drafts.main).toBe('A newer unsent draft');
    expect(store.get().model.conversations.main!.at(-1)).toMatchObject({message:'The rejected message',state:'failed',note:'The queue is full.'});
  });

  it('preserves a main-busy message if the fallback queue loses its connection', async () => {
    const store = new Store(); await store.start(); const socket = Socket.all[0]!; socket.open();
    const id = store.send('Keep the fallback','main');
    socket.readyState = 3;
    socket.receive({type:'error',id,code:'main_busy',message:'Main is busy.'});
    expect(store.get().drafts.main).toBe('Keep the fallback');
    expect(store.get().model.conversations.main!.at(-1)).toMatchObject({message:'Keep the fallback',state:'failed'});
  });
  it('preserves drafts and refuses commands while disconnected', async () => {
    const store = new Store(); await store.start();
    store.setDraft('main','Keep this message');
    expect(store.send('Keep this message','main')).toBeNull();
    expect(store.queue('Keep this message')).toBeNull();
    expect(store.get().drafts.main).toBe('Keep this message');
    expect(store.get().model.conversations.main).toEqual([]);
    Socket.all[0]!.open();
    expect(store.queue('Keep this message')).toEqual(expect.any(String));
  });

  it('pauses delivery during reset, reconnects from the snapshot and accepts the current draft once', async () => {
    const store = new Store(); await store.start(); const first = Socket.all[0]!; first.open(); first.receive(live());
    store.setDraft('main','Unsent text');
    let release!: (page: History) => void;
    vi.mocked(api.history).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    first.receive({type:'reset',seq:200});
    expect(store.get().connected).toBe(false);
    await vi.waitFor(() => expect(release).toBeDefined());
    first.receive({type:'draft',conversation:'main',turnId:'turn',call:1,kind:'answer',text:'Stale socket'});
    release(snapshot);
    await vi.waitFor(() => expect(Socket.all).toHaveLength(2));
    const second = Socket.all[1]!; second.open();
    expect(second.sent[0]).toEqual({type:'hello',after:200});
    second.receive(live(210));
    second.receive({type:'draft',conversation:'main',turnId:'turn',call:1,kind:'answer',text:'Current answer'});
    expect(store.get().model.conversations.main).toHaveLength(1);
    expect(store.get().model.conversations.main![0]!.draft?.text).toBe('Current answer');
    expect(store.get().model.seq).toBe(200);
    expect(store.get().drafts.main).toBe('Unsent text');
  });

  it('uses snapshots when an unfinished message is beyond the replay window', async () => {
    vi.mocked(api.status).mockResolvedValue({...status,seq:6000});
    vi.mocked(api.history).mockResolvedValue({...snapshot,seq:6000});
    const store = new Store(); await store.start(); Socket.all[0]!.open();
    expect(Socket.all[0]!.sent[0]).toEqual({type:'hello',after:6000});
    expect(store.get().model.conversations.main![0]!.open).toEqual(['turn']);
  });

  it('reports a failed older-history request and permits a retry', async () => {
    vi.mocked(api.history).mockResolvedValueOnce({items:[],next:50});
    const store = new Store(); await store.start();
    vi.mocked(api.history).mockRejectedValueOnce(new Error('History temporarily unavailable'));
    await store.loadOlder('main');
    expect(store.get().model.notices.at(-1)?.text).toBe('History temporarily unavailable');
    expect(store.get().older.main).toBe(50);
    vi.mocked(api.history).mockResolvedValueOnce({items:[],next:null});
    await store.loadOlder('main');
    expect(store.get().older.main).toBeNull();
  });

  it('refreshes another tab\'s settings even when readiness never changes', async () => {
    const store = new Store(); await store.start(); const socket = Socket.all[0]!; socket.open(); socket.receive(live());
    const changed = {...settings,timeZone:'Europe/Vienna'};
    vi.mocked(api.settings).mockResolvedValue(changed);
    vi.mocked(api.status).mockResolvedValue({...status,timeZone:'Europe/Vienna'});
    socket.receive(live(101,{settings:changed}));
    await vi.waitFor(() => expect(store.get().status?.timeZone).toBe('Europe/Vienna'));
    expect(store.get().settings?.timeZone).toBe('Europe/Vienna');
  });
});

describe('attached images', () => {
  const image = { id: 'a'.repeat(32), name: 'label.png', media_type: 'image/png', width: 400, height: 400, bytes: 11499 };

  it('sends their ids and names, shows them on the question at once, and gives a rejected queue its images back', async () => {
    const store = new Store(); await store.start(); const socket = Socket.all[0]!; socket.open();
    socket.receive(live());
    expect(store.send('What does it say?', 'main', [image])).toBeTruthy();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'send', text: 'What does it say?', to: 'main', attachments: [{ id: image.id, name: 'label.png' }] });
    expect(store.get().model.conversations.main!.at(-1)!.attachments).toEqual([image]);
    // A plain message carries no attachments field at all.
    store.send('Plain', 'main');
    expect(socket.sent.at(-1)).not.toHaveProperty('attachments');

    expect(store.queue('Later, with the label', [image])).toEqual(expect.any(String));
    const id = socket.sent.at(-1)!.id;
    socket.receive({ type: 'error', id, code: 'queue_full', message: 'The queue is full.' });
    expect(store.get().images.main!.map((i) => [i.status, i.attachment?.id])).toEqual([['ready', image.id]]);
  });
});
