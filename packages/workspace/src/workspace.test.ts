import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { SocratesError } from "@socrates/shared"
import {
  copyStoredResourceFile,
  ensureWorkspaceScaffold,
  deleteStoredResourceFile,
  editWorkspace,
  inferResourceKind,
  inspectWorkspacePath,
  inspectPythonEnvironment,
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

  it("allows env template edits while denying real env files", async () => {
    const workspacePath = tempDir()

    await editWorkspace({ operations: [{ type: "create", path: ".env.example", content: "OPENAI_API_KEY=\n" }] }, { workspacePath })

    expect(fs.readFileSync(path.join(workspacePath, ".env.example"), "utf8")).toBe("OPENAI_API_KEY=\n")
    await expect(editWorkspace({ operations: [{ type: "create", path: ".env", content: "OPENAI_API_KEY=secret\n" }] }, { workspacePath })).rejects.toThrow(
      SocratesError,
    )
  })

  it("composes multiple replacement edits to the same file before writing", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "strategy.py"), "rate = 0.02\nplt.show()\n")

    const result = await editWorkspace(
      {
        operations: [
          { type: "replace", path: "strategy.py", oldText: "rate = 0.02", newText: "rate = 0.04" },
          { type: "replace", path: "strategy.py", oldText: "plt.show()", newText: "plt.savefig('strategy_vs_bh.png')" },
        ],
      },
      { workspacePath },
    )

    expect(fs.readFileSync(path.join(workspacePath, "strategy.py"), "utf8")).toBe(
      "rate = 0.04\nplt.savefig('strategy_vs_bh.png')\n",
    )
    expect(result.changedFiles).toEqual([{ path: "strategy.py", operation: "edited" }])
    expect(result.diff).toContain("rate = 0.04")
    expect(result.diff).toContain("plt.savefig('strategy_vs_bh.png')")
  })

  it("returns a focused unified diff for small replacement edits", async () => {
    const workspacePath = tempDir()
    fs.writeFileSync(path.join(workspacePath, "strategy.py"), ["alpha", "beta", "gamma", "delta", "omega"].join("\n"))

    const result = await editWorkspace(
      {
        operations: [{ type: "replace", path: "strategy.py", oldText: "delta", newText: "delta = 42" }],
      },
      { workspacePath },
    )

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
