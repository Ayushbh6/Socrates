# Socrates Provider Usage

This document defines how Socrates should use model providers.

The short version:

```text
V1:
  Use AI SDK v6 provider packages behind our own provider abstraction.
  Support OpenAI, Google, and OpenRouter through direct provider packages.
  Do not use Vercel AI Gateway as the default path.

V1.5:
  Add Ollama/local model support.

V2:
  Add our own direct wrappers for major providers where we need deeper control.
```

The non-negotiable architecture rule:

```text
The rest of Socrates must never depend directly on Vercel AI SDK.
```

Vercel AI SDK is an implementation detail inside `packages/providers`.

Socrates should use direct provider packages in V1:

```text
@ai-sdk/openai
@ai-sdk/google
@openrouter/ai-sdk-provider
```

Vercel AI Gateway can be added later as an optional provider route, but it should not be the default because Socrates is local-first and should let users bring direct provider keys.

## Why Start With Vercel AI SDK

Socrates needs to move quickly at the beginning.

AI SDK v6 provider packages give us a practical v1 path for:

- Streaming text.
- Tool calling.
- Provider-normalized APIs.
- OpenAI support through the OpenAI provider package.
- Google Gemini support through the Google provider package.
- OpenRouter support through `@openrouter/ai-sdk-provider`.
- Future compatibility with other provider packages.

This lets us build the main product first:

- Agent runtime.
- WebSocket event flow.
- Database audit trail.
- Tool execution.
- Approval system.
- Frontend.
- Diff and terminal views.
- Context/token tracking.

Provider wrappers are important, but they should not block the first working agent.

## Day-One Architecture

The provider layer must be structured like this:

```text
packages/core
  -> calls our ModelProvider interface

packages/providers
  -> exposes our ModelProvider interface
  -> implements AiSdkProvider
  -> imports Vercel AI SDK internally

Vercel AI SDK
  -> direct provider packages for OpenAI / Google / OpenRouter
```

The agent core should see only this:

```ts
modelProvider.stream(request)
```

It should not know whether the request is handled by:

- Vercel AI SDK.
- OpenAI direct API.
- Anthropic direct API.
- Gemini direct API.
- OpenRouter direct API.
- Ollama local API.
- LiteLLM.

## Package Boundary Rule

Only `packages/providers` may import provider SDKs.

Allowed:

```ts
// packages/providers/src/ai-sdk/aiSdkModelProvider.ts
import { streamText } from "ai"
```

Forbidden:

```ts
// packages/core/src/agent/AgentRuntime.ts
import { streamText } from "ai"
```

Forbidden:

```ts
// apps/server/src/routes/chat.ts
import { openai } from "@ai-sdk/openai"
```

Forbidden:

```ts
// apps/web/src/components/Chat.tsx
import { streamText } from "ai"
```

If Vercel AI SDK imports appear outside `packages/providers`, the architecture is being broken.

## Internal Provider Interface

Socrates should define its own small provider interface.

Example shape:

```ts
export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}
```

The request should be normalized:

```ts
export type ModelRequest = {
  providerId: string
  modelId: string
  messages: ModelMessage[]
  tools?: ModelTool[]
  thinking?: ThinkingConfig
  temperature?: number
  maxOutputTokens?: number
  providerOptions?: Record<string, unknown>
  metadata?: Record<string, unknown>
}
```

The response should be event-based.

These `model.*` events are internal provider-layer events. The server translates them into public WebSocket events such as `agent.thinking.delta`, `agent.answer.delta`, `message.completed`, and `context.usage.snapshot` before emitting or persisting the frontend-facing runtime stream.

```ts
export type ModelEvent =
  | { type: "model.started"; modelCallId: string }
  | { type: "model.reasoning.delta"; text: string }
  | { type: "model.reasoning.completed" }
  | { type: "model.answer.delta"; text: string }
  | { type: "model.answer.completed" }
  | { type: "model.tool_call.delta"; toolCallId: string; delta: unknown }
  | { type: "model.tool_call.completed"; toolCall: NormalizedToolCall }
  | { type: "model.response.metadata"; response: unknown }
  | { type: "model.usage"; usage: ModelUsage }
  | { type: "model.completed" }
  | { type: "model.failed"; error: ModelError }
```

