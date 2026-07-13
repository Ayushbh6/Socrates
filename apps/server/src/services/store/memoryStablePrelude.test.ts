import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openDatabase, runMigrations } from "../../db/client"
import { MemoryStore } from "./memoryStore"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("stable prelude snapshot cache", () => {
  it("hits by stat, preserves the snapshot across same-content rewrites, and rebuilds only when the content hash changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-stable-prelude-"))
    tempRoots.push(root)
    const workspacePath = path.join(root, "workspace")
    const socratesHome = path.join(root, "home")
    fs.mkdirSync(workspacePath, { recursive: true })
    const handle = openDatabase(path.join(root, "test.sqlite"))
    runMigrations(handle)
    const memory = new MemoryStore({ handle, appendEvent: () => undefined }, { socratesHome })
    memory.ensureProjectMemory("proj_cache", workspacePath)

    const first = memory.loadStableCachePreludeSnapshot("proj_cache", workspacePath)
    const second = memory.loadStableCachePreludeSnapshot("proj_cache", workspacePath)
    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(second).toMatchObject({
      projectRules: first.projectRules,
      globalRules: first.globalRules,
      identitySections: first.identitySections,
    })

    const identityPath = path.join(socratesHome, "identity.md")
    const unchanged = fs.readFileSync(identityPath, "utf8")
    const originalIdentityStat = fs.statSync(identityPath)
    fs.writeFileSync(identityPath, unchanged)
    const future = new Date(Date.now() + 2_000)
    fs.utimesSync(identityPath, future, future)
    const sameContentRewrite = memory.loadStableCachePreludeSnapshot("proj_cache", workspacePath)
    expect(sameContentRewrite.cacheHit).toBe(true)
    expect(sameContentRewrite.identitySections).toEqual(first.identitySections)

    const profilePath = path.join(socratesHome, "user_profile.md")
    const profile = fs.readFileSync(profilePath, "utf8")
    fs.writeFileSync(profilePath, profile.replace("No durable personal interests captured yet.", "A non-standing profile fact changed."))
    const unrelatedSectionChange = memory.loadStableCachePreludeSnapshot("proj_cache", workspacePath)
    expect(unrelatedSectionChange.cacheHit).toBe(true)
    expect(unrelatedSectionChange.globalRules).toBe(first.globalRules)

    const changedIdentity = unchanged.replace("local-first", "cache-aware")
    expect(changedIdentity.length).toBe(unchanged.length)
    fs.writeFileSync(identityPath, changedIdentity)
    fs.utimesSync(identityPath, originalIdentityStat.atime, originalIdentityStat.mtime)
    const changed = memory.loadStableCachePreludeSnapshot("proj_cache", workspacePath)
    expect(changed.cacheHit).toBe(false)
    expect(changed.identitySections.core_identity).toContain("cache-aware")
    expect(memory.loadStableCachePreludeSnapshot("proj_cache", workspacePath).cacheHit).toBe(true)
    handle.close()
  })

  it("keeps the backend cache bounded and evicts the least recently used snapshot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-stable-prelude-lru-"))
    tempRoots.push(root)
    const handle = openDatabase(path.join(root, "test.sqlite"))
    runMigrations(handle)
    const memory = new MemoryStore({ handle, appendEvent: () => undefined }, { socratesHome: path.join(root, "home") })
    type CacheEntry = {
      statSignature: string
      fullContentSignature: string
      standingContentSignature: string
      snapshot: {
        projectRules: string
        globalRules: string
        identitySections: Record<string, string>
        cacheHit: boolean
      }
    }
    const cache = memory as unknown as {
      cacheStablePrelude: (key: string, entry: CacheEntry) => void
      stablePreludeCache: Map<string, CacheEntry>
    }

    for (let index = 0; index <= 100; index += 1) {
      cache.cacheStablePrelude(`cache-${index}`, {
        statSignature: `stat-${index}`,
        fullContentSignature: `full-${index}`,
        standingContentSignature: `standing-${index}`,
        snapshot: {
          projectRules: `project-${index}`,
          globalRules: "global",
          identitySections: {},
          cacheHit: false,
        },
      })
    }

    expect(cache.stablePreludeCache.size).toBe(100)
    expect(cache.stablePreludeCache.has("cache-0")).toBe(false)
    expect(cache.stablePreludeCache.has("cache-100")).toBe(true)
    handle.close()
  })
})
