import type { ToolTimelineItem } from "./ToolTimelineTypes";
import { DiffView } from "./DiffView";
import { getEditFileSummaries, getPreferredEditDiffFiles } from "./editPresentation";

export function ToolDetails({ tool }: { tool: ToolTimelineItem }) {
  if (tool.toolName === "bash") {
    return <TerminalDetails tool={tool} />;
  }
  if (tool.toolName === "edit" || tool.toolName === "apply_patch") {
    return <EditDetails tool={tool} />;
  }
  if (tool.toolName === "search") {
    return <SearchDetails tool={tool} />;
  }
  if (tool.toolName === "read") {
    return <ReadDetails tool={tool} />;
  }
  if (tool.toolName === "trace_retrieve") {
    return <TraceDetails tool={tool} />;
  }
  if (tool.toolName === "list_project_resources") {
    return <ResourceDetails tool={tool} />;
  }
  return <GenericDetails tool={tool} />;
}

function TerminalDetails({ tool }: { tool: ToolTimelineItem }) {
  const command = tool.shell?.command ?? getInputValue(tool, "command") ?? tool.argsPreview;
  const cwd = tool.shell?.cwd ?? getInputValue(tool, "cwd");
  const commandText = typeof command === "string" ? command : undefined;
  const cwdText = typeof cwd === "string" ? cwd : undefined;
  const shellParts = [tool.shell?.platform, tool.shell?.shellKind, tool.shell?.shellExecutable].filter(Boolean).join(" / ");

  return (
    <div className="space-y-2">
      {commandText && <LabeledCode label="Command" value={commandText} />}
      {cwdText && <MetaLine label="cwd" value={cwdText} />}
      {shellParts && <MetaLine label="shell" value={shellParts} />}
      {(tool.shell?.operation || tool.shell?.processId || tool.shell?.processStatus) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-brand-text-light">
          {tool.shell.operation && <span>operation {tool.shell.operation}</span>}
          {tool.shell.terminalId && <span>terminal {tool.shell.terminalName ?? tool.shell.terminalId}</span>}
          {tool.shell.processId && <span>process {tool.shell.processId}</span>}
          {(tool.shell.terminalStatus || tool.shell.processStatus) && <span>status {tool.shell.terminalStatus ?? tool.shell.processStatus}</span>}
          {tool.shell.awaitingInput && <span>awaiting user input</span>}
          {tool.shell.nextOutputSequence !== undefined && <span>next output {tool.shell.nextOutputSequence}</span>}
        </div>
      )}
      {tool.shell && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-brand-text-light">
          <span>exit {tool.shell.exitCode ?? "none"}</span>
          {tool.shell.signal && <span>signal {tool.shell.signal}</span>}
          {tool.shell.durationMs !== undefined && <span>{formatDuration(tool.shell.durationMs)}</span>}
        </div>
      )}
      {tool.stdout || tool.output ? <LabeledCode label="stdout" value={tool.stdout ?? tool.output} tone="dark" /> : null}
      {tool.stderr ? <LabeledCode label="stderr" value={tool.stderr} tone="error" /> : null}
      {tool.error && <p className="text-xs text-red-600">{tool.error}</p>}
    </div>
  );
}

