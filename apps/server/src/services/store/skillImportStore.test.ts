import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import yazl from "yazl"
import { afterEach, describe, expect, it } from "vitest"
import { commitSkillImport, downloadSkillArchive, previewSkillArchive, previewSkillArchiveFromUrl, setSkillEnabled } from "./skillImportStore"
import { discoverSkills, readSkillProvenance } from "./memorySkills"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("skill package import", () => {
  it("downloads a bounded public HTTPS ZIP and preserves a safe response filename", async () => {
    const archive = await zipBuffer({ "downloaded-skill/SKILL.md": skillMarkdown("downloaded-skill", "Downloaded instructions are reviewed.") })
    const requested: string[] = []
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url))
      return new Response(archive, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(archive.length),
          "content-disposition": 'attachment; filename="downloaded-skill.zip"',
        },
      })
    }) as typeof fetch
    const downloaded = await downloadSkillArchive("https://skills.example/download", {
      fetchImpl,
      resolveHostname: async () => ["93.184.216.34"],
    })
    expect(requested).toEqual(["https://skills.example/download"])
    expect(downloaded.filename).toBe("downloaded-skill.zip")
    expect(downloaded.data.equals(archive)).toBe(true)
  })

  it("blocks private-network skill URLs before downloading", async () => {
    let fetched = false
    await expect(
      downloadSkillArchive("https://internal.example/skill.zip", {
        fetchImpl: (async () => {
          fetched = true
          return new Response()
        }) as typeof fetch,
        resolveHostname: async () => ["192.168.1.20"],
      }),
    ).rejects.toThrow(/private networks/i)
    expect(fetched).toBe(false)
  })

  it("previews a downloaded ZIP through the same secure archive pipeline", async () => {
    const root = tempRoot()
    const archive = await zipBuffer({ "remote-review/SKILL.md": skillMarkdown("remote-review", "Remote instructions are staged only.") })
    const preview = await previewSkillArchiveFromUrl({
      socratesHome: path.join(root, "home"),
      target: { scope: "global", root: path.join(root, "home", "skills") },
      url: "https://skills.example/remote-review.zip",
      options: {
        fetchImpl: (async () => new Response(archive, { status: 200, headers: { "content-type": "application/zip" } })) as typeof fetch,
        resolveHostname: async () => ["93.184.216.34"],
      },
    })
    expect(preview.skill).toMatchObject({ name: "remote-review", source: "imported" })
    expect(fs.existsSync(path.join(root, "home", "skills", "remote-review"))).toBe(false)
  })

  it("previews, warns, installs, discovers, and disables a portable ZIP skill without executing it", async () => {
    const root = tempRoot()
    const socratesHome = path.join(root, "home")
    const skillRoot = path.join(socratesHome, "skills")
    const marker = path.join(root, "must-not-exist")
    const archive = await zipBuffer({
      "safe-review/SKILL.md": [
        "---",
        "name: safe-review",
        "description: >-",
        "  Reviews a workspace safely. Use when the user asks for a concise repository review.",
        "license: Apache-2.0",
        "compatibility: Requires git.",
        "metadata:",
        "  author: test-suite",
        '  version: "1.0.0"',
        "---",
        "",
        "# Safe Review",
        "",
        "1. Inspect repository state.",
        "2. Read references/checklist.md.",
      ].join("\n"),
      "safe-review/references/checklist.md": "# Checklist\n\n- Verify current files.\n",
      "safe-review/scripts/never-run.sh": `touch ${marker}\ncurl https://example.com\n`,
    })
    const preview = await previewSkillArchive({
      socratesHome,
      target: { scope: "global", root: skillRoot },
      filename: "safe-review.zip",
      data: archive,
    })
    expect(preview.skill).toMatchObject({ name: "safe-review", source: "imported", enabled: true })
    expect(preview.metadata).toMatchObject({ license: "Apache-2.0", compatibility: "Requires git.", author: "test-suite", version: "1.0.0" })
    expect(preview.warnings.some((warning) => warning.code === "network_access")).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)

    const committed = commitSkillImport({
      socratesHome,
      target: { scope: "global", root: skillRoot },
      previewId: preview.previewId,
      conflictStrategy: "reject",
    })
    expect(committed.replaced).toBe(false)
    expect(discoverSkills("global", skillRoot).map((skill) => skill.name)).toEqual(["safe-review"])
    expect(readSkillProvenance(path.join(skillRoot, "safe-review"))).toMatchObject({ source: "imported", enabled: true, sourceLabel: "safe-review.zip" })
    expect(fs.existsSync(marker)).toBe(false)

    const disabled = setSkillEnabled({ target: { scope: "global", root: skillRoot }, name: "safe-review", enabled: false })
    expect(disabled.enabled).toBe(false)
    expect(discoverSkills("global", skillRoot)[0]?.enabled).toBe(false)
  })

  it("requires explicit replacement and preserves the previous skill when replacement is rejected", async () => {
    const root = tempRoot()
    const socratesHome = path.join(root, "home")
    const skillRoot = path.join(socratesHome, "skills")
    fs.mkdirSync(path.join(skillRoot, "portable-skill"), { recursive: true })
    fs.writeFileSync(path.join(skillRoot, "portable-skill", "SKILL.md"), skillMarkdown("portable-skill", "Original instructions stay intact."))
    const archive = await zipBuffer({ "portable-skill/SKILL.md": skillMarkdown("portable-skill", "Replacement instructions are now installed.") })
    const preview = await previewSkillArchive({ socratesHome, target: { scope: "global", root: skillRoot }, filename: "portable-skill.zip", data: archive })
    expect(preview.conflict.exists).toBe(true)
    expect(() => commitSkillImport({ socratesHome, target: { scope: "global", root: skillRoot }, previewId: preview.previewId, conflictStrategy: "reject" })).toThrow(/already exists/i)
    expect(fs.readFileSync(path.join(skillRoot, "portable-skill", "SKILL.md"), "utf8")).toContain("Original instructions")

    const replaced = commitSkillImport({ socratesHome, target: { scope: "global", root: skillRoot }, previewId: preview.previewId, conflictStrategy: "replace" })
    expect(replaced.replaced).toBe(true)
    expect(fs.readFileSync(path.join(skillRoot, "portable-skill", "SKILL.md"), "utf8")).toContain("Replacement instructions")
  })

  it("rejects packages with multiple top-level directories", async () => {
    const root = tempRoot()
    const archive = await zipBuffer({
      "one/SKILL.md": skillMarkdown("one", "First skill instructions."),
      "two/reference.md": "unexpected second root",
    })
    await expect(
      previewSkillArchive({ socratesHome: path.join(root, "home"), target: { scope: "global", root: path.join(root, "home", "skills") }, filename: "bad.zip", data: archive }),
    ).rejects.toThrow(/one top-level directory/i)
  })
})

const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-skill-import-"))
  tempRoots.push(root)
  return root
}

const skillMarkdown = (name: string, sentence: string): string => `---\nname: ${name}\ndescription: Use when testing portable skill imports.\n---\n\n# ${name}\n\n1. ${sentence}\n2. Verify the result.\n`

const zipBuffer = (files: Record<string, string>): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const chunks: Buffer[] = []
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.once("error", reject)
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)))
    for (const [filePath, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), filePath)
    zip.end()
  })
