import { urlFetchToolInputSchema, urlFetchToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool, ToolPolicyDecision } from "./types"

const localHostPattern = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|.+\.local)$/i

const decideUrlFetchPolicy: SocratesTool<typeof urlFetchToolInputSchema._type, typeof urlFetchToolOutputSchema._type>["decidePolicy"] = (
  input,
): ToolPolicyDecision => {
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return { type: "denied", code: "invalid_url", recoverable: true, reason: "The URL is not valid." }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { type: "denied", code: "unsupported_url_scheme", recoverable: true, reason: "URL fetch only supports http and https URLs." }
  }

  if (localHostPattern.test(parsed.hostname)) {
    return {
      type: "approval_required",
      request: {
        actionKind: "other",
        title: "Approve local URL fetch",
        description: "Socrates wants to fetch a localhost or private-network URL.",
        actionPreview: input.url,
        risk: "medium",
      },
    }
  }

  return { type: "auto" }
}

export const urlFetchTool: SocratesTool<typeof urlFetchToolInputSchema._type, typeof urlFetchToolOutputSchema._type> = {
  name: "url_fetch",
  description:
    "Fetch one exact http(s) URL as bounded text or metadata. Use this to read a specific page, docs URL, redirect, JSON, CSV, or plain-text resource. It does not search the web, crawl links, save files, install packages, or return binary bodies. For broad web search use configured search/MCP capabilities; for complex parsing or comparison, combine this with read/search and Terminal one-off scripts.",
  inputSchema: urlFetchToolInputSchema,
  resultSchema: urlFetchToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "search",
  decidePolicy: decideUrlFetchPolicy,
  execute: (input, context) => context.executors.url_fetch(input, context),
  summary: (output) => `Fetched ${output.finalUrl} (${output.status}${output.contentType ? ` ${output.contentType}` : ""}).`,
  resultPreview: (output) =>
    output.text ??
    [
      `url: ${output.url}`,
      `finalUrl: ${output.finalUrl}`,
      `status: ${output.status}`,
      output.contentType ? `contentType: ${output.contentType}` : undefined,
      output.contentLength === undefined ? undefined : `contentLength: ${output.contentLength}`,
      ...(output.warnings ?? []),
    ]
      .filter(Boolean)
      .join("\n"),
  metrics: () => ({ searchesRun: 1 }),
}
