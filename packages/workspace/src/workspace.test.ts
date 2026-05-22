import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { SocratesError } from "@socrates/shared"
import {
  ensureWorkspaceScaffold,
  deleteStoredResourceFile,
  editWorkspace,
  inferResourceKind,
  pickWorkspaceFolder,
  readWorkspacePath,
  runWorkspaceBash,
  searchWorkspace,
  createWorkspaceShellSession,
  storeResourceFile,
  type CommandRunner,
} from "./index"

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "socrates-workspace-test-"))

describe("workspace scaffold", () => {
  it("creates .socrates/resources for a start-from-scratch workspace", () => {
    const workspacePath = path.join(tempDir(), "New Project")
    const scaffold = ensureWorkspaceScaffold({ workspacePath, mode: "start_from_scratch" })

    expect(scaffold.workspacePath).toBe(workspacePath)
    expect(fs.statSync(path.join(workspacePath, ".socrates")).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(workspacePath, ".socrates", "resources")).isDirectory()).toBe(true)
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

  it("avoids overwriting duplicate resource filenames", () => {
    const workspacePath = tempDir()
    const first = storeResourceFile({ workspacePath, originalName: "notes.txt", data: Buffer.from("one") })
    const second = storeResourceFile({ workspacePath, originalName: "notes.txt", data: Buffer.from("two") })

    expect(first.fileName).toBe("notes.txt")
    expect(second.fileName).toBe("notes-2.txt")
    expect(fs.readFileSync(second.path, "utf8")).toBe("two")
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

  it("searches files and text inside the workspace", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "src"))
    fs.writeFileSync(path.join(workspacePath, "src", "agent.ts"), "export const Socrates = true\n")

    const files = await searchWorkspace({ mode: "files", query: "agent" }, { workspacePath })
    const text = await searchWorkspace({ mode: "text", query: "Socrates", path: "src" }, { workspacePath })

    expect(files.matches[0]?.path).toBe("src/agent.ts")
    expect(text.matches[0]?.line).toBe(1)
  })

  it("applies precise replacement edits", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "README.md"), "hello old world")

    const result = await editWorkspace(
      { operations: [{ type: "replace", path: "README.md", oldText: "old", newText: "new" }] },
      { workspacePath },
    )

    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe("hello new world")
    expect(result.changedFiles).toEqual([{ path: "README.md", operation: "edited" }])
  })

  it("runs shell commands with bounded output", async () => {
    const workspacePath = tempDir()
    const result = await runWorkspaceBash({ command: "printf hello", charLimit: 3 }, { workspacePath })

    expect(result.stdout).toBe("hel")
    expect(result.truncation.truncated).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it("keeps cwd and environment inside a persistent per-turn shell session", async () => {
    const workspacePath = tempDir()
    fs.mkdirSync(path.join(workspacePath, "nested"))
    const session = createWorkspaceShellSession(workspacePath)
    try {
      const first = await session.run({ command: "cd nested && export SOCRATES_TEST=ok && pwd" })
      const second = await session.run({ command: "printf \"$SOCRATES_TEST $(basename \"$PWD\")\"" })

      expect(first.exitCode).toBe(0)
      expect(first.cwd.endsWith("nested")).toBe(true)
      expect(second.stdout).toBe("ok nested")
      expect(second.cwd.endsWith("nested")).toBe(true)
    } finally {
      session.dispose()
    }
  })

  it("resets the persistent shell after timeout and rejects obvious interactive commands", async () => {
    const workspacePath = tempDir()
    const session = createWorkspaceShellSession(workspacePath)
    try {
      const timedOut = await session.run({ command: "sleep 1", timeoutMs: 20 })
      const afterTimeout = await session.run({ command: "printf alive" })

      expect(timedOut.timedOut).toBe(true)
      expect(afterTimeout.stdout).toBe("alive")
      await expect(session.run({ command: "vim README.md" })).rejects.toThrow(SocratesError)
    } finally {
      session.dispose()
    }
  })
})
