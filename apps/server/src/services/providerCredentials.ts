import fs from "node:fs"
import path from "node:path"
import type {
  CheckProviderCredentialResponse,
  ProviderAuthMode,
  ProviderCredentialSource,
  ProviderCredentialStatus,
  ProviderId,
  SetProviderCredentialSessionRequest,
} from "@socrates/contracts"
import { envProviderApiKey, type ProviderCredentialResolver, type ProviderResolvedCredential } from "@socrates/providers"
import { SocratesError, nowIso } from "@socrates/shared"
import {
  OPENAI_CODEX_API_ENDPOINT,
  OPENAI_CODEX_DUMMY_API_KEY,
  OpenAiCodexOAuthCoordinator,
  openAiCodexTokensToStored,
  refreshOpenAiCodexAccessToken,
  type OpenAiCodexStoredTokens,
} from "./openAiCodexOAuth"

const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
}

const providerEnvVars: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
}

const providers: ProviderId[] = ["openrouter", "openai", "google"]

type ProviderCredentialStoreOptions = {
  socratesHome?: string | undefined
}

type OpenAiChatGptTokens = OpenAiCodexStoredTokens

export class ProviderCredentialStore implements ProviderCredentialResolver {
  private readonly sessionKeys = new Map<ProviderId, string>()
  private readonly sessionSources = new Map<ProviderId, Exclude<ProviderCredentialSource, "env" | "missing">>()
  private readonly localEnvPath: string | undefined
  private readonly openAiChatGptTokenPath: string | undefined
  private readonly openAiCodexOAuth: OpenAiCodexOAuthCoordinator
  private openAiChatGptSessionTokens: OpenAiChatGptTokens | undefined
  private refreshOpenAiChatGptPromise: Promise<OpenAiChatGptTokens> | undefined

  constructor(options: ProviderCredentialStoreOptions = {}) {
    this.localEnvPath = options.socratesHome ? path.join(options.socratesHome, ".env") : undefined
    this.openAiChatGptTokenPath = options.socratesHome
      ? path.join(options.socratesHome, ".credentials", "openai-chatgpt-oauth.json")
      : undefined
    this.openAiCodexOAuth = new OpenAiCodexOAuthCoordinator((tokens) => this.writeOpenAiChatGptTokens(tokens))
  }

  getApiKey(providerId: ProviderId): string | undefined {
    return this.sessionKeys.get(providerId) ?? this.localFileApiKey(providerId) ?? envProviderApiKey(providerId)
  }

