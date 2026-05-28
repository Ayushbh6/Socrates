import { z } from "zod"

export const apiErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
    requestId: z.string().min(1).optional(),
    recoverable: z.boolean().optional(),
  })
  .strict()

export type ApiError = z.infer<typeof apiErrorSchema>

export type ApiResponse<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: ApiError
    }

export const apiSuccessSchema = <TData extends z.ZodTypeAny>(dataSchema: TData) =>
  z
    .object({
      ok: z.literal(true),
      data: dataSchema,
    })
    .strict()

export const apiFailureSchema = z
  .object({
    ok: z.literal(false),
    error: apiErrorSchema,
  })
  .strict()

export const apiResponseSchema = <TData extends z.ZodTypeAny>(dataSchema: TData) =>
  z.discriminatedUnion("ok", [apiSuccessSchema(dataSchema), apiFailureSchema])
