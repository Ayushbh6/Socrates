import type { ModelToolDefinition } from "@socrates/contracts"
import type { JSONSchema7 } from "ai"
import { schemaToJsonSchema } from "./jsonSchema"

export type JsonSchemaObject = JSONSchema7

export const toolParametersJsonSchema = (definition: ModelToolDefinition): unknown => {
  if (definition.name === "edit") {
    return editToolJsonSchema
  }
  if (definition.name === "trace_retrieve") {
    return traceRetrieveJsonSchema
  }
  return ensureObjectToolSchema(schemaToJsonSchema(definition.inputSchema))
}

const ensureObjectToolSchema = (schema: unknown): JsonSchemaObject => {
  if (isJsonSchemaObject(schema) && schema.type === "object") {
    return schema
  }

  const variants = objectVariants(schema)
  if (variants.length > 0) {
    return mergeObjectVariants(variants)
  }

  return {
    type: "object",
    additionalProperties: true,
    properties: {},
  }
}

const objectVariants = (schema: unknown): JsonSchemaObject[] => {
  if (!isJsonSchemaObject(schema)) {
    return []
  }
  const variants = [schema.anyOf, schema.oneOf, schema.allOf].find(Array.isArray)
  if (!variants) {
    return []
  }
  return variants.filter((variant): variant is JsonSchemaObject => isJsonSchemaObject(variant) && variant.type === "object")
}

const mergeObjectVariants = (variants: JsonSchemaObject[]): JsonSchemaObject => {
  const properties: Record<string, unknown> = {}
  let required: string[] | undefined
  let additionalProperties = false

  for (const variant of variants) {
    const variantProperties = isRecord(variant.properties) ? variant.properties : {}
    for (const [key, value] of Object.entries(variantProperties)) {
      properties[key] = mergePropertySchema(properties[key], value)
    }

    const variantRequired = Array.isArray(variant.required) ? variant.required.filter((key): key is string => typeof key === "string") : []
    required = required === undefined ? variantRequired : required.filter((key) => variantRequired.includes(key))
    additionalProperties = additionalProperties || variant.additionalProperties !== false
  }

  return {
    type: "object",
    properties: properties as JsonSchemaObject["properties"],
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties,
  }
}

const mergePropertySchema = (left: unknown, right: unknown): unknown => {
  if (!isRecord(left)) {
    return normalizeConstEnum(right)
  }
  if (!isRecord(right)) {
    return left
  }

  const merged: Record<string, unknown> = { ...left, ...right }
  const enumValues = [...enumValuesFromProperty(left), ...enumValuesFromProperty(right)]
  if (enumValues.length > 0) {
    delete merged.const
    merged.enum = uniqueValues(enumValues)
  }
  return merged
}

const normalizeConstEnum = (schema: unknown): unknown => {
  if (!isRecord(schema) || !("const" in schema)) {
    return schema
  }
  const { const: constValue, ...rest } = schema
  return {
    ...rest,
    enum: uniqueValues([constValue, ...enumValuesFromProperty(schema)]),
  }
}

const enumValuesFromProperty = (schema: unknown): unknown[] => {
  if (!isRecord(schema)) {
    return []
  }
  const values: unknown[] = []
  if ("const" in schema) {
    values.push(schema.const)
  }
  if (Array.isArray(schema.enum)) {
    values.push(...schema.enum)
  }
  return values
}

const uniqueValues = (values: unknown[]): unknown[] => {
  const seen = new Set<string>()
  const unique: unknown[] = []
  for (const value of values) {
    const key = JSON.stringify(value)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(value)
  }
  return unique
}

const isJsonSchemaObject = (value: unknown): value is JsonSchemaObject => isRecord(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

export const validateStrictTraceRetrieveInput = (value: Record<string, unknown>) => {
  if (value.mode !== "semantic" && value.mode !== "combined") {
    return undefined
  }
  const allowedKeys = new Set(["operation", "mode", "query", "scope", "limit"])
  const disallowedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key))
  return disallowedKeys.length > 0
    ? `mode=${value.mode} only accepts query, scope, and limit. Remove: ${disallowedKeys.join(", ")}.`
    : undefined
}

