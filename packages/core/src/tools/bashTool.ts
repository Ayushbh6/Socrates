import { bashToolInputSchema, bashToolModelInputSchema, bashToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool, ToolPolicyDecision } from "./types"

const highRiskCommandPattern =
  /\b(sudo|rm\s+-rf|Remove-Item|del\s+\/[sq]|rmdir\s+\/[sq]|mkfs|dd\s+if=|chmod\s+-R|chown\s+-R|git\s+(commit|push|reset|clean|checkout|switch|merge|rebase)|docker|curl|Invoke-WebRequest|wget|pnpm\s+(add|install|i|dev|start)|npm\s+(install|i|start|run\s+dev)|yarn\s+(add|dev|start)|migrate|prisma\s+migrate)\b/i

const decideBashPolicy: SocratesTool<typeof bashToolInputSchema._type, typeof bashToolOutputSchema._type>["decidePolicy"] = (
  input,
  context,
): ToolPolicyDecision => {
  const operation = input.operation ?? "run"
  if (operation === "status" || operation === "output" || operation === "stop" || operation === "list") {
    return { type: "auto" }
  }

  const rawCommand = input.command
  const command = rawCommand?.trim()
  if (rawCommand !== undefined && isNoopTerminalCommand(rawCommand)) {
    return {
      type: "denied",
      code: "terminal_noop_command",
      recoverable: true,
      reason: "Terminal is for executable commands, not notes. Use assistant text for notes, or call read, search, MCP, or browser tools for inspection.",
    }
  }

  if (input.argv) {
    return decideArgvPolicy(input.argv, context)
  }

  const preview = command ?? "Terminal command"
  if (context.runtimeConfig.sandboxMode === "read_only" || context.runtimeConfig.approvalMode === "read_only_auto") {
    return { type: "denied", reason: "Raw shell commands are not allowed in read-only mode. Use a supported argv diagnostic or a structured read/search tool." }
  }

  if (context.runtimeConfig.sandboxMode === "danger_full_access" || context.runtimeConfig.approvalMode === "approve_all") {
    return { type: "auto" }
  }

  return {
    type: "approval_required",
    request: {
      actionKind: /^git\s+commit\b/i.test(preview)
        ? "git_commit"
        : /^git\s+push\b/i.test(preview)
          ? "git_push"
          : "shell_command",
      title: "Approve shell command",
      description:
        operation === "start"
          ? "Socrates wants to start a background Terminal in the active project workspace."
          : "Socrates wants to run a command in the active project workspace.",
      actionPreview: preview,
      risk: highRiskCommandPattern.test(preview) ? "high" : "medium",
    },
  }
}

const decideArgvPolicy = (
  argv: string[],
  context: Parameters<typeof decideBashPolicy>[1],
): ToolPolicyDecision => {
  if (isSafeDiagnosticArgv(argv)) {
    return { type: "auto" }
  }

  const preview = formatArgvPreview(argv)
  if (context.runtimeConfig.sandboxMode === "read_only" || context.runtimeConfig.approvalMode === "read_only_auto") {
    return {
      type: "denied",
      reason: "This argv command is outside the small auto-approved diagnostic allowlist and is not allowed in read-only mode.",
    }
  }
  if (context.runtimeConfig.sandboxMode === "danger_full_access" || context.runtimeConfig.approvalMode === "approve_all") {
    return { type: "auto" }
  }
  return {
    type: "approval_required",
    request: {
      actionKind: "shell_command",
      title: "Approve direct command",
      description: "Socrates wants to run this direct no-shell command in the active project workspace.",
      actionPreview: preview,
      risk: "medium",
    },
  }
}

