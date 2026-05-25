import type { ToolTimelineItem } from "./ToolTimelineTypes";

export function ToolDetails({ tool }: { tool: ToolTimelineItem }) {
  if (tool.toolName === "bash") {
    return <BashDetails tool={tool} />;
  }
  if (tool.toolName === "edit") {
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

function BashDetails({ tool }: { tool: ToolTimelineItem }) {
  const command = tool.shell?.command ?? getInputValue(tool, "command") ?? tool.argsPreview;
  const cwd = tool.shell?.cwd ?? getInputValue(tool, "cwd");
  const commandText = typeof command === "string" ? command : undefined;
  const cwdText = typeof cwd === "string" ? cwd : undefined;

  return (
    <div className="space-y-2">
      {commandText && <LabeledCode label="Command" value={commandText} />}
      {cwdText && <MetaLine label="cwd" value={cwdText} />}
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
  return (
    <div className="space-y-2">
      {tool.fileOperations && tool.fileOperations.length > 0 && (
        <div className="space-y-1 text-xs text-brand-text-light">
          {tool.fileOperations.map((file) => (
            <div key={`${file.operation}-${file.path}`} className="flex items-center gap-2">
              <span className="font-medium text-brand-text-dark">{file.operation}</span>
              <span className="truncate font-mono">{file.path}</span>
            </div>
          ))}
        </div>
      )}
      {tool.patch?.diff ? <LabeledCode label="diff" value={tool.patch.diff} tone="dark" /> : null}
      {!tool.patch?.diff && tool.resultPreview ? <LabeledCode label="preview" value={tool.resultPreview} tone="dark" /> : null}
      {tool.argsPreview && <LabeledCode label="input" value={tool.argsPreview} />}
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
  const content = typeof result?.content === "string" ? result.content : tool.resultPreview;

  return (
    <div className="space-y-2">
      {path && <MetaLine label="path" value={String(path)} />}
      {kind && <MetaLine label="kind" value={String(kind)} />}
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
  const body =
    typeof record?.content === "string"
      ? record.content
      : typeof record?.snippet === "string"
        ? record.snippet
        : typeof record?.summary === "string"
          ? record.summary
          : "";
  return `${handle} ${kind} ${title}${body ? `\n  ${body.replace(/\s+/g, " ").slice(0, 280)}` : ""}`.trim();
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

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, any>) : undefined;
}

function getInputValue(tool: ToolTimelineItem, key: string): unknown {
  const input = asRecord(tool.arguments);
  return input?.[key];
}

function formatSearchMatch(match: any): string {
  const path = match?.path ?? "unknown";
  const line = match?.line ? `:${match.line}` : "";
  const text = match?.text ? ` ${match.text}` : "";
  return `${path}${line}${text}`;
}

function formatResource(resource: any): string {
  const name = resource?.name ?? "resource";
  const kind = resource?.kind ? ` ${resource.kind}` : "";
  const source = resource?.source ? ` ${resource.source}` : "";
  const status = resource?.status ? ` ${resource.status}` : "";
  const uri = resource?.uri ? ` ${resource.uri}` : "";
  return `${name}${kind}${source}${status}${uri}`.trim();
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
