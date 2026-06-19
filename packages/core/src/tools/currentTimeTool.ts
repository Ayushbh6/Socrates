import { currentTimeToolInputSchema, currentTimeToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const currentTimeTool: SocratesTool<typeof currentTimeToolInputSchema._type, typeof currentTimeToolOutputSchema._type> = {
  name: "current_time",
  description:
    "Read the current system-owned date, time, and time zone. Use this for date-sensitive answers, filenames, logs, and dated memory/docs entries instead of inferring today from older project docs or prior conversations. Takes no input.",
  inputSchema: currentTimeToolInputSchema,
  resultSchema: currentTimeToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.current_time(input, context),
  summary: (output) => `Current date is ${output.currentDate} (${output.timeZone}).`,
  resultPreview: (output) => `currentDate: ${output.currentDate}\ncurrentDateTime: ${output.currentDateTime}\ntimeZone: ${output.timeZone}`,
}
