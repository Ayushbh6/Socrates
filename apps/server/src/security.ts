import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** The version's session cookie. Browser cookies are shared across ports on the same host. */
export const SESSION_COOKIE = "socrates_v2_session";

/** A fresh secret per launch. The printed link carries it once; the browser keeps it as a cookie. */
export function sessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sameSecret(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** The session from the cookie, or a bearer header for scripts. */
export function authorized(request: FastifyRequest, token: string): boolean {
  const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  return sameSecret(cookie(request, SESSION_COOKIE), token) || sameSecret(bearer, token);
}

/**
 * Every request (architecture/server.md, "Security"): the Host must be this
 * server's own address, so a site cannot reach it through a rebound domain;
 * a browser Origin must be this server, so another tab cannot drive it; and
 * everything but /api/health and the /auth link needs the session.
 */
export function guard(port: number, token: string) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origins = hosts.map((h) => `http://${h}`);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hosts.includes(request.headers.host ?? "")) return reply.code(403).send(problem("forbidden_host", "Open Socrates at 127.0.0.1 or localhost."));
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.includes(origin)) return reply.code(403).send(problem("forbidden_origin", "Requests from other sites are refused."));
    if (request.headers["sec-fetch-site"] === "cross-site") return reply.code(403).send(problem("forbidden_origin", "Requests from other sites are refused."));
    const route = request.url.split("?")[0];
    if (route === "/api/health" || route === "/auth") return;
    if (!authorized(request, token)) return reply.code(401).send(problem("unauthorized", "Open Socrates from the link it printed when it started."));
  };
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function problem(code: string, message: string) {
  return { error: { code, message } };
}