This interface is ours. Vercel AI SDK should be adapted into this shape, not allowed to define the whole Socrates runtime.

## Tool Calling Boundary

Provider tool-calling must be normalized into Socrates' own tool interface before execution.

The V1 model-visible tool set is:

```text
read
search
edit
apply_patch
bash
trace_retrieve
list_project_resources
mcp_registry
```

MCP dynamic tool details must stay out of the system prompt and out of the first provider-call tool schemas. The first call exposes only the core Socrates tools plus `mcp_registry`; if the model checks/configures a server and the runtime exposes tools in that same turn, later provider calls may include the returned `mcp__...` tool definitions.

Provider-specific tool-call formats must not leak into `packages/core/tools`, `apps/server`, or `apps/web`. `packages/providers` adapts provider tool-call deltas and completions into normalized `ModelEvent` values. `packages/core` validates the normalized tool call against schemas from `packages/contracts`, checks permission policy, and dispatches through the tool registry.

The provider request may include these tools, but the provider layer must treat the tool definitions as data from Socrates. It must not define filesystem, shell, git, patch, or trace behavior itself.

The `bash` tool id is stable for provider compatibility, but product and prompt copy should call it Terminal. Provider adapters must pass the Socrates tool schema through unchanged; core/server/workspace own POSIX, PowerShell, cmd, and conversation-scoped Terminal behavior. Prompt guidance should tell the model to use PowerShell-compatible commands on Windows, use `operation: "start"` for dev servers/watchers/long commands, inspect existing terminal context before starting duplicates, use `operation: "status"`/`"output"`/`"stop"` with no target when exactly one active Terminal exists or with the human Terminal name when needed, and ask the user when a Terminal awaits input. Providers must not invent separate terminal, process, PowerShell, or cmd tools.

Normalized tool calls may carry opaque provider metadata required for same-turn continuation, for example `providerMetadata.google.thoughtSignature` on Gemini function calls. Providers must preserve this metadata when normalizing tool-call parts and when converting same-turn assistant tool-call messages back into provider messages. Core may carry it only in the active in-memory turn loop; server history loading must not add old thought signatures to later prompts.

Usage metadata is different from same-turn continuation metadata. The provider adapter must pass final-chunk `providerMetadata` into `ModelUsage` so OpenRouter `usage.cost`, routed provider name, cache-read fields, and raw usage metadata reach `model_usage` and `ai_usage_events`. Provider response metadata such as generation ids should be emitted through `model.response.metadata` and persisted on `model_calls.provider_response_json`.

Image handling depends on provider capability. Providers with native vision support may receive image inputs through the normalized message/tool-result path when the user or `read` tool supplies an image. Vision-capable OpenRouter, OpenAI, and Google calls must keep native image parts and Socrates tool schemas in the same AI SDK request; images are not a reason to strip tools. Non-vision providers receive bounded omission/reference text, OCR text, image metadata, or a generated visual description when available. Provider adapters must keep this normalized so vision support does not leak provider-specific image payloads into `apps/web`, `apps/server`, or unrelated core code.

## Thinking Carry-Forward Rule

Provider-exposed reasoning or thinking text may be streamed as `model.reasoning.delta`, translated to `agent.thinking.delta`, displayed in the UI, and persisted for replay when exposed.

It should not be carried forward as semantic prompt context between later user queries.

The next user query should normally receive previous final user/assistant dialogue, selected project context, retrieved memory/trace summaries when relevant, and current-turn tool results. It should not receive old reasoning streams just because they were available.

Gemini thought signatures are not user-visible thinking text. They are opaque same-turn provider metadata for tool-call continuation, and follow the same no-future-turn-history rule.

## OpenRouter Routing, Caching, And Cost

OpenRouter calls send a stable cache-affinity key derived from project and conversation identity:

```text
project:<projectId>:conversation:<conversationId>
```

This key must not include turn ids, timestamps, model-call ids, or other volatile data. It is sent as both OpenRouter `session_id` and `prompt_cache_key` so repeated same-conversation calls have a stable provider/cache-affinity hint.

These fields are sent as top-level OpenRouter provider options. Do not nest them under `extraBody` when using `providerOptions.openrouter`; the OpenRouter AI SDK spreads `providerOptions.openrouter` into the request body directly.