function EditDetails({ tool }: { tool: ToolTimelineItem }) {
  const files = getEditFileSummaries(tool);
  const diffFiles = getPreferredEditDiffFiles(tool);

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <div className="space-y-1 text-xs text-brand-text-light">
          {files.map((file) => (
            <div key={file.path} className="flex items-center gap-2">
              <span className="font-medium text-brand-text-dark">{capitalize(file.operation)}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              {file.added !== undefined || file.removed !== undefined ? (
                <span className="shrink-0 font-mono">
                  <span className="text-emerald-600">+{file.added ?? 0}</span>{" "}
                  <span className="text-red-500">-{file.removed ?? 0}</span>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {Array.isArray(tool.fileOperations) && tool.fileOperations.some((file) => file.verification || file.contentHashAfter) ? (
        <div className="space-y-1 rounded-md bg-emerald-50 p-2 text-xs text-emerald-800">
          {tool.fileOperations.map((file) => (
            <div key={file.path} className="flex flex-wrap gap-x-2 gap-y-1">
              <span className="font-medium">{file.verification ?? "recorded"}</span>
              <span className="font-mono">{file.path}</span>
              {file.contentHashAfter ? <span className="font-mono">hash {file.contentHashAfter.slice(0, 12)}</span> : null}
              {file.lineDelta !== undefined ? <span className="font-mono">lines {file.lineDelta >= 0 ? "+" : ""}{file.lineDelta}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {diffFiles.length > 0 ? (
        <DiffView files={diffFiles} />
      ) : tool.resultPreview ? (
        <LabeledCode label="preview" value={tool.resultPreview} tone="dark" />
      ) : null}
    </div>
  );
}

function SearchDetails({ tool }: { tool: ToolTimelineItem }) {
  const query = getInputValue(tool, "query");
  const path = getInputValue(tool, "path");
  const queryText = typeof query === "string" ? query : undefined;
  const pathText = typeof path === "string" ? path : undefined;
  const result = asRecord(tool.result);
  const matches = Array.isArray(result?.matches) ? result.matches : [];

  return (
    <div className="space-y-2">
      {queryText && <MetaLine label="query" value={queryText} />}
      {pathText && <MetaLine label="path" value={pathText} />}
      {matches.length > 0 ? (
        <pre className="max-h-56 overflow-auto rounded-md bg-white p-2 font-mono text-xs leading-5 text-brand-text-dark">
          {matches
            .slice(0, 20)
            .map((match) => formatSearchMatch(match))
            .join("\n")}
        </pre>
      ) : tool.resultPreview ? (
        <LabeledCode label="preview" value={tool.resultPreview} />
      ) : null}
    </div>
  );
}

function ReadDetails({ tool }: { tool: ToolTimelineItem }) {
  const result = asRecord(tool.result);
  const path = getInputValue(tool, "path") ?? result?.path;
  const kind = result?.kind;
  const pathText = typeof path === "string" ? path : undefined;
  const kindText = typeof kind === "string" ? kind : undefined;
  const content = typeof result?.content === "string" ? result.content : tool.resultPreview;

  return (
    <div className="space-y-2">
      {pathText && <MetaLine label="path" value={pathText} />}
      {kindText && <MetaLine label="kind" value={kindText} />}
      {typeof result?.contentHash === "string" && <MetaLine label="hash" value={result.contentHash.slice(0, 16)} />}
      {typeof result?.lineEnding === "string" && <MetaLine label="line endings" value={result.lineEnding} />}
      {content ? <LabeledCode label="content" value={content} /> : null}
      {Array.isArray(result?.entries) && result.entries.length > 0 && (
        <pre className="max-h-56 overflow-auto rounded-md bg-white p-2 font-mono text-xs leading-5 text-brand-text-dark">
          {result.entries
            .slice(0, 50)
            .map((entry) => `${entry.kind === "directory" ? "dir " : "file"} ${entry.path}`)
            .join("\n")}
        </pre>
      )}
    </div>
  );
}

function TraceDetails({ tool }: { tool: ToolTimelineItem }) {
  const result = asRecord(tool.result);
  const results = Array.isArray(result?.results) ? result.results : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((warning): warning is string => typeof warning === "string") : [];

  return (
    <div className="space-y-2">
      {tool.argsPreview && <LabeledCode label="filters" value={tool.argsPreview} />}
      {warnings.length > 0 && <p className="text-xs text-amber-700">{warnings.join(" ")}</p>}
      {results.length > 0 ? (
        <pre className="max-h-56 overflow-auto rounded-md bg-white p-2 font-mono text-xs leading-5 text-brand-text-dark">
          {results
            .slice(0, 20)
            .map(formatTraceResult)
            .join("\n")}
        </pre>
      ) : tool.resultPreview ? (
        <LabeledCode label="preview" value={tool.resultPreview} />
      ) : null}
    </div>
  );
}

function formatTraceResult(result: unknown): string {
  const record = asRecord(result);
  const handle = typeof record?.handle === "string" ? record.handle : "trace";
  const kind = typeof record?.kind === "string" ? record.kind : "result";
  const title = typeof record?.title === "string" ? record.title : "";
  const messageId = typeof record?.messageId === "string" ? record.messageId : undefined;
  const toolCallId = typeof record?.toolCallId === "string" ? record.toolCallId : undefined;
  const turnId = typeof record?.turnId === "string" ? record.turnId : undefined;
  const conversation = asRecord(record?.conversation);
  const conversationTitle = typeof conversation?.title === "string" ? conversation.title : undefined;
  const isCurrentConversation = typeof conversation?.isCurrentConversation === "boolean" ? conversation.isCurrentConversation : undefined;
  const turnNo = typeof record?.turnNo === "number" ? record.turnNo : undefined;
  const messageRole = typeof record?.messageRole === "string" ? record.messageRole : undefined;
  const inspectArgs = record?.inspectArgs ? JSON.stringify(record.inspectArgs) : undefined;
  const ids = [messageId ? `message ${messageId}` : undefined, toolCallId ? `tool ${toolCallId}` : undefined, turnId ? `turn ${turnId}` : undefined]
    .filter(Boolean)
    .join(" ");
  const provenance = [
    conversationTitle ? `conversation "${conversationTitle}"` : undefined,
    isCurrentConversation === undefined ? undefined : isCurrentConversation ? "current chat" : "earlier chat",
    turnNo ? `turn ${turnNo}` : undefined,
    messageRole ? `role ${messageRole}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const body =
    typeof record?.content === "string"
      ? record.content
      : typeof record?.snippet === "string"
        ? record.snippet
        : typeof record?.summary === "string"
          ? record.summary
          : "";
  return `${handle} ${kind} ${title}${provenance ? `\n  ${provenance}` : ""}${ids ? `\n  ${ids}` : ""}${inspectArgs ? `\n  inspect ${inspectArgs}` : ""}${
    body ? `\n  ${body.replace(/\s+/g, " ").slice(0, 280)}` : ""
  }`.trim();
}

function ResourceDetails({ tool }: { tool: ToolTimelineItem }) {
  const result = asRecord(tool.result);
  const resources = Array.isArray(result?.resources) ? result.resources : [];

  return (
    <div className="space-y-2">
      {tool.argsPreview && <LabeledCode label="filters" value={tool.argsPreview} />}
      {resources.length > 0 ? (
        <pre className="max-h-56 overflow-auto rounded-md bg-white p-2 font-mono text-xs leading-5 text-brand-text-dark">
          {resources.slice(0, 50).map(formatResource).join("\n")}
        </pre>
      ) : tool.resultPreview ? (
        <LabeledCode label="preview" value={tool.resultPreview} />
      ) : null}
    </div>
  );
}

function GenericDetails({ tool }: { tool: ToolTimelineItem }) {
  return (
    <div className="space-y-2">
      {tool.argsPreview && <LabeledCode label="input" value={tool.argsPreview} />}
      {tool.resultPreview && <LabeledCode label="result" value={tool.resultPreview} />}
      {tool.error && <p className="text-xs text-red-600">{tool.error}</p>}
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2 text-xs">
      <span className="shrink-0 font-medium text-brand-text-dark">{label}</span>
      <span className="truncate font-mono text-brand-text-light">{value}</span>
    </div>
  );
}

function LabeledCode({ label, value, tone = "light" }: { label: string; value: string; tone?: "light" | "dark" | "error" }) {
  const toneClass =
    tone === "dark"
      ? "bg-gray-950 text-gray-100"
      : tone === "error"
        ? "bg-red-50 text-red-700"
        : "bg-white text-brand-text-dark";

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-brand-text-light">{label}</div>
      <pre className={`max-h-64 overflow-auto rounded-md p-2 font-mono text-xs leading-5 ${toneClass}`}>{value}</pre>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function getInputValue(tool: ToolTimelineItem, key: string): unknown {
  const input = asRecord(tool.arguments);
  return input?.[key];
}

function formatSearchMatch(match: unknown): string {
  const record = asRecord(match);
  const path = typeof record?.path === "string" ? record.path : "unknown";
  const line = typeof record?.line === "number" || typeof record?.line === "string" ? `:${record.line}` : "";
  const text = typeof record?.text === "string" ? ` ${record.text}` : "";
  return `${path}${line}${text}`;
}

function formatResource(resource: unknown): string {
  const record = asRecord(resource);
  const name = typeof record?.name === "string" ? record.name : "resource";
  const kind = typeof record?.kind === "string" ? ` ${record.kind}` : "";
  const source = typeof record?.source === "string" ? ` ${record.source}` : "";
  const status = typeof record?.status === "string" ? ` ${record.status}` : "";
  const uri = typeof record?.uri === "string" ? ` ${record.uri}` : "";
  return `${name}${kind}${source}${status}${uri}`.trim();
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