export const editToolJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Project-relative file path to create or edit.",
    },
    oldString: {
      type: "string",
      minLength: 1,
      description: "Exact existing text to replace. Use with newString for targeted edits to existing files.",
    },
    newString: {
      type: "string",
      description: "Replacement text for oldString. Use an empty string to delete the matched text.",
    },
    replaceAll: {
      type: "boolean",
      description: "Replace every occurrence of oldString. Omit unless every occurrence should change.",
    },
    content: {
      type: "string",
      description: "Whole-file content. Use for new files, or with overwrite=true for deliberate full rewrites.",
    },
    overwrite: {
      type: "boolean",
      description: "Set true only when intentionally replacing the full content of an existing file.",
    },
    dryRun: {
      type: "boolean",
      description: "Preview the edit without writing it.",
    },
  },
} as const

export const traceRetrieveJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: {
      type: "string",
      enum: ["search", "inspect"],
      description: "Defaults to search. Set inspect only when narrowing a previous result number, handle, or exact id.",
    },
    mode: {
      type: "string",
      enum: ["exact", "semantic", "combined", "audit"],
      description:
        "Search only. Defaults to exact. Use exact for lexical/quoted text, semantic for fuzzy conceptual recall, combined for hybrid recall, and audit for tool/runtime history.",
    },
    query: {
      type: "string",
      description:
        "For exact mode, use quoted text, filenames, paths, names, ids, dates, or other lexical terms. For semantic/combined, use only a natural-language memory question plus optional scope/limit. For audit, describe the runtime evidence.",
    },
    scope: {
      type: "string",
      enum: ["current_conversation", "recent_conversations", "project"],
      description: "Search only. Defaults to recent visible conversations and excludes the active chat unless current_conversation is explicit.",
    },
    conversationTitle: {
      type: "string",
      description: "Exact or audit search only. If set, search only visible conversations with this title, ignoring broad scope and conversationLimit.",
    },
    conversationId: {
      type: "string",
      description: "Exact or audit search, or inspect. Use a conversation id returned by trace_retrieve to narrow same-title conversations or inspect a conversation bundle.",
    },
    conversationLimit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Exact/audit search only. Number of recent visible conversations to consider. Defaults to 10. Ignored when turnNo or conversationTitle is used. Do not use with mode=semantic or mode=combined.",
    },
    turnNo: {
      type: "integer",
      minimum: 1,
      maximum: 10_000,
      description:
        "Exact search or inspect. Integer only. Use for a single explicit ordinal request like turn 4. If turnNo is set, it wins over conversationLimit. Do not use for quoted-text source finding or with mode=semantic/combined.",
    },
    role: {
      type: "string",
      enum: ["user", "assistant", "any"],
      description: "Exact search or inspect. Limit to a role when useful. Do not use with mode=semantic/combined.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Search only. Number of results to return. Defaults to 5.",
    },
    charLimit: {
      type: "integer",
      minimum: 1,
      maximum: 80_000,
      description: "Exact/audit search or inspect. Maximum characters to return. Do not use with mode=semantic/combined.",
    },
    include: {
      type: "array",
      items: { type: "string", enum: ["messages", "summaries", "tool_calls", "shell", "files", "errors", "decisions"] },
      description: "Audit mode only. Filters runtime/tool history such as tool_calls, shell, files, errors, and decisions.",
    },
    paths: {
      type: "array",
      items: { type: "string" },
      maxItems: 20,
      description: "Audit mode only. Filter runtime/file history by file or attachment paths.",
    },
    command: {
      type: "string",
      description: "Audit mode only. Filter runtime history by shell command text.",
    },
    messageId: {
      type: "string",
      description: "Exact message id returned by trace_retrieve. If set, it wins over every other parameter and returns that full message with metadata.",
    },
    toolId: {
      type: "string",
      description: "Audit mode only. Exact tool id returned by trace_retrieve. If set with mode=audit, it wins over every other parameter and returns that full tool call with metadata.",
    },
    resultNumber: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Inspect only. Result number from the previous trace_retrieve search.",
    },
    handle: {
      type: "string",
      description: "Inspect only. Exact inspect handle returned by a previous trace_retrieve result.",
    },
    turnId: {
      type: "string",
      description: "Inspect only. Exact turn id returned by a previous trace_retrieve result.",
    },
    toolCallId: {
      type: "string",
      description: "Inspect/audit compatibility alias for toolId.",
    },
    startTurnNo: {
      type: "integer",
      minimum: 1,
      maximum: 10_000,
      description: "Inspect only. First turn number to include when expanding conversation context.",
    },
    turnLimit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Inspect only. Number of turns to include when expanding conversation context.",
    },
  },
} as const