For multi-provider cache-capable models, Socrates sends explicit price-first routing instead of leaving routing empty. Default multi-provider routes use:

```text
sort: "price"
allow_fallbacks: true
```

This keeps OpenRouter from silently drifting onto a much more expensive upstream for the same model id, while the stable `session_id` still helps same-conversation cache locality and routed-provider capture makes the billed endpoint auditable:

```text
moonshotai/kimi-k2.6
z-ai/glm-5.1
xiaomi/mimo-v2.5-pro
google/gemma-4-31b-it
```

High-volume DeepSeek routes use a ranked provider order instead of a single hard pin. The order is chosen from live OpenRouter endpoint pricing and advertised tool support, with `allow_fallbacks: true`. For tool-using `deepseek/deepseek-v4-pro`, the first choices are:

```text
deepseek
streamlake
deepinfra
gmicloud
digitalocean
...
```

Plain-text V4 Pro requests may try `baidu` after `deepseek`, but tool-using requests skip Baidu because that endpoint does not advertise `tools` / `tool_choice`.

Within a single Socrates turn, the agent also keeps a runtime-only routed-provider preference. After the first OpenRouter call reports an actual routed provider such as `DeepInfra`, later continuations in that same turn prefer that provider first:

```text
provider: { order: ["deepinfra"], allow_fallbacks: true }
```

This is not persisted to SQLite and is not a hard block. It exists only to keep the continuation calls on the same provider/cache shard when possible.

Single-provider or deliberately pinned routes still use OpenRouter provider slugs, not display labels:

```text
xiaomi/mimo-v2.5 -> xiaomi
x-ai/grok-build-0.1 -> xai
stepfun/step-3.7-flash -> stepfun
meta-llama/llama-4-maverick title generation -> deepinfra
qwen/qwen3.5-flash-02-23 title fallback -> alibaba
```

Cost accounting order is:

```text
1. Provider-reported exact cost from OpenRouter usage metadata.
2. Computed cost from a versioned OpenRouter endpoint-pricing snapshot when exact cost is absent.
3. Unknown cost when neither provider cost nor pricing snapshot is available.
```

Computed OpenRouter costs price uncached input, cache-read input, cache-write input, and output separately. If an endpoint does not publish cache-write pricing, cache writes are priced as normal input. Raw provider usage and provider metadata should remain stored for audit. Historical rows created before `routed_provider` was added can legitimately lack routed-provider data; new rows should populate it.

There is an opt-in live cache smoke test for the OpenRouter DeepSeek Flash cache path. It makes two paid OpenRouter calls with the same model, same stable cache-affinity key, provider routing, and stable prompt prefix, then expects routed-provider and cache-read metadata on the second call:

```bash
SOCRATES_OPENROUTER_CACHE_SMOKE=1 OPENROUTER_API_KEY=... pnpm --filter @socrates/providers test -- openRouterCacheSmoke.live.test.ts
```

This cache/cost accounting and provider-routing implementation is part of the `v0.1.7` npm runtime release target. It does not merge the later dedicated `memory-work-v1` branch into `main`.

## Provider-Specific Escape Hatch

The abstraction should be clean, but not naive.

Different providers expose different capabilities:

- OpenAI reasoning differs from Anthropic thinking.
- Gemini function calling differs from OpenAI tool calls.
- OpenRouter behavior can vary based on the underlying model.
- Local models through Ollama may not support tool calling reliably.
- Usage and token reporting vary by provider.

Because of this, normalized types should include provider-specific escape hatches:

```ts
providerOptions?: Record<string, unknown>
```

and:

```ts
raw?: unknown
```

Example usage object:

```ts
export type ModelUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  uncachedInputTokens?: number
  totalTokens?: number
  costUsd?: number
  costSource?: "provider_reported" | "computed" | "unknown"
  routedProvider?: string
  pricingSnapshot?: unknown
  providerMetadata?: unknown
  raw?: unknown
}
```

This lets the core handle common behavior cleanly while the database still captures provider-specific metadata for debugging and auditability. `routedProvider` is the upstream endpoint that actually served the request: for OpenRouter this is the routed provider such as `DeepInfra` or `GMICloud`, and for direct providers it is the provider id itself. OpenRouter cost/cache fields should use provider-reported usage metadata first. OpenAI and Google may compute `costUsd` from a versioned local pricing snapshot when provider cost is absent; those rows must be marked `computed`. Missing cost with known tokens is preserved as `unknown`, not silently dropped.

