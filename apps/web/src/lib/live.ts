import type { Command, ServerMessage } from "./types";

const RETRY_MS = [500, 1_000, 2_000, 5_000];

/**
 * The page's live connection (architecture/server.md, "Live connection").
 * It says hello from the newest event it has, and after a dropped connection
 * reconnects and catches up from there.
 */
export class LiveConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly on: { message(message: ServerMessage): void; connected(up: boolean): void; after(): number }) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
    this.on.connected(false);
  }

  /** False when the connection is down; the page says so instead of losing the command. */
  send(command: Command): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(command));
    return true;
  }

  private open(): void {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      socket.send(JSON.stringify({ type: "hello", after: this.on.after() } satisfies Command));
      this.on.connected(true);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.on.message(JSON.parse(String(event.data)) as ServerMessage);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.on.connected(false);
      if (this.stopped) return;
      this.timer = setTimeout(() => this.open(), RETRY_MS[Math.min(this.attempts++, RETRY_MS.length - 1)]);
    };
  }
}