  resolveAuth(providerId: ProviderId, authMode: ProviderAuthMode = "api_key"): ProviderResolvedCredential | undefined {
    if (authMode === "api_key") {
      const apiKey = this.getApiKey(providerId)
      return apiKey ? { authMode: "api_key", apiKey } : undefined
    }
    if (providerId !== "openai" || !this.readOpenAiChatGptTokens()) {
      return undefined
    }
    return {
      authMode: "chatgpt_subscription",
      apiKey: OPENAI_CODEX_DUMMY_API_KEY,
      fetch: (requestInput: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => this.fetchOpenAiCodex(requestInput, init),
    }
  }

  availableAuthModes(): Array<{ providerId: ProviderId; authMode: ProviderAuthMode }> {
    return [
      ...(this.getApiKey("openrouter") ? [{ providerId: "openrouter" as const, authMode: "api_key" as const }] : []),
      ...(this.getApiKey("openai") ? [{ providerId: "openai" as const, authMode: "api_key" as const }] : []),
      ...(this.readOpenAiChatGptTokens() ? [{ providerId: "openai" as const, authMode: "chatgpt_subscription" as const }] : []),
      ...(this.getApiKey("google") ? [{ providerId: "google" as const, authMode: "api_key" as const }] : []),
    ]
  }

  listStatus(): {
    providers: ProviderCredentialStatus[]
    openRouterRequired: boolean
    openAiRequiredForHostedEmbeddings: boolean
    googleOptional: boolean
  } {
    return {
      providers: providers.map((providerId) => this.statusFor(providerId)),
      openRouterRequired: true,
      openAiRequiredForHostedEmbeddings: true,
      googleOptional: true,
    }
  }

  setSessionCredential(input: SetProviderCredentialSessionRequest): ProviderCredentialStatus {
    if (input.source === "local_file") {
      this.writeLocalFileCredential(input.providerId, input.apiKey)
    }
    this.sessionKeys.set(input.providerId, input.apiKey)
    this.sessionSources.set(input.providerId, this.sessionSourceFor(input.source))
    return this.statusFor(input.providerId)
  }

  deleteSessionCredential(providerId: ProviderId): ProviderCredentialStatus {
    this.sessionKeys.delete(providerId)
    this.sessionSources.delete(providerId)
    this.deleteLocalFileCredential(providerId)
    return this.statusFor(providerId)
  }

  check(providerId: ProviderId, apiKey?: string): CheckProviderCredentialResponse {
    const source = apiKey ? "session" : this.sourceFor(providerId)
    const configured = Boolean(apiKey ?? this.getApiKey(providerId))
    return {
      providerId,
      ok: configured,
      configured,
      source,
      message: configured
        ? `${providerLabels[providerId]} credential is configured.`
        : `${providerLabels[providerId]} credential is missing.`,
    }
  }

  statusFor(providerId: ProviderId): ProviderCredentialStatus {
    const source = this.sourceFor(providerId)
    const openAiChatGptSource = providerId === "openai" ? this.openAiChatGptSourceFor() : "missing"
    const authModes = this.authModesFor(providerId)
    return {
      providerId,
      providerLabel: providerLabels[providerId],
      required: providerId === "openrouter",
      configured: source !== "missing" || openAiChatGptSource !== "missing",
      source: source !== "missing" ? source : openAiChatGptSource,
      authModes,
      ...(providerId === "openrouter"
        ? { message: "Required for the default chat model and context compression." }
        : providerId === "openai"
          ? { message: "OpenAI API keys support chat and hosted embeddings. ChatGPT Codex uses subscription auth for chat only." }
          : { message: "Optional chat provider." }),
    }
  }

  async startOpenAiChatGptOAuth(): Promise<{ authorizationUrl: string; state: string; redirectUri: string; expiresAt: string }> {
    return this.openAiCodexOAuth.start()
  }

  deleteOpenAiChatGptOAuth(): ProviderCredentialStatus {
    this.openAiChatGptSessionTokens = undefined
    this.refreshOpenAiChatGptPromise = undefined
    this.openAiCodexOAuth.close()
    if (this.openAiChatGptTokenPath && fs.existsSync(this.openAiChatGptTokenPath)) {
      fs.rmSync(this.openAiChatGptTokenPath)
    }
    return this.statusFor("openai")
  }

  private authModesFor(providerId: ProviderId): ProviderCredentialStatus["authModes"] {
    if (providerId === "openai") {
      const apiSource = this.sourceFor("openai")
      const chatGptSource = this.openAiChatGptSourceFor()
      return [
        {
          authMode: "api_key",
          label: "OpenAI API",
          configured: apiSource !== "missing",
          source: apiSource,
          message: apiSource !== "missing" ? "OpenAI API key configured." : "OpenAI API key missing.",
        },
        {
          authMode: "chatgpt_subscription",
          label: "ChatGPT Codex",
          configured: chatGptSource !== "missing",
          source: chatGptSource,
          message: chatGptSource !== "missing" ? "ChatGPT Codex subscription auth configured." : "ChatGPT Codex auth not connected.",
        },
      ]
    }
    const source = this.sourceFor(providerId)
    return [
      {
        authMode: "api_key",
        label: `${providerLabels[providerId]} API`,
        configured: source !== "missing",
        source,
      },
    ]
  }

  private sourceFor(providerId: ProviderId): ProviderCredentialSource {
    if (this.sessionKeys.has(providerId)) {
      return this.sessionSources.get(providerId) ?? "session"
    }
    if (this.localFileApiKey(providerId)) {
      return "local_file"
    }
    return envProviderApiKey(providerId) ? "env" : "missing"
  }

  private openAiChatGptSourceFor(): ProviderCredentialSource {
    if (this.openAiChatGptSessionTokens) {
      return "session"
    }
    return this.openAiChatGptTokenPath && fs.existsSync(this.openAiChatGptTokenPath) ? "local_file" : "missing"
  }

  private sessionSourceFor(
    source: SetProviderCredentialSessionRequest["source"],
  ): Exclude<ProviderCredentialSource, "env" | "missing"> {
    if (source === "keychain" || source === "local_file") {
      return source
    }
    return "session"
  }

  private localFileApiKey(providerId: ProviderId): string | undefined {
    if (!this.localEnvPath || !fs.existsSync(this.localEnvPath)) {
      return undefined
    }
    const values = parseEnvFile(fs.readFileSync(this.localEnvPath, "utf8"))
    return values.get(providerEnvVars[providerId]) ?? (providerId === "google" ? values.get("GEMINI_API_KEY") : undefined)
  }

  private writeLocalFileCredential(providerId: ProviderId, apiKey: string): void {
    if (!this.localEnvPath) {
      return
    }
    const entries = this.readLocalEnvEntries()
    entries.set(providerEnvVars[providerId], apiKey)
    this.writeLocalEnvEntries(entries)
  }

  private deleteLocalFileCredential(providerId: ProviderId): void {
    if (!this.localEnvPath || !fs.existsSync(this.localEnvPath)) {
      return
    }
    const entries = this.readLocalEnvEntries()
    entries.delete(providerEnvVars[providerId])
    if (providerId === "google") {
      entries.delete("GEMINI_API_KEY")
    }
    this.writeLocalEnvEntries(entries)
  }

  private readLocalEnvEntries(): Map<string, string> {
    if (!this.localEnvPath || !fs.existsSync(this.localEnvPath)) {
      return new Map()
    }
    return parseEnvFile(fs.readFileSync(this.localEnvPath, "utf8"))
  }

  private writeLocalEnvEntries(entries: Map<string, string>): void {
    if (!this.localEnvPath) {
      return
    }
    fs.mkdirSync(path.dirname(this.localEnvPath), { recursive: true })
    const content = [...entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n")
    fs.writeFileSync(this.localEnvPath, `${content}${content ? "\n" : ""}`, { mode: 0o600 })
    if (process.platform !== "win32") {
      fs.chmodSync(this.localEnvPath, 0o600)
    }
  }

  private readOpenAiChatGptTokens(): OpenAiChatGptTokens | undefined {
    if (this.openAiChatGptSessionTokens) {
      return this.openAiChatGptSessionTokens
    }
    if (!this.openAiChatGptTokenPath || !fs.existsSync(this.openAiChatGptTokenPath)) {
      return undefined
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.openAiChatGptTokenPath, "utf8")) as Partial<OpenAiChatGptTokens>
      if (!parsed.refresh || !parsed.access || typeof parsed.expires !== "number") {
        return undefined
      }
      this.openAiChatGptSessionTokens = {
        refresh: parsed.refresh,
        access: parsed.access,
        expires: parsed.expires,
        ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
        ...(parsed.email ? { email: parsed.email } : {}),
        updatedAt: parsed.updatedAt ?? nowIso(),
      }
      return this.openAiChatGptSessionTokens
    } catch {
      return undefined
    }
  }