Direct-provider pricing snapshots must cover every direct model exposed in the picker. The current coverage is OpenAI `gpt-5`, `gpt-5.4`, `gpt-5.4-mini` and Google `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`. Gemini 3.1 Pro pricing must switch to the documented long-context rates when a provider call has more than 200k prompt/input tokens.

## V1 Provider Plan

V1 should use one main adapter:

```text
AiSdkProvider
```

It should support:

```text
providerId = openai
providerId = google
providerId = openrouter
```

Current internal files:

```text
packages/providers/
  src/
    types.ts
    ProviderRouter.ts
    index.ts
    ai-sdk/
      AiSdkProvider.ts
    modelCatalog/
      modelCatalog.ts
```

The provider router should select an implementation:

```text
openai     -> AiSdkProvider in V1
google     -> AiSdkProvider in V1
openrouter -> AiSdkProvider in V1
```

OpenRouter should be supported through the Vercel AI SDK OpenRouter provider package, not through a custom direct wrapper in V1.

Anthropic is intentionally skipped in the current V1 implementation. It can be added later through the same `packages/providers` boundary.

## Provider Credentials

The npm CLI/browser app stores user provider keys in `~/.Socrates/.env` through the local backend. Packaged Tauri builds store provider keys in the OS keychain through the Tauri shell. The backend receives newly saved keys through a session credential endpoint immediately after save. Development still supports `.env`/server environment fallback.

Credential policy:

```text
OpenRouter -> required for default chat and context compression
OpenAI     -> required only for hosted OpenAI embeddings when local Ollama embeddings are not selected/available
Google     -> optional chat provider
```

Provider APIs, model calls, telemetry, events, and SQLite rows must never persist or return raw provider key values. Credential status APIs may return only provider id, configured boolean, source, required flag, and safe messages.

## V1 Model Catalog And Thinking Rules

The current selectable V1 catalog is backend-owned in `packages/providers/src/modelCatalog/modelCatalog.ts` and is exposed to the frontend through `GET /api/models`.

```text
OpenAI
  gpt-5.4-mini
  gpt-5.4
  gpt-5

Google
  gemini-3.1-pro-preview
  gemini-3-flash-preview
  gemini-3.1-flash-lite-preview

OpenRouter
  moonshotai/kimi-k2.6
  z-ai/glm-5.1                  no vision
  xiaomi/mimo-v2.5-pro
  xiaomi/mimo-v2.5
  x-ai/grok-build-0.1
  stepfun/step-3.7-flash
  deepseek/deepseek-v4-pro   default
  deepseek/deepseek-v4-flash    no vision
  google/gemma-4-31b-it
```

Vision capability must come from the backend model catalog. For OpenRouter, all listed providers/models are treated as vision-capable except GLM and the DeepSeek V4 models, whose `capabilities.vision` flag must remain `false` so chat attachments are warned in the UI and image bytes are omitted from provider requests. MiMo Pro is vision-capable and must keep native image paths enabled.

Thinking controls are normalized in Socrates contracts and translated inside `AiSdkProvider`:

```text
OpenAI:
  none, low, medium, high, xhigh
  none means non-thinking mode

Google:
  gemini-3.1-pro-preview -> low, medium, high
  gemini-3-flash-preview -> minimal, low, medium, high
  gemini-3.1-flash-lite-preview -> minimal, low, medium, high

OpenRouter:
  off, on
```

Provider mapping:

```text
OpenAI -> providerOptions.openai.reasoningEffort
Google -> providerOptions.google.thinkingConfig.thinkingLevel
OpenRouter on -> providerOptions.openrouter.reasoning enabled
OpenRouter off -> providerOptions.openrouter.reasoning effort none and exclude true
```

OpenAI prompt caching is automatic for supported models when the stable prefix is large enough. Socrates sends `providerOptions.openai.promptCacheKey` from the same project/conversation cache key to improve cache-affinity routing, but does not create explicit OpenAI cache resources.

Google/Gemini implicit caching is automatic for supported models when prompts meet model thresholds. Socrates does not create explicit Gemini cached-content resources by default; explicit Gemini caches are a separate workflow and should be added only if there is a clear product need.

