import type { PendingApproval, ToolTimelineItem } from "./ToolTimelineTypes";

export type DiffLineKind = "add" | "remove" | "context" | "hunk" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  content: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffFile = {
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
  lines: DiffLine[];
};

export type EditFileSummary = {
  path: string;
  operation: string;
  added?: number;
  removed?: number;
};

export function summarizeEditTool(tool: ToolTimelineItem): string {
  const files = getEditFileSummaries(tool);
  if (files.length === 1) {
    return `Edited ${basename(files[0].path)}`;
  }
  if (files.length > 1) {
    return `Edited ${files.length} files`;
  }
  return tool.summary?.replace(/^Changed /, "Edited ") ?? "Edited files";
}

export function getEditFileSummaries(tool: ToolTimelineItem): EditFileSummary[] {
  const files = new Map<string, EditFileSummary>();

  for (const file of parseDiff(tool.patch?.diff ?? tool.resultPreview ?? "")) {
    files.set(file.path, {
      path: file.path,
      operation: "edited",
      added: file.added,
      removed: file.removed,
    });
  }

  if (Array.isArray(tool.fileOperations)) {
    for (const file of tool.fileOperations) {
      const existing = files.get(file.path);
      files.set(file.path, {
        path: file.path,
        operation: normalizeOperation(file.operation),
        added: existing?.added,
        removed: existing?.removed,
      });
    }
  }

  const changedFiles = getChangedFiles(tool.result);
  for (const file of changedFiles) {
    const existing = files.get(file.path);
    files.set(file.path, {
      path: file.path,
      operation: normalizeOperation(file.operation),
      added: existing?.added,
      removed: existing?.removed,
    });
  }

  const operations = getInputOperations(tool.arguments);
  for (const operation of operations) {
    if (!operation.path || files.has(operation.path)) {
      continue;
    }
    files.set(operation.path, {
      path: operation.path,
      operation: normalizeOperation(operation.type),
    });
  }

  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function parseDiff(diff: string): DiffFile[] {
  if (!diff.trim()) {
    return [];
  }

  const files = new Map<string, DiffFile>();
  let current: DiffFile | undefined;
  let pendingOldPath: string | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;

  const ensureFile = (path: string, oldPath?: string): DiffFile => {
    const normalizedPath = normalizeDiffPath(path) ?? "workspace";
    const normalizedOldPath = oldPath ? normalizeDiffPath(oldPath) : undefined;
    const existing = files.get(normalizedPath);
    if (existing) {
      if (normalizedOldPath && !existing.oldPath) {
        existing.oldPath = normalizedOldPath;
      }
      return existing;
    }
    const created = { path: normalizedPath, oldPath: normalizedOldPath, added: 0, removed: 0, lines: [] };
    files.set(normalizedPath, created);
    return created;
  };

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      const match = rawLine.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (match) {
        pendingOldPath = match[1];
        current = ensureFile(match[2], match[1]);
      }
      continue;
    }

    if (rawLine.startsWith("--- ")) {
      pendingOldPath = rawLine.slice(4);
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      current = ensureFile(rawLine.slice(4), pendingOldPath);
      oldLine = undefined;
      newLine = undefined;
      continue;
    }

    if (!current && rawLine.trim()) {
      current = ensureFile("workspace");
    }

    if (!current) {
      continue;
    }

    if (rawLine.startsWith("@@")) {
      const match = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      oldLine = match ? Number(match[1]) : undefined;
      newLine = match ? Number(match[2]) : undefined;
      current.lines.push({ kind: "hunk", content: rawLine });
      continue;
    }

    if (rawLine.startsWith("+")) {
      current.added += 1;
      current.lines.push({ kind: "add", content: rawLine.slice(1), newLine });
      newLine = newLine === undefined ? undefined : newLine + 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      current.removed += 1;
      current.lines.push({ kind: "remove", content: rawLine.slice(1), oldLine });
      oldLine = oldLine === undefined ? undefined : oldLine + 1;
      continue;
    }

    if (rawLine.startsWith(" ")) {
      current.lines.push({ kind: "context", content: rawLine.slice(1), oldLine, newLine });
      oldLine = oldLine === undefined ? undefined : oldLine + 1;
      newLine = newLine === undefined ? undefined : newLine + 1;
      continue;
    }

    current.lines.push({ kind: "meta", content: rawLine });
  }

  return [...files.values()].filter((file) => file.lines.length > 0 || file.added > 0 || file.removed > 0);
}

export function formatApprovalPreview(approval: PendingApproval): string[] {
  if (approval.actionKind !== "file_write" && approval.actionKind !== "patch_apply") {
    return [];
  }

  const files = new Map<string, string>();
  for (const line of approval.actionPreview.split(/\r?\n/)) {
    const match = line.match(/^\s*(create|overwrite|replace|patch|edit|patched|edited|delete):\s+(.+?)\s*$/i);
    if (match) {
      files.set(match[2], normalizeOperation(match[1]));
    }
  }

  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, operation]) => `${capitalize(operation)} ${path}`);
}

function getChangedFiles(result: unknown): Array<{ path: string; operation: string }> {
  if (typeof result !== "object" || result === null || !("changedFiles" in result)) {
    return [];
  }
  const changedFiles = (result as { changedFiles?: unknown }).changedFiles;
  if (!Array.isArray(changedFiles)) {
    return [];
  }
  return changedFiles
    .map((file) => {
      if (typeof file !== "object" || file === null) {
        return undefined;
      }
      const record = file as { path?: unknown; operation?: unknown };
      return typeof record.path === "string"
        ? { path: record.path, operation: typeof record.operation === "string" ? record.operation : "edited" }
        : undefined;
    })
    .filter((file): file is { path: string; operation: string } => Boolean(file));
}

function getInputOperations(argumentsValue: unknown): Array<{ path: string | undefined; type: string }> {
  if (typeof argumentsValue !== "object" || argumentsValue === null || !("operations" in argumentsValue)) {
    return [];
  }
  const operations = (argumentsValue as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) {
    return [];
  }
  return operations
    .map((operation) => {
      if (typeof operation !== "object" || operation === null) {
        return undefined;
      }
      const record = operation as { path?: unknown; type?: unknown };
      return {
        path: typeof record.path === "string" ? record.path : undefined,
        type: typeof record.type === "string" ? record.type : "edited",
      };
    })
    .filter((operation): operation is { path: string | undefined; type: string } => operation !== undefined);
}

function normalizeDiffPath(path: string): string | undefined {
  const cleaned = path.trim().replace(/^"|"$/g, "");
  if (!cleaned || cleaned === "/dev/null") {
    return undefined;
  }
  return cleaned.replace(/^[ab]\//, "");
}

function normalizeOperation(operation: string): string {
  switch (operation) {
    case "create":
    case "created":
      return "created";
    case "overwrite":
    case "overwritten":
      return "overwritten";
    case "patch":
    case "patched":
      return "patched";
    case "replace":
    case "edit":
    case "edited":
    default:
      return "edited";
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