  private writeOpenAiChatGptTokens(tokens: OpenAiChatGptTokens): void {
    this.openAiChatGptSessionTokens = tokens
    if (!this.openAiChatGptTokenPath) {
      return
    }
    fs.mkdirSync(path.dirname(this.openAiChatGptTokenPath), { recursive: true })
    fs.writeFileSync(this.openAiChatGptTokenPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== "win32") {
      fs.chmodSync(this.openAiChatGptTokenPath, 0o600)
    }
  }

  private async freshOpenAiChatGptTokens(): Promise<OpenAiChatGptTokens> {
    const tokens = this.readOpenAiChatGptTokens()
    if (!tokens) {
      throw new SocratesError("openai_chatgpt_auth_missing", "ChatGPT Codex auth is not connected.", { recoverable: true })
    }
    if (tokens.expires > Date.now() + 30_000) {
      return tokens
    }
    if (!this.refreshOpenAiChatGptPromise) {
      this.refreshOpenAiChatGptPromise = refreshOpenAiCodexAccessToken(tokens.refresh)
        .then((response) => {
          const refreshed = openAiCodexTokensToStored(response, tokens)
          this.writeOpenAiChatGptTokens(refreshed)
          return refreshed
        })
        .finally(() => {
          this.refreshOpenAiChatGptPromise = undefined
        })
    }
    return this.refreshOpenAiChatGptPromise
  }

  private async fetchOpenAiCodex(requestInput: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const tokens = await this.freshOpenAiChatGptTokens()
    const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    }
    headers.delete("authorization")
    headers.set("authorization", `Bearer ${tokens.access}`)
    if (tokens.accountId) {
      headers.set("ChatGPT-Account-Id", tokens.accountId)
    }

    const parsed = requestInput instanceof URL
      ? requestInput
      : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
    const url = parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
      ? new URL(OPENAI_CODEX_API_ENDPOINT)
      : parsed
    return fetch(url, {
      ...(requestInput instanceof Request
        ? {
            method: requestInput.method,
            body: requestInput.body,
            redirect: requestInput.redirect,
            signal: requestInput.signal,
          }
        : {}),
      ...init,
      headers,
    })
  }
}

const parseEnvFile = (content: string): Map<string, string> => {
  const values = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    const separator = trimmed.indexOf("=")
    if (separator === -1) {
      continue
    }
    const key = trimmed.slice(0, separator).trim()
    const rawValue = trimmed.slice(separator + 1).trim()
    if (!key) {
      continue
    }
    values.set(key, parseEnvValue(rawValue))
  }
  return values
}

const parseEnvValue = (value: string): string => {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