OpenRouter model requests always include cost-aware routing. `packages/providers/src/openRouterRouting.ts` is the authoritative map. Multi-provider models default to price-first routing with `sort: "price"` and `allow_fallbacks: true`; DeepSeek V4 routes use cheap-compatible ranked provider orders; later continuations in the same turn prefer the actual routed provider reported by OpenRouter. Deliberate pins use OpenRouter provider slugs such as `deepinfra`, `alibaba`, and `xai`, not display labels such as `DeepInfra`. Unknown OpenRouter models fall back to the same price-first routing so no model is sent with empty routing.

OpenRouter streams can arrive in provider-side bursts after a long first-token delay. Socrates applies AI SDK `smoothStream` only on OpenRouter calls to re-chunk bursty text into a steadier word-level stream. This improves perceived streaming once chunks arrive; it does not reduce upstream time-to-first-token.

Provider streams must not hang forever. The AI SDK adapter applies an idle stream timeout with a default of `120000` milliseconds, configurable through `SOCRATES_MODEL_STREAM_IDLE_TIMEOUT_MS`. If no model event arrives before the timeout, the provider layer aborts the request and emits a structured `model.failed` event with code `model_stream_idle_timeout`, including provider/model/timeout details.

The frontend must render this catalog from the backend response. It must not hardcode model ids or provider option mappings.

## Context Compressor Model Selection

The locked primary compressor is:

```text
providerId = openrouter
modelId = deepseek/deepseek-v4-flash
thinking = off
```

The locked fallback compressor is:

```text
providerId = openrouter
modelId = stepfun/step-3.7-flash
thinking = off
```

Both compressor routes must use OpenRouter thinking off explicitly:

```text
providerOptions.openrouter.reasoning = { effort: "none", exclude: true }
```

The local/release evaluation gate should continue to run both models on the same compression fixtures and score:

- Faithfulness to source messages and tool evidence.
- Preservation of decisions, rules, blockers, and unresolved tasks.
- Correct inclusion of `trace_retrieve` inspect handles for exact recall.
- Concision under a target token budget.
- Latency and cost.
- Failure modes such as invented facts, dropped constraints, or vague summaries without handles.

The current evaluation selected `deepseek/deepseek-v4-flash` because both candidates preserved all required facts and DeepSeek used fewer output/total tokens. `stepfun/step-3.7-flash` remains the runtime fallback if the primary compressor call fails.

The compressor model is an internal runtime choice. The frontend should not hardcode or expose compressor provider mappings unless a later settings surface is explicitly designed.

Vercel AI Gateway should be skipped in V1. If added later, it should be treated as another provider route:

```text
gateway -> AiGatewayProvider
```

It must not replace the direct provider strategy.

## V1.5 Provider Plan

V1.5 should add local model support.

Primary target:

```text
ollama
```

Implementation options:

```text
Option A:
  Use a Vercel AI SDK compatible Ollama provider if it handles our needs cleanly.

Option B:
  Build our own direct OllamaProvider if we need tighter control.
```

Ollama may need custom handling because local model behavior can differ from hosted APIs:

- Tool calling may not be reliable across all models.
- Reasoning output may not be structured.
- Token usage may be estimated instead of provider-reported.
- Streaming payloads may need custom parsing.

For this reason, Ollama is explicitly allowed to become the first direct provider wrapper if needed.

## V2 Provider Plan

After the main app works, Socrates can add direct wrappers for major providers.

Likely order:

```text
1. OpenAIProvider
2. AnthropicProvider
3. GoogleProvider
4. OpenRouterProvider
5. OllamaProvider if not already added
6. LiteLLMProvider if useful
```

The router can gradually change:

```text
openai     -> OpenAIProvider
anthropic  -> AnthropicProvider
google     -> AiSdkProvider until direct wrapper exists
openrouter -> AiSdkProvider until direct wrapper exists
ollama     -> OllamaProvider
unknown    -> AiSdkProvider fallback
```

This allows migration one provider at a time.

## Migration Difficulty

If the package boundary is respected, later migration should be manageable.

Expected difficulty:

```text
Direct OpenAI wrapper:
  easy to medium

Direct Anthropic wrapper:
  medium

Direct Google wrapper:
  medium to hard

Direct OpenRouter wrapper:
  medium

Direct Ollama wrapper:
  medium, because local model behavior varies
```

