import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import type { JsonSchema } from "@socrates/contracts";
import { ToolError } from "./errors";

/** Compile the server's real schema; never coerce, remove, or default model arguments. */
export function compileToolSchema(name: string, schema: JsonSchema): ValidateFunction {
  try {
    if (schema.$async) throw new Error("Asynchronous validation is unsupported.");
    const options = { strict: false, allErrors: true, validateFormats: false };
    const draft = String(schema.$schema ?? "");
    const validator = draft.includes("2020-12") ? new Ajv2020(options) : draft.includes("2019-09") ? new Ajv2019(options) : new Ajv(options);
    return validator.compile(schema);
  } catch {
    throw new ToolError("invalid_tool_schema", `${name} advertises an invalid or unsupported JSON Schema.`, "Search for another tool, or ask the user to update its server.", false);
  }
}
