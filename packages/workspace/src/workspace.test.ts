import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { SocratesError } from "@socrates/shared"
import {
  ensureWorkspaceScaffold,
  inferResourceKind,
  pickWorkspaceFolder,
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
