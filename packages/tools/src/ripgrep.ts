import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { ToolError } from "./errors";

/**
 * Resolve the ripgrep binary: the newer of a system `rg` on PATH and the
 * pinned binary bundled through @vscode/ripgrep, so a machine with a current
 * ripgrep gets its fixes while every machine still has one that works.
 */
let resolved: Promise<string> | undefined;

export function ripgrepPath(): Promise<string> {
  resolved ??= resolve().catch((error: unknown) => {
    resolved = undefined;
    throw error;
  });
  return resolved;
}

async function resolve(): Promise<string> {
  const candidates: string[] = [];
  const system = which(process.platform === "win32" ? "rg.exe" : "rg");
  if (system) candidates.push(system);
  try {
    candidates.push((await import("@vscode/ripgrep")).rgPath);
  } catch {
    // No bundled binary for this platform.
  }
  let best: { path: string; version: number[] } | null = null;
  for (const candidate of candidates) {
    const version = await rgVersion(candidate);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { path: candidate, version };
  }
  if (!best) {
    throw new ToolError("search_unavailable", "ripgrep is not available on this machine.", "Install ripgrep, or use terminal commands such as find and grep for now.", false);
  }
  return best.path;
}

function which(binary: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

function rgVersion(binary: string): Promise<number[] | null> {
  return new Promise((done) => {
    execFile(binary, ["--version"], { timeout: 5000 }, (error, stdout) => {
      const m = /ripgrep (\d+)\.(\d+)\.(\d+)/.exec(String(stdout));
      done(error || !m ? null : [Number(m[1]), Number(m[2]), Number(m[3])]);
    });
  });
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Run ripgrep and stream stdout line by line. `onLine` returns false to stop
 * early (the process is then killed). Resolves with the exit code and a
 * bounded stderr.
 */
export async function runRipgrep(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => boolean,
): Promise<{ code: number | null; stderr: string; stopped: boolean }> {
  const cancelled = () => new ToolError("cancelled", "The search was cancelled.", "No action needed.", false);
  if (signal.aborted) throw cancelled();
  const binary = await ripgrepPath();
  if (signal.aborted) throw cancelled();
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill();
    };
    const onAbort = () => stop();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!onLine(line)) {
          stop();
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      fail(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (!stopped && buffer) onLine(buffer);
      if (signal.aborted) fail(new ToolError("cancelled", "The search was cancelled.", "No action needed.", false));
      else done({ code, stderr, stopped });
    });
  });
}