The hard part is not swapping files. The hard part is normalizing provider differences:

- Different streaming formats.
- Different tool-call formats.
- Different reasoning/thinking formats.
- Different usage fields.
- Different error payloads.
- Different retry and rate-limit behavior.

That is why the normalized `ModelProvider` interface and event model must exist from day one.

## Provider Router

Socrates should route provider requests through one router.

Example:

```ts
export class ProviderRouter implements ModelProvider {
  constructor(private providers: Record<string, ModelProvider>) {}

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const provider = this.providers[request.providerId]

    if (!provider) {
      throw new Error(`Unknown provider: ${request.providerId}`)
    }

    return provider.stream(request)
  }
}
```

The router gives us a stable place to change mappings later.

The rest of the app should not care whether `providerId = openai` is routed to `AiSdkProvider` or `OpenAIProvider`.

## Database Implications

The database must always store both normalized and raw provider details where useful.

Important tables:

```text
turn_runtime_configs
model_calls
model_stream_chunks
model_usage
context_usage_snapshots
events
errors
```

For every model call, Socrates should store:

- Provider id.
- Model id.
- Runtime config.
- Normalized request.
- Provider-specific request if captured.
- Normalized response summary.

## Context Token Counting

Context accounting belongs behind `packages/providers` because tokenizer behavior is provider/model-specific. The internal `ModelProvider` interface exposes `countTokens(request)`, and `packages/core` uses that count before each provider call, including every tool-loop continuation.

The counted payload is the normalized provider-call request: system prompt, visible messages, hidden compaction summaries, current-turn tool calls/results, and full tool definitions/schemas. Completed prior turns are still loaded as visible user query plus final assistant answer only; old tool traces remain persisted audit data unless retrieved or summarized into current context.

Same-turn tool results are not allowed to grow without bound. After a turn crosses 10 tool calls, earlier failed tool results may be compacted to one-line placeholders and earlier oversized tool results may be replaced in the model-visible prompt with a short preview plus retrieval guidance. This compaction affects only the active in-memory prompt history; raw tool calls, shell commands, Terminal output chunks, trace documents, events, and model usage rows remain persisted for audit. Started Terminal `status`, `output`, and `stop` are model-visible deltas based on a backend cursor, while the full terminal stream remains available to the UI and `trace_retrieve mode="audit" include=["shell"]`.

OpenAI/OpenRouter local counts use `js-tiktoken` mappings where possible. Unknown OpenRouter/local model tokenizers use the local fallback tokenizer with a 15 percent safety margin. Google requests may use Gemini provider-exact `countTokens` near thresholds when credentials are configured; otherwise the local/fallback safety count is used.

`contextUsage` and `context_usage_snapshots` store the safety count used for context budgeting. `tokenUsage` and `model_usage` remain provider-reported cost/diagnostic usage and must not drive the chat header.
- Provider-specific response if captured.
- Stream chunks.
- Usage.
- Errors.

This matters because during provider migration we need to compare:

```text
AiSdkProvider behavior vs direct provider wrapper behavior
```

The DB should make those differences visible.

## Embedding Provider Plan

Trace retrieval should support semantic search through embeddings, but embedding generation must not sit in the user-facing chat latency path.

The current trace retrieval and embedding flow:

```text
turn completes or is cancelled
  -> raw messages, tool calls, events, shell output, patches, errors are persisted
  -> server creates trace_documents
  -> server enqueues trace_index_jobs
  -> trace_retrieve can use lexical search immediately
  -> trace_retrieve normal search returns slim message-first rows
  -> trace_retrieve inspect can return exact bounded source by resultNumber, messageId, toolId, or compatible handle
  -> if semantic search is configured, server enqueues embed_trace_documents
  -> embedding runner stores trace_embeddings asynchronously
```

The semantic phase adds background embedding jobs and makes `mode = "semantic"` prefer embedding similarity. If semantic search is not configured or the active provider is unavailable, retrieval degrades to lexical/exact behavior with a warning.

The embedding phase ships with two first-class provider choices:

```text
hosted default:
  providerId = openai
  modelId = text-embedding-3-small

offline local:
  providerId = ollama
  modelId = embeddinggemma, mxbai-embed-large, nomic-embed-text, all-minilm, or another configured local embedding model
```

