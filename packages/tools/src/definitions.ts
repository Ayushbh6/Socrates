import type { JsonSchema, ToolDefinition } from "@socrates/contracts";
import { z } from "zod";
import type { ToolHandler } from "./handler";

type Schema = Record<string, unknown> & { properties?: Record<string, Schema>; required?: string[] };

/**
 * The model-facing JSON Schema of a tool. Providers require a plain object at
 * the top level, so a union of actions becomes one object whose `action`
 * enum selects the variant, and its description lists each action's fields.
 * Strictness (unknown fields, per-action requirements, string lengths) is
 * enforced by the Zod schema in the runner, so it is not sent to providers:
 * every request carries these schemas, and the model gains nothing from them.
 */
export function modelSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: "input" }) as Schema;
  delete raw.$schema;
  const variants = (raw.oneOf ?? raw.anyOf) as Schema[] | undefined;
  return clean(variants ? mergeVariants(variants) : raw) as JsonSchema;
}

function mergeVariants(variants: Schema[]): Schema {
  const properties: Record<string, Schema> = {};
  const actions: string[] = [];
  const usage: string[] = [];
  for (const v of variants) {
    const action = String(v.properties?.action?.const);
    actions.push(action);
    const fields = Object.keys(v.properties ?? {}).filter((k) => k !== "action");
    const required = new Set(v.required ?? []);
    usage.push(`${action}(${fields.map((f) => (required.has(f) ? f : `${f}?`)).join(", ")})`);
    for (const field of fields) properties[field] ??= { ...v.properties![field]! };
  }
  return {
    type: "object",
    description: `Fields by action: ${usage.join("; ")}.`,
    properties: { action: { type: "string", enum: actions }, ...properties },
    required: ["action"],
  };
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalProperties" && value === false) continue;
    if (key === "propertyNames" || key === "minLength" || key === "maxLength") continue;
    if ((key === "maximum" && value === Number.MAX_SAFE_INTEGER) || (key === "minimum" && value === Number.MIN_SAFE_INTEGER)) continue;
    out[key] = clean(value);
  }
  return out;
}

export function toDefinition(handler: ToolHandler): ToolDefinition {
  return { name: handler.name, description: handler.description, inputSchema: modelSchema(handler.schema) };
}
