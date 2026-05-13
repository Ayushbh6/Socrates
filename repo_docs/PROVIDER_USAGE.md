# Socrates Provider Usage

This document defines how Socrates should use model providers.

The short version:

```text
V1:
  Use AI SDK v6 provider packages behind our own provider abstraction.
  Support OpenAI, Anthropic, Google, and OpenRouter through direct provider packages.
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
@ai-sdk/anthropic
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
- Anthropic support through the Anthropic provider package.
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
  -> direct provider packages for OpenAI / Anthropic / Google / OpenRouter
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

The response should be event-based:

```ts
export type ModelEvent =
  | { type: "model.started"; modelCallId: string }
  | { type: "model.reasoning.delta"; text: string }
  | { type: "model.reasoning.completed" }
  | { type: "model.answer.delta"; text: string }
  | { type: "model.answer.completed" }
  | { type: "model.tool_call.delta"; toolCallId: string; delta: unknown }
  | { type: "model.tool_call.completed"; toolCall: NormalizedToolCall }
  | { type: "model.usage"; usage: ModelUsage }
  | { type: "model.completed" }
  | { type: "model.failed"; error: ModelError }
```

This interface is ours. Vercel AI SDK should be adapted into this shape, not allowed to define the whole Socrates runtime.

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
  totalTokens?: number
  costUsd?: number
  raw?: unknown
}
```

This lets the core handle common behavior cleanly while the database still captures provider-specific metadata for debugging and auditability.

## V1 Provider Plan

V1 should use one main adapter:

```text
AiSdkProvider
```

It should support:

```text
providerId = openai
providerId = anthropic
providerId = google
providerId = openrouter
```

Expected internal files:

```text
packages/providers/
  src/
    types.ts
    ProviderRouter.ts
    ai-sdk/
      AiSdkProvider.ts
      aiSdkModelRegistry.ts
      aiSdkUsageMapper.ts
      aiSdkEventMapper.ts
```

The provider router should select an implementation:

```text
openai     -> AiSdkProvider in V1
anthropic  -> AiSdkProvider in V1
google     -> AiSdkProvider in V1
openrouter -> AiSdkProvider in V1
```

OpenRouter should be supported through the Vercel AI SDK OpenRouter provider package, not through a custom direct wrapper in V1.

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
- Provider-specific response if captured.
- Stream chunks.
- Usage.
- Errors.

This matters because during provider migration we need to compare:

```text
AiSdkProvider behavior vs direct provider wrapper behavior
```

The DB should make those differences visible.

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
