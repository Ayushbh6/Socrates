import fs from "node:fs"
import path from "node:path"
import type {
  CheckProviderCredentialResponse,
  ProviderCredentialSource,
  ProviderCredentialStatus,
  ProviderId,
  SetProviderCredentialSessionRequest,
} from "@socrates/contracts"
import { envProviderApiKey, type ProviderCredentialResolver } from "@socrates/providers"

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

export class ProviderCredentialStore implements ProviderCredentialResolver {
  private readonly sessionKeys = new Map<ProviderId, string>()
  private readonly sessionSources = new Map<ProviderId, Exclude<ProviderCredentialSource, "env" | "missing">>()
  private readonly localEnvPath: string | undefined

  constructor(options: ProviderCredentialStoreOptions = {}) {
    this.localEnvPath = options.socratesHome ? path.join(options.socratesHome, ".env") : undefined
  }

  getApiKey(providerId: ProviderId): string | undefined {
    return this.sessionKeys.get(providerId) ?? this.localFileApiKey(providerId) ?? envProviderApiKey(providerId)
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
    return {
      providerId,
      providerLabel: providerLabels[providerId],
      required: providerId === "openrouter",
      configured: source !== "missing",
      source,
      ...(providerId === "openrouter"
        ? { message: "Required for chat and context compression." }
        : providerId === "openai"
          ? { message: "Required when hosted OpenAI embeddings are selected instead of local Ollama embeddings." }
          : { message: "Optional chat provider." }),
    }
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
