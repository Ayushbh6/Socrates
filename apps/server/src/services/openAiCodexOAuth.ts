import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { SocratesError, nowIso } from "@socrates/shared"

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_CODEX_ISSUER = "https://auth.openai.com"
export const OPENAI_CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const OPENAI_CODEX_DUMMY_API_KEY = "socrates-chatgpt-oauth"

const OPENAI_CODEX_OAUTH_PORT = 1455
const OPENAI_CODEX_OAUTH_REDIRECT_URI = `http://localhost:${OPENAI_CODEX_OAUTH_PORT}/auth/callback`
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000

export type OpenAiCodexStoredTokens = {
  refresh: string
  access: string
  expires: number
  accountId?: string
  email?: string
  updatedAt: string
}

export type OpenAiCodexTokenResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

type PkceCodes = {
  verifier: string
  challenge: string
}

type PendingOpenAiCodexOAuth = {
  verifier: string
  state: string
  expiresAt: number
}

type JwtClaims = {
  chatgpt_account_id?: string
  organizations?: Array<{ id?: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export class OpenAiCodexOAuthCoordinator {
  private server: Server | undefined
  private pending: PendingOpenAiCodexOAuth | undefined

  constructor(private readonly saveTokens: (tokens: OpenAiCodexStoredTokens) => void) {}

  async start(): Promise<{ authorizationUrl: string; state: string; redirectUri: string; expiresAt: string }> {
    await this.ensureServer()
    const pkce = generatePkce()
    const state = randomBase64Url(32)
    const expiresAt = Date.now() + OAUTH_STATE_TTL_MS
    this.pending = {
      verifier: pkce.verifier,
      state,
      expiresAt,
    }
    const params = new URLSearchParams({
      response_type: "code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      redirect_uri: OPENAI_CODEX_OAUTH_REDIRECT_URI,
      scope: "openid profile email offline_access",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "opencode",
    })
    return {
      authorizationUrl: `${OPENAI_CODEX_ISSUER}/oauth/authorize?${params.toString()}`,
      state,
      redirectUri: OPENAI_CODEX_OAUTH_REDIRECT_URI,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  close(): void {
    if (!this.server) {
      return
    }
    this.server.close()
    this.server = undefined
  }

  private async ensureServer(): Promise<void> {
    if (this.server?.listening) {
      return
    }
    const server = createServer((request, response) => {
      void this.handleCallbackRequest(request, response).catch((error) => {
        response.writeHead(500, { "content-type": "text/html; charset=utf-8" })
        response.end(errorHtml(error instanceof Error ? error.message : String(error)))
      })
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error & { code?: string }) => {
        this.server = undefined
        reject(
          new SocratesError(
            error.code === "EADDRINUSE" ? "openai_chatgpt_oauth_port_in_use" : "openai_chatgpt_oauth_server_failed",
            error.code === "EADDRINUSE"
              ? `ChatGPT Codex auth needs localhost:${OPENAI_CODEX_OAUTH_PORT}, but that port is already in use.`
              : `Could not start ChatGPT Codex auth callback server: ${error.message}`,
            { recoverable: true },
          ),
        )
      }
      server.once("error", onError)
      server.listen(OPENAI_CODEX_OAUTH_PORT, () => {
        server.off("error", onError)
        this.server = server
        resolve()
      })
    })
  }

  private async handleCallbackRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", OPENAI_CODEX_OAUTH_REDIRECT_URI)
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      response.end("Not found")
      return
    }

    const pending = this.pending
    const error = url.searchParams.get("error")
    const errorDescription = url.searchParams.get("error_description")
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")

    if (error) {
      this.pending = undefined
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
      response.end(errorHtml(errorDescription ?? error))
      return
    }
    if (!pending || pending.expiresAt < Date.now() || state !== pending.state) {
      this.pending = undefined
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
      response.end(errorHtml("Authorization state is invalid or expired."))
      return
    }
    if (!code) {
      this.pending = undefined
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
      response.end(errorHtml("Authorization callback was missing a code."))
      return
    }

    this.pending = undefined
    const tokens = await exchangeOpenAiCodexCodeForTokens(code, pending.verifier)
    this.saveTokens(openAiCodexTokensToStored(tokens))
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(successHtml())
    setTimeout(() => this.close(), 1000)
  }
}

export const refreshOpenAiCodexAccessToken = async (refreshToken: string): Promise<OpenAiCodexTokenResponse> => {
  const response = await fetch(`${OPENAI_CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new SocratesError("openai_chatgpt_token_refresh_failed", `OpenAI ChatGPT token refresh failed with HTTP ${response.status}.`, {
      recoverable: true,
    })
  }
  return (await response.json()) as OpenAiCodexTokenResponse
}

export const openAiCodexTokensToStored = (
  tokens: OpenAiCodexTokenResponse,
  previous?: OpenAiCodexStoredTokens,
): OpenAiCodexStoredTokens => {
  const claims = parseJwtClaims(tokens.id_token) ?? parseJwtClaims(tokens.access_token)
  const accountId = extractAccountIdFromClaims(claims) ?? previous?.accountId
  const email = claims?.email ?? previous?.email
  const refresh = tokens.refresh_token ?? previous?.refresh
  if (!refresh) {
    throw new SocratesError("openai_chatgpt_refresh_token_missing", "OpenAI ChatGPT token response did not include a refresh token.", {
      recoverable: true,
    })
  }
  return {
    refresh,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    updatedAt: nowIso(),
  }
}

const exchangeOpenAiCodexCodeForTokens = async (code: string, verifier: string): Promise<OpenAiCodexTokenResponse> => {
  const response = await fetch(`${OPENAI_CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OPENAI_CODEX_OAUTH_REDIRECT_URI,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new SocratesError("openai_chatgpt_token_exchange_failed", `OpenAI ChatGPT token exchange failed with HTTP ${response.status}.`, {
      recoverable: true,
    })
  }
  return (await response.json()) as OpenAiCodexTokenResponse
}

const generatePkce = (): PkceCodes => {
  const verifier = randomPkceVerifier()
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

const randomPkceVerifier = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  return [...randomBytes(43)].map((byte) => chars.charAt(byte % chars.length)).join("")
}

const parseJwtClaims = (token: string | undefined): JwtClaims | undefined => {
  if (!token) {
    return undefined
  }
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) {
    return undefined
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims
  } catch {
    return undefined
  }
}

const extractAccountIdFromClaims = (claims: JwtClaims | undefined): string | undefined =>
  claims?.chatgpt_account_id ??
  claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
  claims?.organizations?.find((organization) => organization.id)?.id

const randomBase64Url = (bytes: number): string => randomBytes(bytes).toString("base64url")

const successHtml = (): string => `<!doctype html>
<html><head><title>Socrates</title></head><body><main style="font-family: system-ui, sans-serif; padding: 32px;"><h1>ChatGPT Codex connected</h1><p>You can close this window and return to Socrates.</p></main><script>setTimeout(() => window.close(), 1200)</script></body></html>`

const errorHtml = (message: string): string => `<!doctype html>
<html><head><title>Socrates</title></head><body><main style="font-family: system-ui, sans-serif; padding: 32px;"><h1>Authorization failed</h1><p>${htmlEscape(message)}</p></main></body></html>`

const htmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
