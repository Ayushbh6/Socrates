import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A small issue tracker served over stdio with the official MCP SDK, for the
 * capability tests and the live capabilities eval. Notes are appended to the
 * file named by FIXTURE_NOTES.
 */

const TICKETS: Record<string, string> = {
  "42": "TICKET-42: Checkout fails when the cart holds more than 50 items. Status: open. Owner: Mira. Root cause noted by support: the cart limit check uses > instead of >=. Code word: lantern-7.",
  "7": "TICKET-7: Dark mode toggle forgets its state after reload. Status: closed. Owner: Ade.",
};
const notesFile = process.env.FIXTURE_NOTES ?? "";
const notes = () => (notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").split("\n").filter(Boolean) : []);

// Each process start is recorded when FIXTURE_STARTS names a file, so tests can see when a server was launched.
if (process.env.FIXTURE_STARTS) appendFileSync(process.env.FIXTURE_STARTS, "start\n");

const server = new McpServer({ name: "tracker", version: "1.0.0" });

const ticketGet = server.registerTool(
  "ticket_get",
  { description: "Read one ticket from the issue tracker by its id, with status, owner, and support notes.", inputSchema: { id: z.string().describe("The ticket id, such as 42") }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const ticket = TICKETS[id.replace(/^TICKET-/i, "")];
    return ticket ? { content: [{ type: "text", text: ticket }] } : { content: [{ type: "text", text: `No ticket ${id}.` }], isError: true };
  },
);

server.registerTool(
  "note_add",
  { description: "Add a note to the tracker's shared notebook.", inputSchema: { text: z.string().min(1) }, annotations: { readOnlyHint: false } },
  async ({ text }) => {
    if (notesFile) appendFileSync(notesFile, `${text.replace(/\n/g, " ")}\n`);
    return { content: [{ type: "text", text: `Saved note #${notes().length}.` }] };
  },
);

server.registerTool(
  "note_list",
  { description: "List the notes in the tracker's shared notebook.", annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: notes().map((n, i) => `${i + 1}. ${n}`).join("\n") || "No notes." }] }),
);

server.registerTool(
  "reveal_extra",
  { description: "Register one more tool, extra_echo, announcing it with a tool list change.", annotations: { readOnlyHint: true } },
  async () => {
    server.registerTool("extra_echo", { description: "Echo text back.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
    return { content: [{ type: "text", text: "extra_echo is now available." }] };
  },
);

server.registerTool(
  "migrate_ticket_schema",
  { description: "Change ticket_get to take ticket_id instead of id, announcing it with a tool list change." },
  async () => {
    ticketGet.update({
      paramsSchema: { ticket_id: z.string().describe("The ticket id, such as 42") },
      callback: async ({ ticket_id }) => {
        const ticket = TICKETS[ticket_id.replace(/^TICKET-/i, "")];
        return ticket ? { content: [{ type: "text", text: ticket }] } : { content: [{ type: "text", text: `No ticket ${ticket_id}.` }], isError: true };
      },
    });
    return { content: [{ type: "text", text: "ticket_get now takes ticket_id." }] };
  },
);

await server.connect(new StdioServerTransport());
