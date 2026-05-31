import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { SocratesError } from "@socrates/shared"
import {
  copyStoredResourceFile,
  __editToolTest,
  ensureWorkspaceScaffold,
  deleteStoredResourceFile,
  applyPatchWorkspace,
  editWorkspace,
  FileFreshnessTracker,
  inferResourceMimeType,
  inferResourceKind,
  inspectWorkspacePath,
  inspectPythonEnvironment,
  listStoredResourceFiles,
  pickWorkspaceFolder,
  readWorkspacePath,
  runWorkspaceBash,
  searchWorkspace,
  createWorkspaceShellSession,
  storeResourceFile,
  type CommandRunner,
} from "./index"
import { __bashToolTest } from "./tools/bashTool"

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "socrates-workspace-test-"))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const nodeCommand = (script: string): string =>
  process.platform === "win32"
    ? `& ${psQuote(process.execPath)} -e ${psQuote(script)}`
    : `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`

const readFreshFiles = async (workspacePath: string, ...paths: string[]): Promise<FileFreshnessTracker> => {
  const tracker = new FileFreshnessTracker()
  for (const filePath of paths) {
    await readWorkspacePath({ path: filePath }, { workspacePath, fileFreshness: tracker })
  }
  return tracker
}

describe("workspace scaffold", () => {
  it("creates .socrates/resources for a start-from-scratch workspace", () => {
    const workspacePath = path.join(tempDir(), "New Project")
    const scaffold = ensureWorkspaceScaffold({ workspacePath, mode: "start_from_scratch" })

    expect(scaffold.workspacePath).toBe(workspacePath)
    expect(fs.statSync(path.join(workspacePath, ".socrates")).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(workspacePath, ".socrates", "resources")).isDirectory()).toBe(true)
  })

  it("inspects workspace scaffold state without creating files", () => {
    const workspacePath = tempDir()

    const before = inspectWorkspacePath({ workspacePath })
    expect(before.exists).toBe(true)
    expect(before.isDirectory).toBe(true)
    expect(before.hasSocratesDir).toBe(false)
    expect(before.hasResourcesDir).toBe(false)
    expect(fs.existsSync(path.join(workspacePath, ".socrates"))).toBe(false)

    fs.mkdirSync(path.join(workspacePath, ".socrates"))
    const after = inspectWorkspacePath({ workspacePath })
    expect(after.hasSocratesDir).toBe(true)
    expect(after.hasResourcesDir).toBe(false)
  })

  it("requires explicit scaffold action when an existing .socrates folder is protected", () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, ".socrates"))

    expect(() =>
      ensureWorkspaceScaffold({
        workspacePath,
        mode: "existing_folder",
        requireActionForExistingSocrates: true,
      }),
    ).toThrow(SocratesError)
  })

  it("uses existing .socrates content when requested", () => {
    const workspacePath = tempDir()
    const markerPath = path.join(workspacePath, ".socrates", "keep.txt")
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, "keep")

    ensureWorkspaceScaffold({
      workspacePath,
      mode: "existing_folder",
      scaffoldAction: "use_existing",
      requireActionForExistingSocrates: true,
    })

    expect(fs.readFileSync(markerPath, "utf8")).toBe("keep")
    expect(fs.statSync(path.join(workspacePath, ".socrates", "resources")).isDirectory()).toBe(true)
  })

  it("resets only the selected workspace .socrates folder when requested", () => {
    const workspacePath = tempDir()
    const otherWorkspacePath = tempDir()
    const oldMarkerPath = path.join(workspacePath, ".socrates", "old.txt")
    const otherMarkerPath = path.join(otherWorkspacePath, ".socrates", "old.txt")
    fs.mkdirSync(path.dirname(oldMarkerPath), { recursive: true })
    fs.mkdirSync(path.dirname(otherMarkerPath), { recursive: true })
    fs.writeFileSync(oldMarkerPath, "old")
    fs.writeFileSync(otherMarkerPath, "other")

    ensureWorkspaceScaffold({
      workspacePath,
      mode: "existing_folder",
      scaffoldAction: "reset",
      requireActionForExistingSocrates: true,
    })

    expect(fs.existsSync(oldMarkerPath)).toBe(false)
    expect(fs.statSync(path.join(workspacePath, ".socrates", "resources")).isDirectory()).toBe(true)
    expect(fs.readFileSync(otherMarkerPath, "utf8")).toBe("other")
  })

  it("rejects relative workspace paths", () => {
    expect(() => ensureWorkspaceScaffold({ workspacePath: "relative/project", mode: "existing_folder" })).toThrow(
      SocratesError,
    )
  })

  it("rejects files as workspace paths", () => {
    const dir = tempDir()
    const filePath = path.join(dir, "not-a-folder.txt")
    fs.writeFileSync(filePath, "nope")

    expect(() => ensureWorkspaceScaffold({ workspacePath: filePath, mode: "existing_folder" })).toThrow(SocratesError)
  })
})