OpenAI `text-embedding-3-small` is the preferred hosted default because it is inexpensive, stable, and has a known 1536-dimensional default embedding size. It is configurable and not hardcoded into the retrieval algorithm.

The local/offline path is a real supported mode, not a hack. The preferred local backend is Ollama because it can run embedding models behind a local HTTP API and avoids putting Python/Torch setup inside the main Socrates server. Socrates detects whether the local server is reachable and whether the selected embedding model is pulled. It does not silently install or download models; it shows explicit setup guidance such as `ollama pull embeddinggemma` when setup is missing.

Hugging Face / sentence-transformers should be an advanced local backend after the Ollama path is stable. Good candidates include `sentence-transformers/all-mpnet-base-v2` for quality and smaller MiniLM-style models for speed. This path should run behind the same `EmbeddingProvider` interface, likely through a local Python helper/service or Hugging Face Text Embeddings Inference, rather than importing Python/Torch concerns into `apps/server`.

The setup UX belongs on the project dashboard. The Semantic Search panel opens a modal that asks the user to choose Online or Offline, runs backend diagnostics, shows explicit setup guidance, saves project embedding config, and starts indexing. The frontend presents progress and errors from backend status endpoints; it must not call embedding providers directly.

Possible later hosted providers:

```text
openrouter
```

OpenRouter may offer cheaper embedding model options through its gateway. Socrates may add OpenRouter embeddings later, but the first semantic phase should prioritize the simpler hosted default plus the fully offline local option.

Provider boundary rules for embeddings:

- Embedding SDK/API calls belong behind `packages/providers`.
- Use the provider-agnostic `EmbeddingProvider` boundary separate from the chat `ModelProvider`.
- `apps/web` must never call embedding providers.
- `packages/core` should not import embedding SDKs.
- `apps/server` may enqueue and coordinate embedding jobs, but provider-specific request details should stay inside the provider layer.
- Embedding rows must store provider id, model id, dimensions, content hash, and raw metadata where useful.
- Retrieval must never compare vectors from different embedding spaces. Query embeddings and stored `trace_embeddings` rows must match on provider id, model id, and dimensions.
- Unchanged trace documents must not be re-embedded. Use `content_hash`.
- Failed embedding jobs should degrade gracefully to lexical/exact retrieval.

Embedding content should be built from `trace_documents`, not from arbitrary raw event dumps. Good embedding inputs include:

- Message chunks.
- Turn summaries.
- Conversation summaries.
- Verbatim anchors.
- Tool-call summaries.
- Shell command outcome summaries.
- Patch/error summaries.

Do not embed old provider reasoning streams as semantic conversation memory by default. Provider-exposed reasoning can remain available for UI/replay, but it should not become later-turn semantic prompt history unless a future explicit policy changes that.

## Frontend Implications

The frontend should use provider ids and model ids from Socrates contracts/config.

The frontend must not know provider SDK details.

Good:

```text
providerId = openai
modelId = gpt-...
```

Bad:

```text
frontend imports @ai-sdk/openai
frontend builds OpenAI request payloads
frontend knows Anthropic message block format
```

The frontend sends selected settings to the server. The backend/core/provider layers translate them.

The chat composer may switch provider, model, and thinking mode between turns in the same conversation. Each user query persists its selected runtime config in `turn_runtime_configs`.

## Non-Negotiable Rules

1. Vercel AI SDK must stay inside `packages/providers`.
2. `packages/core` must call only the Socrates `ModelProvider` interface.
3. Provider-specific request/response details must not leak into the agent loop.
4. Provider-specific raw metadata should be stored in the DB for auditability.
5. OpenRouter should use the AI SDK provider in V1.
6. Ollama should be added in V1.5, either through an AI SDK-compatible provider or a direct wrapper.
7. Direct wrappers for big providers should be added only after the main app works.
8. Provider routing must be centralized in `ProviderRouter`.
9. The code must be written from day one as if Vercel AI SDK may be replaced later.
10. If a provider feature cannot be normalized cleanly, expose it through `providerOptions` and persist raw metadata.
11. Embedding provider access must follow the same boundary as text providers: provider-specific behavior behind `packages/providers`, no frontend/provider SDK leakage.
