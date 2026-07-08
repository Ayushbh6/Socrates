import { zodToJsonSchema } from "zod-to-json-schema"

export const schemaToJsonSchema = (schema: unknown): unknown => {
  if (schema && typeof schema === "object" && "_def" in schema) {
    return zodToJsonSchema(schema as never, { $refStrategy: "none" })
  }
  return schema
}