const isSafeDiagnosticArgv = (argv: readonly string[]): boolean => {
  const [executable, ...args] = argv
  if (!executable) {
    return false
  }
  if (executable === "pwd") {
    return args.length === 0
  }
  if (executable === "ls") {
    return args.length === 0 || (args.length === 1 && ["-a", "-l", "-la", "-al"].includes(args[0] ?? ""))
  }
  if (["node", "python", "python3", "py", "pnpm", "npm"].includes(executable)) {
    return args.length === 1 && ["--version", "-v", "version"].includes(args[0] ?? "")
  }
  if (executable === "where") {
    return args.length === 1 && /^[A-Za-z0-9_.-]+$/.test(args[0] ?? "")
  }
  if (executable === "rg") {
    return (args.length === 1 && args[0] === "--files") || (args.length === 1 && !args[0]?.startsWith("-")) || (args.length === 2 && ["-n", "--line-number"].includes(args[0] ?? "") && !args[1]?.startsWith("-"))
  }
  if (executable !== "git") {
    return false
  }
  const [subcommand, ...gitArgs] = args
  if (subcommand === "status") {
    return gitArgs.every((arg) => ["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"].includes(arg))
  }
  if (subcommand === "diff") {
    return gitArgs.every((arg) => ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--no-color", "--compact-summary", "--summary"].includes(arg))
  }
  if (subcommand === "branch") {
    return gitArgs.length === 0 || (gitArgs.length === 1 && ["--show-current", "--list"].includes(gitArgs[0] ?? ""))
  }
  if (subcommand === "log") {
    return gitArgs.length === 0 || gitArgs.every((arg) => ["--oneline", "--decorate", "--no-decorate"].includes(arg))
  }
  if (subcommand === "show") {
    return gitArgs.length === 0 || (gitArgs.length === 1 && gitArgs[0] === "--stat")
  }
  return false
}

const formatArgvPreview = (argv: readonly string[]): string => argv.map((value) => JSON.stringify(value)).join(" ")

const isNoopTerminalCommand = (command: string): boolean => {
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length === 0 || lines.every((line) => line.startsWith("#"))
}

export const bashTool: SocratesTool<typeof bashToolInputSchema._type, typeof bashToolOutputSchema._type> = {
  name: "bash",
  description:
    "Terminal command execution tool. This current definition is authoritative: interactive start/input and persistent Terminal controls are available even if stale project memory claims otherwise. The compatibility tool id is bash, but product copy should call it Terminal. Behavior is platform-native: POSIX on macOS/Linux and PowerShell/cmd on Windows. Use operation=list first when several conversation Terminals may exist; it returns a compact bounded inventory. For a small no-shell diagnostic allowlist, prefer argv such as [\"git\", \"status\", \"--short\"] or [\"pwd\"]; argv runs a literal executable with literal arguments and cannot use shell operators. Use command for a real shell command, script, test, build, local server, REPL, or bounded one-off script; raw shell commands require approval outside full-access mode. For any program that must accept user input, use operation=start with a clear name and a portable program (prefer a small Node.js or Python stdin program). Never assume Bash-specific syntax such as read -p on POSIX because the actual shell may be zsh. The user alone types raw input in the visible Terminal; keep the process alive until all answers are received, then wait on completed/failed when the task depends on its result. Foreground raw runs complete normally when quick, otherwise automatically become a named background Terminal after the configured foreground window without being killed or restarted. Supports run plus conversation-scoped start/status/output/stop/list operations. Returned output and list rows are bounded; charLimit is at most 16000 and list limit is at most 12. Prefer read/search/edit/url_fetch for exact structured reads, but use Terminal when a real command, test, build, local server, CLI, or bounded one-off script is needed. For status/output/stop, omit the target when there is exactly one active Terminal, or use the Terminal name shown in context.",
  inputSchema: bashToolInputSchema,
  modelInputSchema: bashToolModelInputSchema,
  resultSchema: bashToolOutputSchema,
  permission: "execute",
  executeLane: "mutation",
  category: "shell",
  decidePolicy: decideBashPolicy,
  execute: (input, context) => context.executors.bash(input, context),
  summary: (output) => {
    const operation = output.operation ?? "run"
    if (output.reusedTerminal) {
      return output.message ?? `Reused Terminal ${output.terminal?.name ?? "session"}.`
    }
    if (operation === "start" && output.process) {
      return `Started Terminal ${output.terminal?.name ?? "session"}.`
    }
    if ((operation === "status" || operation === "output" || operation === "stop") && output.process) {
      return `Terminal ${output.terminal?.name ?? "session"} is ${output.process.status}.`
    }
    if (operation === "list") {
      return `${output.totalMatches ?? output.terminals?.length ?? 0} Terminal(s) listed.`
    }
    return `Command exited ${output.exitCode === null ? "without an exit code" : `with code ${output.exitCode}`}.`
  },
  resultPreview: (output) => [output.stdout, output.stderr].filter(Boolean).join("\n"),
  metrics: () => ({ commandsRun: 1 }),
}