describe("resource files", () => {
  it("stores resource files under .socrates/resources with safe names", () => {
    const workspacePath = tempDir()
    ensureWorkspaceScaffold({ workspacePath, mode: "existing_folder" })

    const stored = storeResourceFile({
      workspacePath,
      originalName: "My Draft?.md",
      data: Buffer.from("hello"),
    })

    expect(stored.fileName).toBe("My_Draft_.md")
    expect(stored.path).toBe(path.join(workspacePath, ".socrates", "resources", "My_Draft_.md"))
    expect(fs.readFileSync(stored.path, "utf8")).toBe("hello")
  })

  it("copies stored resource files into a target workspace without overwriting", () => {
    const sourcePath = path.join(tempDir(), "notes.txt")
    const targetWorkspacePath = tempDir()
    fs.writeFileSync(sourcePath, "one")
    ensureWorkspaceScaffold({ workspacePath: targetWorkspacePath, mode: "existing_folder" })
    fs.writeFileSync(path.join(targetWorkspacePath, ".socrates", "resources", "notes.txt"), "existing")

    const copied = copyStoredResourceFile({ sourcePath, targetWorkspacePath })

    expect(copied.fileName).toBe("notes-2.txt")
    expect(fs.readFileSync(copied.path, "utf8")).toBe("one")
  })

  it("avoids overwriting duplicate resource filenames", () => {
    const workspacePath = tempDir()
    const first = storeResourceFile({ workspacePath, originalName: "notes.txt", data: Buffer.from("one") })
    const second = storeResourceFile({ workspacePath, originalName: "notes.txt", data: Buffer.from("two") })

    expect(first.fileName).toBe("notes.txt")
    expect(second.fileName).toBe("notes-2.txt")
    expect(fs.readFileSync(second.path, "utf8")).toBe("two")
  })

  it("lists direct files manually added to .socrates/resources", () => {
    const workspacePath = tempDir()
    ensureWorkspaceScaffold({ workspacePath, mode: "existing_folder" })
    const resourcesPath = path.join(workspacePath, ".socrates", "resources")
    fs.writeFileSync(path.join(resourcesPath, "Brief.pdf"), "pdf")
    fs.writeFileSync(path.join(resourcesPath, ".DS_Store"), "noise")
    fs.mkdirSync(path.join(resourcesPath, "Nested"))
    fs.writeFileSync(path.join(resourcesPath, "Nested", "Hidden.md"), "nested")

    expect(listStoredResourceFiles(workspacePath)).toEqual([
      {
        path: path.join(resourcesPath, "Brief.pdf"),
        fileName: "Brief.pdf",
        sizeBytes: 3,
        mimeType: "application/pdf",
      },
    ])
  })

  it("deletes only resource files owned by the workspace scaffold", () => {
    const workspacePath = tempDir()
    const stored = storeResourceFile({ workspacePath, originalName: "owned.txt", data: Buffer.from("owned") })
    const externalPath = path.join(tempDir(), "external.txt")
    fs.writeFileSync(externalPath, "external")

    expect(deleteStoredResourceFile({ workspacePath, resourcePath: externalPath })).toEqual({
      deleted: false,
      skippedReason: "outside_resources",
    })
    expect(fs.readFileSync(externalPath, "utf8")).toBe("external")

    expect(deleteStoredResourceFile({ workspacePath, resourcePath: stored.path })).toEqual({ deleted: true })
    expect(fs.existsSync(stored.path)).toBe(false)
  })

  it("infers resource kinds from filenames", () => {
    expect(inferResourceKind("paper.pdf")).toBe("pdf")
    expect(inferResourceKind("photo.png")).toBe("image")
    expect(inferResourceKind("README.md")).toBe("text")
    expect(inferResourceKind("draft.docx")).toBe("document")
    expect(inferResourceKind("archive.zip")).toBe("local_file")
  })

  it("infers common resource MIME types from filenames", () => {
    expect(inferResourceMimeType("paper.pdf")).toBe("application/pdf")
    expect(inferResourceMimeType("photo.png")).toBe("image/png")
    expect(inferResourceMimeType("README.md")).toBe("text/markdown")
    expect(inferResourceMimeType("draft.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(inferResourceMimeType("archive.zip")).toBe("application/octet-stream")
  })
})

describe("native folder picker adapters", () => {
  it("uses osascript on macOS", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args })
      return { stdout: "/tmp/socrates-picked\n", stderr: "" }
    }

    const picked = await pickWorkspaceFolder(
      { mode: "start_from_scratch" },
      { platform: "darwin", commandRunner: runner },
    )

    expect(calls[0]?.command).toBe("osascript")
    expect(picked).toEqual({ path: "/tmp/socrates-picked", folderName: "socrates-picked" })
  })

  it("uses PowerShell on Windows", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args })
      return { stdout: "C:\\Users\\Ayush\\Project\r\n", stderr: "" }
    }

    const picked = await pickWorkspaceFolder({ mode: "existing_folder" }, { platform: "win32", commandRunner: runner })

    expect(calls[0]?.command).toBe("powershell.exe")
    expect(picked.folderName).toBe("Project")
  })

  it("uses zenity on Linux when available", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args })
      if (command === "sh") {
        return { stdout: "/usr/bin/zenity\n", stderr: "" }
      }
      return { stdout: "/tmp/linux-picked\n", stderr: "" }
    }

    const picked = await pickWorkspaceFolder({ mode: "existing_folder" }, { platform: "linux", commandRunner: runner })

    expect(calls.map((call) => call.command)).toEqual(["sh", "zenity"])
    expect(picked.path).toBe("/tmp/linux-picked")
  })
})

