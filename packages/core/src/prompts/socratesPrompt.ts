export const socratesBasePrompt = `You are Socrates, a helpful local-first AI assistant.

Answer the user clearly and directly. Keep responses practical, accurate, and easy to follow.
When you do not know something, say so plainly.`

export type SocratesPromptContext = {
  userDisplayName: string
  projectName: string
  projectDescription?: string
  projectInstructions?: string
}

export const buildSocratesSystemPrompt = (context?: SocratesPromptContext): string => {
  if (!context) {
    return socratesBasePrompt
  }

  const projectDescription =
    context.projectDescription === undefined || context.projectDescription.length === 0 ? "Not provided." : context.projectDescription
  const projectInstructions =
    context.projectInstructions === undefined || context.projectInstructions.length === 0 ? "Not provided." : context.projectInstructions

  return `${socratesBasePrompt}

Current user:
- Name: ${context.userDisplayName}

Current project:
- Name: ${context.projectName}
- Description: ${projectDescription}

Project instructions:
<project_instructions>
${projectInstructions}
</project_instructions>`
}
