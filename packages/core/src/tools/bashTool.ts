import { bashToolInputSchema, bashToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool, ToolPolicyDecision } from "./types"

const readOnlyCommandPattern =
  /^\s*(pwd|ls|find|rg|grep|cat|sed|head|tail|wc|git\s+(status|diff|log|show|branch)|pnpm\s+(test|typecheck|build)|npm\s+(test|run\s+(test|typecheck|build)))\b/

const highRiskCommandPattern =
  /\b(sudo|rm\s+-rf|mkfs|dd\s+if=|chmod\s+-R|chown\s+-R|git\s+(commit|push|reset|clean|checkout|switch|merge|rebase)|docker|curl|wget|pnpm\s+(add|install|i)|npm\s+(install|i)|yarn\s+add)\b/

const decideBashPolicy: SocratesTool<typeof bashToolInputSchema._type, typeof bashToolOutputSchema._type>["decidePolicy"] = (
  input,
  context,
): ToolPolicyDecision => {
  const command = input.command.trim()

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
      description: "Socrates wants to run a command in the active project workspace.",
      actionPreview: command,
      risk: highRiskCommandPattern.test(command) ? "high" : "medium",
    },
  }
}

export const bashTool: SocratesTool<typeof bashToolInputSchema._type, typeof bashToolOutputSchema._type> = {
  name: "bash",
  description:
    "Run a shell command from the active project workspace with bounded output and a timeout. Prefer read/search/edit for structured file work, but use bash when a real command is needed.",
  inputSchema: bashToolInputSchema,
  resultSchema: bashToolOutputSchema,
  permission: "execute",
  executeLane: "mutation",
  category: "shell",
  decidePolicy: decideBashPolicy,
  execute: (input, context) => context.executors.bash(input, context),
  summary: (output) => `Command exited ${output.exitCode === null ? "without an exit code" : `with code ${output.exitCode}`}.`,
  resultPreview: (output) => [output.stdout, output.stderr].filter(Boolean).join("\n"),
  metrics: () => ({ commandsRun: 1 }),
}