describe("workspace tools", () => {
  it("reads files with truncation and rejects path escapes", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "notes.txt"), "abcdefghijklmnopqrstuvwxyz")

    const result = await readWorkspacePath({ path: "notes.txt", charLimit: 5 }, { workspacePath })

    expect(result.content).toBe("abcde")
    expect(result.truncation.truncated).toBe(true)
    await expect(readWorkspacePath({ path: "../outside.txt" }, { workspacePath })).rejects.toThrow(SocratesError)
  })

  it("warns when reading images with a non-vision model", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await readWorkspacePath(
      { path: "screenshot.png" },
      { workspacePath, runtimeConfig: { providerId: "openrouter", modelId: "deepseek/deepseek-v4-pro" } },
    )

    expect(result.kind).toBe("image")
    expect(result.image?.nativeVisionSupported).toBe(false)
    expect(result.warnings?.[0]).toContain("does not support native vision")
  })

  it("treats MiMo Pro as vision-capable when reading images", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await readWorkspacePath(
      { path: "screenshot.png" },
      { workspacePath, runtimeConfig: { providerId: "openrouter", modelId: "xiaomi/mimo-v2.5-pro" } },
    )

    expect(result.kind).toBe("image")
    expect(result.image?.nativeVisionSupported).toBe(true)
    expect(result.warnings).toBeUndefined()
  })

  it("allows reading PROJECT_NOTES.md but rejects generic edits to it", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, ".socrates"), { recursive: true })
    fs.writeFileSync(path.join(workspacePath, ".socrates", "PROJECT_NOTES.md"), "old note\n")

    const read = await readWorkspacePath({ path: ".socrates/PROJECT_NOTES.md" }, { workspacePath })

    expect(read.content).toBe("old note\n")
    await expect(
      editWorkspace({ path: ".socrates/PROJECT_NOTES.md", oldString: "old", newString: "new" }, { workspacePath }),
    ).rejects.toMatchObject({
      code: "project_notes_dedicated_tool_required",
      message: expect.stringContaining("project_notes"),
      recoverable: true,
    })
    await expect(
      editWorkspace({ path: ".socrates/PROJECT_NOTES.md", content: "new note\n", overwrite: true }, { workspacePath }),
    ).rejects.toMatchObject({
      code: "project_notes_dedicated_tool_required",
      message: expect.stringContaining("PROJECT_NOTES.md can only be edited through the project_notes tool"),
    })
    expect(fs.readFileSync(path.join(workspacePath, ".socrates", "PROJECT_NOTES.md"), "utf8")).toBe("old note\n")
  })

  it("rejects generic creation of PROJECT_NOTES.md through edit", async () => {
    const workspacePath = tempDir()

    await expect(editWorkspace({ path: ".socrates/PROJECT_NOTES.md", content: "new note\n" }, { workspacePath })).rejects.toMatchObject({
      code: "project_notes_dedicated_tool_required",
      recoverable: true,
    })
    expect(fs.existsSync(path.join(workspacePath, ".socrates", "PROJECT_NOTES.md"))).toBe(false)
  })

  it("searches files and text inside the workspace", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "src"))
    fs.writeFileSync(path.join(workspacePath, "src", "agent.ts"), "export const Socrates = true\n")

    const files = await searchWorkspace({ mode: "files", query: "agent" }, { workspacePath })
    const text = await searchWorkspace({ mode: "text", query: "Socrates", path: "src" }, { workspacePath })

    expect(files.matches[0]?.path).toBe("src/agent.ts")
    expect(text.matches[0]?.line).toBe(1)
  })

  it("auto-detects regex-looking text searches and warns on literal regex syntax", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "src"))
    fs.writeFileSync(path.join(workspacePath, "src", "traceRetrieveTool.ts"), "export const trace_retrieve = true\n")

    const regexLike = await searchWorkspace({ mode: "text", query: "trace_retrieve|traceRetrieve", path: "src" }, { workspacePath })
    const literal = await searchWorkspace({ mode: "text", query: "trace_retrieve|traceRetrieve", path: "src", regex: false }, { workspacePath })

    expect(regexLike.totalMatches).toBe(1)
    expect(regexLike.matches[0]?.path).toBe("src/traceRetrieveTool.ts")
    expect(regexLike.warnings?.some((warning) => warning.includes("interpreted it as regex"))).toBe(true)
    expect(literal.totalMatches).toBe(0)
    expect(literal.warnings?.some((warning) => warning.includes("set regex=true"))).toBe(true)
  })

  it("matches file globs case-insensitively against relative paths and basenames", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "packages", "core", "src", "tools"), { recursive: true })
    fs.writeFileSync(path.join(workspacePath, "packages", "core", "src", "tools", "traceRetrieveTool.ts"), "export {}\n")

    const basenameMatch = await searchWorkspace({ mode: "files", query: "*retriev*", path: "packages/core" }, { workspacePath })
    const pathMatch = await searchWorkspace({ mode: "files", query: "*SRC/TOOLS/TRACERETRIEVE*", path: "packages/core" }, { workspacePath })

    expect(basenameMatch.matches.map((match) => match.path)).toContain("packages/core/src/tools/traceRetrieveTool.ts")
    expect(pathMatch.matches.map((match) => match.path)).toContain("packages/core/src/tools/traceRetrieveTool.ts")
  })

  it("caps noisy search results and warns when capped", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true })
    for (let index = 0; index < 60; index += 1) {
      fs.writeFileSync(path.join(workspacePath, "src", `agent-${index}.ts`), "export const marker = 'Socrates'\n")
    }

    const defaultCapped = await searchWorkspace({ mode: "files", query: "agent" }, { workspacePath })
    const hardCapped = await searchWorkspace({ mode: "text", query: "Socrates", maxResults: 50 }, { workspacePath })

    expect(defaultCapped.matches).toHaveLength(20)
    expect(defaultCapped.totalMatches).toBe(60)
    expect(defaultCapped.warnings?.some((warning) => warning.includes("capped at 20"))).toBe(true)
    expect(hardCapped.matches).toHaveLength(50)
    expect(hardCapped.warnings?.some((warning) => warning.includes("capped at 50"))).toBe(true)
  })

  it("skips generated and vendor directories in rg-backed searches", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true })
    fs.mkdirSync(path.join(workspacePath, "node_modules", "noisy"), { recursive: true })
    fs.writeFileSync(path.join(workspacePath, "src", "package.json"), "{}\n")
    fs.writeFileSync(path.join(workspacePath, "node_modules", "noisy", "package.json"), "{}\n")

    const files = await searchWorkspace({ mode: "files", query: "package.json" }, { workspacePath })
    const text = await searchWorkspace({ mode: "text", query: "{}" }, { workspacePath })

    expect(files.matches.map((match) => match.path)).toEqual(["src/package.json"])
    expect(text.matches.map((match) => match.path)).toEqual(["src/package.json"])
    expect(files.warnings?.some((warning) => warning.includes("generated/vendor directories"))).toBe(true)
  })

  it("applies precise replacement edits", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello old world")
    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "README.md" }, { workspacePath, fileFreshness: tracker })

    const result = await editWorkspace({ path: "README.md", oldString: "old", newString: "new" }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe("hello new world")
    expect(result.changedFiles[0]).toMatchObject({ path: "README.md", operation: "edited", verification: "verified" })
  })

  it("returns file freshness metadata when reading files", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello\r\nworld\r\n")

    const result = await readWorkspacePath({ path: "README.md", charLimit: 5 }, { workspacePath })

    expect(result.content).toBe("hello")
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.sizeBytes).toBe(Buffer.byteLength("hello\r\nworld\r\n"))
    expect(result.mtimeMs).toBeGreaterThan(0)
    expect(result.lineEnding).toBe("crlf")
  })

  it("rejects existing-file content writes unless overwrite is explicit", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello old world")
    const tracker = new FileFreshnessTracker()

    await expect(editWorkspace({ path: "README.md", content: "hello new world" }, { workspacePath })).rejects.toMatchObject({
      code: "edit_use_targeted_replace",
    })
    await expect(editWorkspace({ path: "README.md", content: "hello new world" }, { workspacePath, fileFreshness: tracker })).rejects.toMatchObject({
      code: "edit_use_targeted_replace",
    })

    const read = await readWorkspacePath({ path: "README.md" }, { workspacePath, fileFreshness: tracker })
    await expect(editWorkspace({ path: "README.md", content: "hello new world" }, { workspacePath, fileFreshness: tracker })).rejects.toMatchObject({
      code: "edit_use_targeted_replace",
    })
    const result = await editWorkspace({ path: "README.md", content: "hello new world", overwrite: true }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe("hello new world")
    expect(result.changedFiles[0]).toMatchObject({
      path: "README.md",
      operation: "overwritten",
      verification: "verified",
      contentHashBefore: read.contentHash,
      sizeBytesAfter: Buffer.byteLength("hello new world"),
    })
    expect(result.changedFiles[0]?.contentHashAfter).toMatch(/^[a-f0-9]{64}$/)
  })

  it("still requires freshness before explicit existing-file overwrite", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello old world")

    await expect(editWorkspace({ path: "README.md", content: "hello new world", overwrite: true }, { workspacePath })).rejects.toMatchObject({
      code: "edit_stale_content",
    })
  })

  it("creates new files with content without a prior read", async () => {
    const workspacePath = tempDir()

    const result = await editWorkspace({ path: "README.md", content: "hello new world" }, { workspacePath })

    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe("hello new world")
    expect(result.changedFiles[0]).toMatchObject({
      path: "README.md",
      operation: "created",
      verification: "verified",
    })
  })

  it("fails loudly when disk verification does not match the planned edit", async () => {
    const workspacePath = tempDir()
    const target = path.join(workspacePath, "README.md")
    fs.writeFileSync(target, "hello old world")

    __editToolTest.setAfterWriteHook((filePath) => {
      if (filePath === target) {
        fs.writeFileSync(filePath, "external rewrite")
      }
    })
    try {
      const tracker = new FileFreshnessTracker()
      await readWorkspacePath({ path: "README.md" }, { workspacePath, fileFreshness: tracker })
      await expect(
        editWorkspace({ path: "README.md", oldString: "old", newString: "new" }, { workspacePath, fileFreshness: tracker }),
      ).rejects.toMatchObject({ code: "edit_verification_failed" })
    } finally {
      __editToolTest.setAfterWriteHook(undefined)
    }
  })

  it("normalizes Windows-style backslash paths inside the workspace", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "src"))
    fs.writeFileSync(path.join(workspacePath, "src", "main.py"), "print('old')\n")

    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "src/main.py" }, { workspacePath, fileFreshness: tracker })
    const result = await editWorkspace({ path: "src\\main.py", oldString: "old", newString: "new" }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "src", "main.py"), "utf8")).toBe("print('new')\n")
    expect(result.changedFiles[0]?.path).toBe(path.join("src", "main.py"))
  })

  it("preserves CRLF content when applying exact replacements", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "server.py"), "alpha\r\nbeta\r\ngamma\r\n")

    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "server.py" }, { workspacePath, fileFreshness: tracker })
    await editWorkspace({ path: "server.py", oldString: "beta", newString: "beta = 42" }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "server.py"), "utf8")).toBe("alpha\r\nbeta = 42\r\ngamma\r\n")
  })

  it("replaces every occurrence when replaceAll is set", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "config.py"), "x = 1\ny = 1\nz = 1\n")
    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "config.py" }, { workspacePath, fileFreshness: tracker })

    const result = await editWorkspace(
      { path: "config.py", oldString: "= 1", newString: "= 2", replaceAll: true },
      { workspacePath, fileFreshness: tracker },
    )

    expect(fs.readFileSync(path.join(workspacePath, "config.py"), "utf8")).toBe("x = 2\ny = 2\nz = 2\n")
    expect(result.changedFiles[0]).toMatchObject({ path: "config.py", operation: "edited", verification: "verified" })
  })

  it("rejects ambiguous replacements when replaceAll is not set", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "config.py"), "x = 1\ny = 1\n")
    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "config.py" }, { workspacePath, fileFreshness: tracker })

    await expect(
      editWorkspace({ path: "config.py", oldString: "= 1", newString: "= 2" }, { workspacePath, fileFreshness: tracker }),
    ).rejects.toMatchObject({ code: "replace_occurrence_mismatch" })
    expect(fs.readFileSync(path.join(workspacePath, "config.py"), "utf8")).toBe("x = 1\ny = 1\n")
  })

  it("applies and verifies unified diff patches", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello old world\n")
    const patch = ["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-hello old world", "+hello new world", ""].join("\n")

    const tracker = new FileFreshnessTracker()
    const read = await readWorkspacePath({ path: "README.md" }, { workspacePath, fileFreshness: tracker })
    const result = await applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe("hello new world\n")
    expect(result.changedFiles[0]).toMatchObject({
      path: "README.md",
      operation: "patched",
      verification: "verified",
      contentHashBefore: read.contentHash,
    })
    expect(result.changedFiles[0]?.contentHashAfter).toMatch(/^[a-f0-9]{64}$/)
  })

  it("applies and verifies new-file patches", async () => {
    const workspacePath = tempDir()
    const patch = ["--- /dev/null", "+++ b/new-file.txt", "@@ -0,0 +1 @@", "+created", ""].join("\n")

    const result = await applyPatchWorkspace({ patch }, { workspacePath })

    expect(fs.readFileSync(path.join(workspacePath, "new-file.txt"), "utf8")).toBe("created\n")
    expect(result.changedFiles[0]).toMatchObject({
      path: "new-file.txt",
      operation: "created",
      verification: "verified",
    })
    expect(result.changedFiles[0]?.contentHashAfter).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    [
      "create",
      ["*** Begin Patch", "*** Add File: .socrates/PROJECT_NOTES.md", "+new note", "*** End Patch", ""].join("\n"),
    ],
    [
      "update",
      ["*** Begin Patch", "*** Update File: .socrates/PROJECT_NOTES.md", "@@", "-old note", "+new note", "*** End Patch", ""].join("\n"),
    ],
    ["delete", ["*** Begin Patch", "*** Delete File: .socrates/PROJECT_NOTES.md", "*** End Patch", ""].join("\n")],
    [
      "rename from",
      [
        "*** Begin Patch",
        "*** Update File: .socrates/PROJECT_NOTES.md",
        "*** Move to: notes-copy.md",
        "*** End Patch",
        "",
      ].join("\n"),
    ],
    [
      "rename to",
      [
        "*** Begin Patch",
        "*** Update File: notes-copy.md",
        "*** Move to: .socrates/PROJECT_NOTES.md",
        "*** End Patch",
        "",
      ].join("\n"),
    ],
  ])("rejects apply_patch %s operations involving PROJECT_NOTES.md", async (_caseName, patch) => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, ".socrates"), { recursive: true })
    fs.writeFileSync(path.join(workspacePath, ".socrates", "PROJECT_NOTES.md"), "old note\n")
    fs.writeFileSync(path.join(workspacePath, "notes-copy.md"), "copy note\n")

    await expect(applyPatchWorkspace({ patch }, { workspacePath })).rejects.toMatchObject({
      code: "project_notes_dedicated_tool_required",
      message: expect.stringContaining("project_notes"),
      recoverable: true,
    })
    expect(fs.readFileSync(path.join(workspacePath, ".socrates", "PROJECT_NOTES.md"), "utf8")).toBe("old note\n")
  })

  it("applies and verifies delete patches", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "remove-me.txt"), "delete me\n")
    const tracker = new FileFreshnessTracker()
    const read = await readWorkspacePath({ path: "remove-me.txt" }, { workspacePath, fileFreshness: tracker })
    const patch = ["--- a/remove-me.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-delete me", ""].join("\n")

    const result = await applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.existsSync(path.join(workspacePath, "remove-me.txt"))).toBe(false)
    expect(result.changedFiles[0]).toMatchObject({
      path: "remove-me.txt",
      operation: "deleted",
      verification: "verified",
      contentHashBefore: read.contentHash,
    })
    expect(result.changedFiles[0]?.contentHashAfter).toBeUndefined()
  })

  it("applies and verifies pure rename patches", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "old-name.txt"), "same\n")
    const tracker = await readFreshFiles(workspacePath, "old-name.txt")
    const patch = [
      "diff --git a/old-name.txt b/new-name.txt",
      "similarity index 100%",
      "rename from old-name.txt",
      "rename to new-name.txt",
      "",
    ].join("\n")

    const result = await applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.existsSync(path.join(workspacePath, "old-name.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(workspacePath, "new-name.txt"), "utf8")).toBe("same\n")
    expect(result.changedFiles[0]).toMatchObject({
      path: "new-name.txt",
      previousPath: "old-name.txt",
      operation: "renamed",
      verification: "verified",
    })
    expect(result.changedFiles[0]?.contentHashBefore).toBe(result.changedFiles[0]?.contentHashAfter)
  })

  it("applies and verifies rename patches that also change content", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "old-name.txt"), "old\n")
    const tracker = await readFreshFiles(workspacePath, "old-name.txt")
    const patch = [
      "diff --git a/old-name.txt b/new-name.txt",
      "similarity index 50%",
      "rename from old-name.txt",
      "rename to new-name.txt",
      "--- a/old-name.txt",
      "+++ b/new-name.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n")

    const result = await applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.existsSync(path.join(workspacePath, "old-name.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(workspacePath, "new-name.txt"), "utf8")).toBe("new\n")
    expect(result.changedFiles[0]).toMatchObject({
      path: "new-name.txt",
      previousPath: "old-name.txt",
      operation: "renamed",
      verification: "verified",
    })
    expect(result.changedFiles[0]?.contentHashBefore).not.toBe(result.changedFiles[0]?.contentHashAfter)
  })

  it("rejects malformed unified diff hunk counts with a constructive error before applying", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello\n")
    const patch = [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,2 @@",
      "-hello",
      "+hello",
      "+world",
      "+extra",
      "",
    ].join("\n")

    await expect(applyPatchWorkspace({ patch }, { workspacePath })).rejects.toMatchObject({
      code: "patch_parse_failed",
      message: expect.stringContaining("hunk line counts"),
      details: expect.objectContaining({
        expectedNewLines: 2,
        actualNewLines: 3,
        suggestion: expect.stringContaining("patchText"),
      }),
    })
    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe("hello\n")
  })

  it("returns a constructive context mismatch error for valid unified diffs that do not apply", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "current\n")
    const tracker = await readFreshFiles(workspacePath, "README.md")
    const patch = ["--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-stale", "+next", ""].join("\n")

    await expect(applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })).rejects.toMatchObject({
      code: "patch_apply_failed",
      message: expect.stringContaining("current disk"),
      details: expect.objectContaining({
        path: "README.md",
        suggestion: expect.stringContaining("Re-read"),
      }),
    })
    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe("current\n")
  })

  it("returns a constructive error when a middle structured hunk does not match and leaves disk unchanged", async () => {
    const workspacePath = tempDir()
    const original = "one\ntwo\nthree\nfour\nfive\n"
    fs.writeFileSync(path.join(workspacePath, "app.txt"), original)
    const tracker = await readFreshFiles(workspacePath, "app.txt")
    const patch = [
      "*** Begin Patch",
      "*** Update File: app.txt",
      "@@",
      "-one",
      "+ONE",
      "@@",
      "-missing-three",
      "+THREE",
      "@@",
      "-five",
      "+FIVE",
      "*** End Patch",
      "",
    ].join("\n")

    await expect(applyPatchWorkspace({ patchText: patch }, { workspacePath, fileFreshness: tracker })).rejects.toMatchObject({
      code: "patch_context_mismatch",
      message: expect.stringContaining("expected lines"),
      details: expect.objectContaining({
        path: "app.txt",
        expectedLines: "missing-three",
        suggestion: expect.stringContaining("Re-read"),
      }),
    })
    expect(fs.readFileSync(path.join(workspacePath, "app.txt"), "utf8")).toBe(original)
  })

  it("accepts structured apply_patch updates without unified hunk counts", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "app.txt"), "alpha\nbeta\ngamma\n")
    const tracker = await readFreshFiles(workspacePath, "app.txt")
    const patch = [
      "*** Begin Patch",
      "*** Update File: app.txt",
      "@@",
      " beta",
      "+beta helper",
      " gamma",
      "*** End Patch",
      "",
    ].join("\n")

    const result = await applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "app.txt"), "utf8")).toBe("alpha\nbeta\nbeta helper\ngamma\n")
    expect(result.changedFiles[0]).toMatchObject({ path: "app.txt", operation: "patched", verification: "verified" })
    expect(result.warnings?.[0]).toContain("structured apply_patch format")
    expect(result.diff).toContain("--- a/app.txt")
    expect(result.diff).toContain("+beta helper")
  })

  it("treats structured hunk labels as optional hints when exact old lines are present", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(
      path.join(workspacePath, "leverage_long_run.py"),
      [
        "import yfinance as yf",
        "import pandas as pd",
        "import matplotlib.pyplot as plt",
        "import numpy as np",
        "import warnings",
        "",
        "warnings.filterwarnings(\"ignore\", category=FutureWarning)",
        "",
      ].join("\n"),
    )
    const tracker = await readFreshFiles(workspacePath, "leverage_long_run.py")
    const patch = [
      "*** Begin Patch",
      "*** Update File: leverage_long_run.py",
      "@@ imports",
      " import yfinance as yf",
      " import pandas as pd",
      "+import datetime",
      " import matplotlib.pyplot as plt",
      " import numpy as np",
      " import warnings",
      "*** End Patch",
      "",
    ].join("\n")

    const result = await applyPatchWorkspace({ patchText: patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "leverage_long_run.py"), "utf8")).toContain(
      "import pandas as pd\nimport datetime\nimport matplotlib.pyplot as plt",
    )
    expect(result.changedFiles[0]).toMatchObject({ path: "leverage_long_run.py", operation: "patched", verification: "verified" })
  })

  it("uses structured hunk labels as anchors when they match an existing line", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "multi_ctx.txt"), "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n")
    const tracker = await readFreshFiles(workspacePath, "multi_ctx.txt")
    const patch = [
      "*** Begin Patch",
      "*** Update File: multi_ctx.txt",
      "@@ fn b",
      "-x=10",
      "+x=11",
      "*** End Patch",
      "",
    ].join("\n")

    await applyPatchWorkspace({ patchText: patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "multi_ctx.txt"), "utf8")).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n")
  })

  it("accepts heredoc-wrapped structured patches", async () => {
    const workspacePath = tempDir()
    const patch = [
      "<<PATCH",
      "*** Begin Patch",
      "*** Add File: heredoc.txt",
      "+hello from heredoc",
      "*** End Patch",
      "PATCH",
      "",
    ].join("\n")

    await applyPatchWorkspace({ patchText: patch }, { workspacePath })

    expect(fs.readFileSync(path.join(workspacePath, "heredoc.txt"), "utf8")).toBe("hello from heredoc\n")
  })

  it("accepts structured add, delete, and move patches", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "old.txt"), "same\n")
    fs.writeFileSync(path.join(workspacePath, "remove.txt"), "remove\n")
    const tracker = await readFreshFiles(workspacePath, "old.txt", "remove.txt")
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+created",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** Delete File: remove.txt",
      "*** End Patch",
      "",
    ].join("\n")

    const result = await applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "created.txt"), "utf8")).toBe("created\n")
    expect(fs.existsSync(path.join(workspacePath, "old.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(workspacePath, "new.txt"), "utf8")).toBe("same\n")
    expect(fs.existsSync(path.join(workspacePath, "remove.txt"))).toBe(false)
    expect(result.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "created.txt", operation: "created" }),
        expect.objectContaining({ path: "new.txt", operation: "renamed", previousPath: "old.txt" }),
        expect.objectContaining({ path: "remove.txt", operation: "deleted" }),
      ]),
    )
  })

  it("normalizes common structured patch prefix mistakes with warnings", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "app.txt"), "alpha\n\nbeta\n")
    const tracker = await readFreshFiles(workspacePath, "app.txt")
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "created without plus",
      "",
      "*** Update File: app.txt",
      "alpha",
      "",
      "+middle",
      "beta",
      "*** End Patch",
      "",
    ].join("\n")

    const result = await applyPatchWorkspace({ patch }, { workspacePath, fileFreshness: tracker })

    expect(fs.readFileSync(path.join(workspacePath, "created.txt"), "utf8")).toBe("created without plus\n\n")
    expect(fs.readFileSync(path.join(workspacePath, "app.txt"), "utf8")).toBe("alpha\n\nmiddle\nbeta\n")
    expect(result.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "created.txt", operation: "created" }),
        expect.objectContaining({ path: "app.txt", operation: "patched" }),
      ]),
    )
    expect(result.warnings?.some((warning) => warning.includes("Normalized Add File line"))).toBe(true)
    expect(result.warnings?.some((warning) => warning.includes("implicit @@ hunk"))).toBe(true)
    expect(result.warnings?.some((warning) => warning.includes("Normalized context line"))).toBe(true)
  })

  it("requires a read before patching an existing file", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "app.txt"), "alpha\n")
    const patch = ["*** Begin Patch", "*** Update File: app.txt", "@@", "-alpha", "+beta", "*** End Patch", ""].join("\n")

    await expect(applyPatchWorkspace({ patch }, { workspacePath })).rejects.toMatchObject({
      code: "edit_stale_content",
      message: expect.stringContaining("Read the file before applying a patch"),
    })
    expect(fs.readFileSync(path.join(workspacePath, "app.txt"), "utf8")).toBe("alpha\n")
  })

  it("requires a fresh read before patching the same file again after a successful patch", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "app.txt"), "alpha\nbeta\n")
    const tracker = await readFreshFiles(workspacePath, "app.txt")
    const firstPatch = ["*** Begin Patch", "*** Update File: app.txt", "@@", "-alpha", "+alpha = 1", "*** End Patch", ""].join("\n")
    const secondPatch = ["*** Begin Patch", "*** Update File: app.txt", "@@", "-beta", "+beta = 2", "*** End Patch", ""].join("\n")

    await applyPatchWorkspace({ patch: firstPatch }, { workspacePath, fileFreshness: tracker })
    await expect(applyPatchWorkspace({ patch: secondPatch }, { workspacePath, fileFreshness: tracker })).rejects.toMatchObject({
      code: "edit_stale_content",
      message: expect.stringContaining("Read the file again"),
    })

    await readWorkspacePath({ path: "app.txt" }, { workspacePath, fileFreshness: tracker })
    await applyPatchWorkspace({ patch: secondPatch }, { workspacePath, fileFreshness: tracker })
    expect(fs.readFileSync(path.join(workspacePath, "app.txt"), "utf8")).toBe("alpha = 1\nbeta = 2\n")
  })

  it("serializes concurrent patches on the same workspace and rejects the stale second mutation", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "app.txt"), "alpha\nbeta\n")
    const tracker = await readFreshFiles(workspacePath, "app.txt")
    const firstPatch = ["*** Begin Patch", "*** Update File: app.txt", "@@", "-alpha", "+alpha = 1", "*** End Patch", ""].join("\n")
    const secondPatch = ["*** Begin Patch", "*** Update File: app.txt", "@@", "-beta", "+beta = 2", "*** End Patch", ""].join("\n")

    const [first, second] = await Promise.allSettled([
      applyPatchWorkspace({ patchText: firstPatch }, { workspacePath, fileFreshness: tracker }),
      applyPatchWorkspace({ patchText: secondPatch }, { workspacePath, fileFreshness: tracker }),
    ])

    expect(first.status).toBe("fulfilled")
    expect(second.status).toBe("rejected")
    if (second.status !== "rejected") {
      throw new Error("expected the second concurrent patch to be rejected")
    }
    expect(second.reason).toMatchObject({
      code: "edit_stale_content",
      message: expect.stringContaining("Read the file again"),
    })
    expect(fs.readFileSync(path.join(workspacePath, "app.txt"), "utf8")).toBe("alpha = 1\nbeta\n")
  })

  it("rejects sensitive create, delete, and rename patches before applying", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, ".env"), "TOKEN=secret\n")
    fs.writeFileSync(path.join(workspacePath, "safe.txt"), "safe\n")

    const createSensitive = ["--- /dev/null", "+++ b/secret.key", "@@ -0,0 +1 @@", "+secret", ""].join("\n")
    const deleteSensitive = ["--- a/.env", "+++ /dev/null", "@@ -1 +0,0 @@", "-TOKEN=secret", ""].join("\n")
    const renameSensitive = [
      "diff --git a/safe.txt b/credential.txt",
      "similarity index 100%",
      "rename from safe.txt",
      "rename to credential.txt",
      "",
    ].join("\n")

    await expect(applyPatchWorkspace({ patch: createSensitive }, { workspacePath })).rejects.toMatchObject({ code: "sensitive_path_denied" })
    await expect(applyPatchWorkspace({ patch: deleteSensitive }, { workspacePath })).rejects.toMatchObject({ code: "sensitive_path_denied" })
    await expect(applyPatchWorkspace({ patch: renameSensitive }, { workspacePath })).rejects.toMatchObject({ code: "sensitive_path_denied" })
    expect(fs.readFileSync(path.join(workspacePath, ".env"), "utf8")).toBe("TOKEN=secret\n")
    expect(fs.readFileSync(path.join(workspacePath, "safe.txt"), "utf8")).toBe("safe\n")
    expect(fs.existsSync(path.join(workspacePath, "secret.key"))).toBe(false)
    expect(fs.existsSync(path.join(workspacePath, "credential.txt"))).toBe(false)
  })

  it("rejects sensitive structured patches before reading or applying", async () => {
    const workspacePath = tempDir()
    const patch = ["*** Begin Patch", "*** Add File: secret.key", "+secret", "*** End Patch", ""].join("\n")

    await expect(applyPatchWorkspace({ patch }, { workspacePath })).rejects.toMatchObject({ code: "sensitive_path_denied" })
    expect(fs.existsSync(path.join(workspacePath, "secret.key"))).toBe(false)
  })

  it("allows env template edits while denying real env files", async () => {
    const workspacePath = tempDir()

    await editWorkspace({ path: ".env.example", content: "OPENAI_API_KEY=\n" }, { workspacePath })

    expect(fs.readFileSync(path.join(workspacePath, ".env.example"), "utf8")).toBe("OPENAI_API_KEY=\n")
    await expect(editWorkspace({ path: ".env", content: "OPENAI_API_KEY=secret\n" }, { workspacePath })).rejects.toThrow(SocratesError)
  })

  it("applies sequential replacement edits to the same file", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "strategy.py"), "rate = 0.02\nplt.show()\n")
    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "strategy.py" }, { workspacePath, fileFreshness: tracker })

    await editWorkspace({ path: "strategy.py", oldString: "rate = 0.02", newString: "rate = 0.04" }, { workspacePath, fileFreshness: tracker })
    await readWorkspacePath({ path: "strategy.py" }, { workspacePath, fileFreshness: tracker })
    const result = await editWorkspace(
      { path: "strategy.py", oldString: "plt.show()", newString: "plt.savefig('strategy_vs_bh.png')" },
      { workspacePath, fileFreshness: tracker },
    )

    expect(fs.readFileSync(path.join(workspacePath, "strategy.py"), "utf8")).toBe(
      "rate = 0.04\nplt.savefig('strategy_vs_bh.png')\n",
    )
    expect(result.changedFiles[0]).toMatchObject({ path: "strategy.py", operation: "edited", verification: "verified" })
    expect(result.diff).toContain("plt.savefig('strategy_vs_bh.png')")
  })

  it("requires a fresh read before a second edit to the same file", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "strategy.py"), "rate = 0.02\nplt.show()\n")
    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "strategy.py" }, { workspacePath, fileFreshness: tracker })

    await editWorkspace({ path: "strategy.py", oldString: "rate = 0.02", newString: "rate = 0.04" }, { workspacePath, fileFreshness: tracker })

    await expect(
      editWorkspace(
        { path: "strategy.py", oldString: "plt.show()", newString: "plt.savefig('strategy_vs_bh.png')" },
        { workspacePath, fileFreshness: tracker },
      ),
    ).rejects.toMatchObject({
      code: "edit_stale_content",
      message: expect.stringContaining("Read the file again"),
    })
  })

  it("returns a focused unified diff for small replacement edits", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "strategy.py"), ["alpha", "beta", "gamma", "delta", "omega"].join("\n"))
    const tracker = new FileFreshnessTracker()
    await readWorkspacePath({ path: "strategy.py" }, { workspacePath, fileFreshness: tracker })

    const result = await editWorkspace({ path: "strategy.py", oldString: "delta", newString: "delta = 42" }, { workspacePath, fileFreshness: tracker })

    expect(result.diff).toContain("@@ -1,5 +1,5 @@")
    expect(result.diff).toContain("-delta")
    expect(result.diff).toContain("+delta = 42")
    expect(result.diff).not.toContain("-alpha\n-beta\n-gamma")
  })

  it("runs shell commands with bounded output", async () => {
    const workspacePath = tempDir()
    const result = await runWorkspaceBash({ command: nodeCommand("process.stdout.write('hello')"), charLimit: 3 }, { workspacePath })

    expect(result.stdout).toBe("hel")
    expect(result.truncation.truncated).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it("starts shell commands with a sanitized workspace environment", async () => {
    const workspacePath = tempDir()
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      USER: "ayush",
      SHELL: process.env.SHELL ?? "/bin/sh",
      TMPDIR: os.tmpdir(),
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      NODE_ENV: "production",
      SOCRATES_HOME: "/private/socrates",
      SOCRATES_PORT: "4000",
      OPENAI_API_KEY: "sk-secret",
      OPENROUTER_API_KEY: "or-secret",
      GOOGLE_GENERATIVE_AI_API_KEY: "google-secret",
      GEMINI_API_KEY: "gemini-secret",
      npm_config_omit: "dev",
      NPM_CONFIG_PRODUCTION: "true",
      YARN_PRODUCTION: "true",
      CI: "1",
    }
    const sanitized = __bashToolTest.buildWorkspaceCommandEnv(env)

    expect(sanitized.PATH).toBe(env.PATH)
    expect(sanitized.HOME).toBe(env.HOME)
    expect(sanitized.TMPDIR).toBe(env.TMPDIR)
    expect(sanitized.LC_ALL).toBe(env.LC_ALL)
    expect(sanitized.NODE_ENV).toBeUndefined()
    expect(sanitized.SOCRATES_HOME).toBeUndefined()
    expect(sanitized.OPENAI_API_KEY).toBeUndefined()
    expect(sanitized.npm_config_omit).toBeUndefined()
    expect(sanitized.NPM_CONFIG_PRODUCTION).toBeUndefined()
    expect(sanitized.CI).toBeUndefined()

    const session = createWorkspaceShellSession(workspacePath, { env })
    try {
      const command = nodeCommand(
        'const names = ["NODE_ENV", "SOCRATES_HOME", "SOCRATES_PORT", "OPENAI_API_KEY", "npm_config_omit", "NPM_CONFIG_PRODUCTION", "YARN_PRODUCTION", "CI"]; for (const name of names) console.log(name + "=" + (process.env[name] ?? "")); console.log("PATH_PRESENT=" + (process.env.PATH || process.env.Path ? "yes" : "no")); console.log("HOME=" + (process.env.HOME ?? process.env.USERPROFILE ?? "")); console.log("LC_ALL=" + (process.env.LC_ALL ?? ""));',
      )
      const result = await session.run({ command })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("NODE_ENV=\n")
      expect(result.stdout).toContain("SOCRATES_HOME=\n")
      expect(result.stdout).toContain("OPENAI_API_KEY=\n")
      expect(result.stdout).toContain("npm_config_omit=\n")
      expect(result.stdout).toContain("NPM_CONFIG_PRODUCTION=\n")
      expect(result.stdout).toContain("YARN_PRODUCTION=\n")
      expect(result.stdout).toContain("CI=\n")
      expect(result.stdout).toContain("PATH_PRESENT=yes")
      expect(result.stdout).toContain(`HOME=${os.tmpdir()}`)
      expect(result.stdout).toContain("LC_ALL=en_US.UTF-8")
    } finally {
      session.dispose()
    }
  })

  it("preserves explicit command-level environment assignment", async () => {
    const workspacePath = tempDir()
    const session = createWorkspaceShellSession(workspacePath, {
      env: {
        PATH: process.env.PATH,
        HOME: os.tmpdir(),
        SHELL: process.env.SHELL ?? "/bin/sh",
        NODE_ENV: "development",
        npm_config_omit: "dev",
      },
    })
    try {
      const command =
        process.platform === "win32"
          ? `$env:NODE_ENV = 'production'; ${nodeCommand("process.stdout.write(process.env.NODE_ENV ?? '')")}`
          : `NODE_ENV=production ${nodeCommand("process.stdout.write(process.env.NODE_ENV ?? '')")}`
      const result = await session.run({ command })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("production")
    } finally {
      session.dispose()
    }
  })

  it("keeps cwd and environment inside a persistent per-turn shell session", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "nested"))
    const session = createWorkspaceShellSession(workspacePath)
    try {
      const firstCommand =
        process.platform === "win32" ? "Set-Location nested; $env:SOCRATES_TEST = 'ok'; Get-Location" : "cd nested && export SOCRATES_TEST=ok && pwd"
      const secondCommand =
        process.platform === "win32"
          ? 'Write-Output -NoNewline "$env:SOCRATES_TEST $(Split-Path -Leaf (Get-Location))"'
          : 'printf "$SOCRATES_TEST $(basename "$PWD")"'
      const first = await session.run({ command: firstCommand })
      const second = await session.run({ command: secondCommand })

      expect(first.exitCode).toBe(0)
      expect(first.cwd.endsWith("nested")).toBe(true)
      expect(second.stdout).toBe("ok nested")
      expect(second.cwd.endsWith("nested")).toBe(true)
    } finally {
      session.dispose()
    }
  })

  it("starts, reads, and stops a turn-scoped shell process", async () => {
    const workspacePath = tempDir()
    const session = createWorkspaceShellSession(workspacePath)
    const command = nodeCommand("console.log('ready'); setInterval(() => console.log('tick'), 50)")
    try {
      const started = await session.run({ operation: "start", command, charLimit: 20_000 })
      const processId = started.process?.processId
      expect(started.process?.status).toBe("running")
      expect(processId).toBeTruthy()
      if (!processId) {
        return
      }

      let nextOutputSequence = started.process?.nextOutputSequence ?? 0
      let collectedOutput = started.stdout
      for (let attempt = 0; attempt < 10 && !/ready|tick/.test(collectedOutput); attempt += 1) {
        await wait(100)
        const output = await session.run({ operation: "output", processId, outputSequence: nextOutputSequence, charLimit: 20_000 })
        collectedOutput = `${collectedOutput}${output.stdout}`
        nextOutputSequence = output.process?.nextOutputSequence ?? nextOutputSequence
      }
      expect(collectedOutput).toMatch(/ready|tick/)

      const stopped = await session.run({ operation: "stop", processId })
      expect(stopped.process?.status).toBe("stopped")
    } finally {
      session.dispose()
    }
  })

  it("writes user stdin to a running shell process", async () => {
    const workspacePath = tempDir()
    const session = createWorkspaceShellSession(workspacePath)
    const command = nodeCommand(
      "process.stdout.write('Name? '); process.stdin.once('data', (data) => { process.stdout.write('hello ' + data.toString().trim()); process.exit(0); })",
    )
    try {
      const started = await session.run({ operation: "start", command, charLimit: 20_000 })
      const processId = started.process?.processId
      expect(processId).toBeTruthy()
      if (!processId) {
        return
      }

      await wait(80)
      session.writeProcessInput(processId, "Socrates\n")
      await wait(120)
      const output = await session.run({ operation: "output", processId, outputSequence: started.process?.nextOutputSequence ?? 0, charLimit: 20_000 })
      const status = await session.run({ operation: "status", processId })

      expect(`${started.stdout}${output.stdout}`).toContain("Name?")
      expect(output.stdout).toContain("hello Socrates")
      expect(status.process?.status).toBe("exited")
    } finally {
      session.dispose()
    }
  })

  it("formats Windows PowerShell command wrappers without translating commands", () => {
    const adapter = __bashToolTest.candidateAdapters("win32", {})[0]
    const wrapped = adapter?.wrapCommand({
      command: "Get-Content package.json | Select-String version",
      cwd: "C:\\Users\\Ayush\\Project",
      cwdMarker: "__SOCRATES_CWD_test__",
      doneMarker: "__SOCRATES_DONE_test__",
    })

    expect(adapter?.kind).toBe("powershell")
    expect(adapter?.executable).toBe("powershell.exe")
    expect(wrapped).toContain("Set-Location -LiteralPath 'C:\\Users\\Ayush\\Project'")
    expect(wrapped).toContain("Get-Content package.json | Select-String version")
    expect(wrapped).toContain("$global:LASTEXITCODE -ne 0")
    expect(wrapped).toContain("__SOCRATES_DONE_test__")
  })

  it("does not reuse a destroyed shell after startup failure", async () => {
    const workspacePath = tempDir()
    const session = createWorkspaceShellSession(workspacePath, { platform: "win32", env: { COMSPEC: "definitely-missing-cmd.exe" } })
    try {
      await expect(session.run({ command: "Write-Output ok" })).rejects.toMatchObject({ code: "shell_start_failed" })
      await expect(session.run({ command: "Write-Output ok" })).rejects.toMatchObject({ code: "shell_start_failed" })
    } finally {
      session.dispose()
    }
  })

  it("detects Python environment hints in the workspace root", () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "cv-venv"))
    fs.writeFileSync(path.join(workspacePath, "cv-venv", "pyvenv.cfg"), "")
    fs.writeFileSync(path.join(workspacePath, "requirements-dev.txt"), "")
    fs.writeFileSync(path.join(workspacePath, "pyproject.toml"), "")

    const hints = inspectPythonEnvironment(workspacePath)

    expect(hints.virtualEnvironments).toContain("cv-venv/")
    expect(hints.dependencyFiles).toContain("requirements-dev.txt")
    expect(hints.dependencyFiles).toContain("pyproject.toml")
    expect(hints.packageManagers).toContain("pip/venv")
  })

  it("resets the persistent shell after timeout and rejects obvious interactive commands", async () => {
    const workspacePath = tempDir()
    const session = createWorkspaceShellSession(workspacePath)
    try {
      const timedOut = await session.run({ command: nodeCommand("setTimeout(() => {}, 1000)"), timeoutMs: 20 })
      const afterTimeout = await session.run({ command: nodeCommand("process.stdout.write('alive')") })

      expect(timedOut.timedOut).toBe(true)
      expect(afterTimeout.stdout).toBe("alive")
      await expect(session.run({ command: "vim README.md" })).rejects.toThrow(SocratesError)
    } finally {
      session.dispose()
    }
  })

  it("rejects leading external absolute cd while allowing workspace-relative cd and external destinations", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "nested"))
    fs.writeFileSync(path.join(workspacePath, "result.txt"), "ok")
    const session = createWorkspaceShellSession(workspacePath)
    try {
      await expect(session.run({ command: "cd /Users/ayush/Test && python3 -m venv venv" })).rejects.toThrow(SocratesError)
      const relative = await session.run({ command: process.platform === "win32" ? "Set-Location nested; Get-Location" : "cd nested && pwd" })
      const externalDestination = await session.run({
        command:
          process.platform === "win32"
            ? `Copy-Item ..\\result.txt ${psQuote(path.join(os.tmpdir(), "socrates-result-test.txt"))}`
            : "cp ../result.txt /tmp/socrates-result-test.txt",
      })

      expect(relative.exitCode).toBe(0)
      expect(relative.cwd.endsWith("nested")).toBe(true)
      expect(externalDestination.exitCode).toBe(0)
    } finally {
      session.dispose()
    }
  })
})
