import { bashToolInputSchema, bashToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool, ToolPolicyDecision } from "./types"

const readOnlyCommandPattern =
  /^\s*(pwd|ls|find|rg|grep|cat|sed|head|tail|wc|where|Get-Location|Get-ChildItem|Get-Content|Select-String|Get-Command|python\s+--version|py\s+--version|git\s+(status|diff|log|show|branch)|pnpm\s+(test|typecheck|build)|npm\s+(test|run\s+(test|typecheck|build)))\b/i

const highRiskCommandPattern =
  /\b(sudo|rm\s+-rf|Remove-Item|del\s+\/[sq]|rmdir\s+\/[sq]|mkfs|dd\s+if=|chmod\s+-R|chown\s+-R|git\s+(commit|push|reset|clean|checkout|switch|merge|rebase)|docker|curl|Invoke-WebRequest|wget|pnpm\s+(add|install|i|dev|start)|npm\s+(install|i|start|run\s+dev)|yarn\s+(add|dev|start)|migrate|prisma\s+migrate)\b/i

const decideBashPolicy: SocratesTool<typeof bashToolInputSchema._type, typeof bashToolOutputSchema._type>["decidePolicy"] = (
  input,
  context,
): ToolPolicyDecision => {
  const operation = input.operation ?? "run"
  if (operation === "status" || operation === "output" || operation === "stop") {
    return { type: "auto" }
  }

  const command = input.command?.trim() ?? ""

  if (context.runtimeConfig.sandboxMode === "read_only" || context.runtimeConfig.approvalMode === "read_only_auto") {
    if (readOnlyCommandPattern.test(command) && !highRiskCommandPattern.test(command)) {
      return { type: "auto" }
    }
    return { type: "denied", reason: "This shell command is not allowed in read-only mode." }
  }

  if (context.runtimeConfig.sandboxMode === "danger_full_access" || context.runtimeConfig.approvalMode === "approve_all") {
    return { type: "auto" }
  }

  if (readOnlyCommandPattern.test(command) && !highRiskCommandPattern.test(command)) {
    return { type: "auto" }
  }

  return {
    type: "approval_required",
    request: {
      actionKind: command.startsWith("git commit")
        ? "git_commit"
        : command.startsWith("git push")
          ? "git_push"
          : "shell_command",
      title: "Approve shell command",
      description:
        operation === "start"
          ? "Socrates wants to start a background Terminal in the active project workspace."
          : "Socrates wants to run a command in the active project workspace.",
      actionPreview: command,
      risk: highRiskCommandPattern.test(command) ? "high" : "medium",
    },
  }
}

export const bashTool: SocratesTool<typeof bashToolInputSchema._type, typeof bashToolOutputSchema._type> = {
  name: "bash",
  description:
    "Terminal command execution tool. The compatibility tool id is bash, but product copy should call it Terminal. Behavior is platform-native: POSIX on macOS/Linux and PowerShell/cmd on Windows. Runs from the active project workspace with bounded output and a sanitized user-workspace environment that does not inherit Socrates runtime variables, provider secrets, NODE_ENV, package-manager production/omit flags, or CI. Supports run plus conversation-scoped start/status/output/stop operations. Prefer read/search/edit for structured file work, but use Terminal when a real command is needed.",
  inputSchema: bashToolInputSchema,
  resultSchema: bashToolOutputSchema,
  permission: "execute",
  executeLane: "mutation",
  category: "shell",
  decidePolicy: decideBashPolicy,
  execute: (input, context) => context.executors.bash(input, context),
  summary: (output) => {
    const operation = output.operation ?? "run"
    if (operation === "start" && output.process) {
      return `Started Terminal ${output.terminal?.name ?? output.process.processId}.`
    }
    if ((operation === "status" || operation === "output" || operation === "stop") && output.process) {
      return `Process ${output.process.processId} is ${output.process.status}.`
    }
    return `Command exited ${output.exitCode === null ? "without an exit code" : `with code ${output.exitCode}`}.`
  },
  resultPreview: (output) => [output.stdout, output.stderr].filter(Boolean).join("\n"),
  metrics: () => ({ commandsRun: 1 }),
}
