import { z } from "zod"

export const memoryRouteSaveTargetSchema = z.enum([
  "none",
  "project_notes",
  "project_memory",
  "repo_docs",
  "global_memory",
])
export type MemoryRouteSaveTarget = z.infer<typeof memoryRouteSaveTargetSchema>

const memoryRouteTextSchema = z.string().max(1_200)
const memoryRouteReasonSchema = z.string().min(1).max(500)

export const preTurnMemoryRouteSchema = z
  .object({
    projectNotes: z.boolean(),
    projectMemory: z.boolean(),
    repoDocs: z.boolean(),
    userProfile: z.boolean(),
    saveTarget: memoryRouteSaveTargetSchema,
    saveText: memoryRouteTextSchema,
    reason: memoryRouteReasonSchema,
  })
  .strict()
  .superRefine((route, context) => {
    if (route.saveTarget === "none" && route.saveText.trim().length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["saveText"], message: "saveText must be empty when saveTarget is none." })
    }
    if (route.saveTarget !== "none" && route.saveText.trim().length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["saveText"], message: "saveText is required when saveTarget is not none." })
    }
  })
export type PreTurnMemoryRoute = z.infer<typeof preTurnMemoryRouteSchema>

export const postTurnMemoryRouteSchema = z
  .object({
    saveTarget: memoryRouteSaveTargetSchema,
    saveText: memoryRouteTextSchema,
    reason: memoryRouteReasonSchema,
  })
  .strict()
  .superRefine((route, context) => {
    if (route.saveTarget === "none" && route.saveText.trim().length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["saveText"], message: "saveText must be empty when saveTarget is none." })
    }
    if (route.saveTarget !== "none" && route.saveText.trim().length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["saveText"], message: "saveText is required when saveTarget is not none." })
    }
  })
export type PostTurnMemoryRoute = z.infer<typeof postTurnMemoryRouteSchema>
