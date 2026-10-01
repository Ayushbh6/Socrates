import { randomUUID } from "node:crypto";

/** Backend-owned canonical identifiers. Never shown to a model or the user. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
