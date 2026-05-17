import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { SocratesError } from "@socrates/shared"

const execFileAsync = promisify(execFile)

export type WorkspaceMode = "start_from_scratch" | "existing_folder"

export type CommandResult = {
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export type PickWorkspaceFolderInput = {
  mode: WorkspaceMode
}

export type PickWorkspaceFolderResult = {
  path: string
  folderName: string
}

export type WorkspaceScaffold = {
  workspacePath: string
  folderName: string
  socratesPath: string
  resourcesPath: string
}

export type StoreResourceFileInput = {
  workspacePath: string
  originalName: string
  data: Buffer
}

export type StoredResourceFile = {
  path: string
  fileName: string
}

const defaultCommandRunner: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { encoding: "utf8" })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

const isWindowsAbsolutePath = (workspacePath: string): boolean => /^[a-zA-Z]:[\\/]/.test(workspacePath)

const normalizeWorkspacePath = (workspacePath: string): string => {
  if (isWindowsAbsolutePath(workspacePath)) {
    return path.win32.normalize(workspacePath)
  }
  return path.resolve(workspacePath)
}

const folderNameFromPath = (workspacePath: string): string => {
  if (isWindowsAbsolutePath(workspacePath)) {
    return path.win32.basename(path.win32.normalize(workspacePath))
  }
  const normalized = path.resolve(workspacePath)
  return path.basename(normalized)
}

const parsePickerOutput = (stdout: string): PickWorkspaceFolderResult => {
  const selectedPath = stdout.trim()
  if (!selectedPath) {
    throw new SocratesError("folder_picker_cancelled", "Folder selection was cancelled")
  }

  return {
    path: normalizeWorkspacePath(selectedPath),
    folderName: folderNameFromPath(selectedPath),
  }
}

const normalizePickerError = (error: unknown): SocratesError => {
  if (error instanceof SocratesError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  if (message.toLowerCase().includes("cancel")) {
    return new SocratesError("folder_picker_cancelled", "Folder selection was cancelled")
  }

  return new SocratesError("folder_picker_failed", "Could not open the native folder picker", {
    details: { message },
  })
}

export const pickWorkspaceFolder = async (
  input: PickWorkspaceFolderInput,
  options: { platform?: NodeJS.Platform; commandRunner?: CommandRunner } = {},
): Promise<PickWorkspaceFolderResult> => {
  const platform = options.platform ?? process.platform
  const commandRunner = options.commandRunner ?? defaultCommandRunner
  const prompt =
    input.mode === "start_from_scratch"
      ? "Select or create the Socrates project workspace folder"
      : "Select the existing project workspace folder"

  try {
    if (platform === "darwin") {
      return parsePickerOutput(
        (
          await commandRunner("osascript", [
            "-e",
            `POSIX path of (choose folder with prompt "${prompt.replaceAll('"', '\\"')}")`,
          ])
        ).stdout,
      )
    }

    if (platform === "win32") {
      const command = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = '${prompt.replaceAll("'", "''")}'`,
        "$dialog.ShowNewFolderButton = $true",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
        "  [Console]::WriteLine($dialog.SelectedPath)",
        "} else {",
        "  exit 2",
        "}",
      ].join("; ")
      return parsePickerOutput((await commandRunner("powershell.exe", ["-NoProfile", "-STA", "-Command", command])).stdout)
    }

    if (platform === "linux") {
      const picker = (await commandRunner("sh", ["-lc", "command -v zenity || command -v kdialog || true"])).stdout.trim()
      if (picker.endsWith("zenity")) {
        return parsePickerOutput(
          (await commandRunner("zenity", ["--file-selection", "--directory", "--title", prompt])).stdout,
        )
      }
      if (picker.endsWith("kdialog")) {
        return parsePickerOutput((await commandRunner("kdialog", ["--getexistingdirectory", os.homedir(), prompt])).stdout)
      }
    }
  } catch (error) {
    throw normalizePickerError(error)
  }

  throw new SocratesError("folder_picker_unsupported", "Native folder picker is not available on this system", {
    details: { platform },
  })
}

export const ensureWorkspaceScaffold = (input: {
  workspacePath: string
  mode: WorkspaceMode
}): WorkspaceScaffold => {
  if (!path.isAbsolute(input.workspacePath)) {
    throw new SocratesError("workspace_path_not_absolute", "Workspace path must be absolute", {
      details: { workspacePath: input.workspacePath },
    })
  }

  const workspacePath = path.resolve(input.workspacePath)

  try {
    if (input.mode === "start_from_scratch") {
      fs.mkdirSync(workspacePath, { recursive: true })
    }

    const stat = fs.statSync(workspacePath)
    if (!stat.isDirectory()) {
      throw new SocratesError("workspace_path_not_directory", "Workspace path must be a directory", {
        details: { workspacePath },
      })
    }

    const socratesPath = path.join(workspacePath, ".socrates")
    const resourcesPath = path.join(socratesPath, "resources")
    fs.mkdirSync(resourcesPath, { recursive: true })

    return {
      workspacePath,
      folderName: folderNameFromPath(workspacePath),
      socratesPath,
      resourcesPath,
    }
  } catch (error) {
    if (error instanceof SocratesError) {
      throw error
    }

    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === "ENOENT") {
      throw new SocratesError("workspace_path_not_found", "Workspace path does not exist", {
        details: { workspacePath },
      })
    }
    if (nodeError.code === "EACCES" || nodeError.code === "EPERM") {
      throw new SocratesError("workspace_access_denied", "Socrates cannot access the selected workspace folder", {
        details: { workspacePath },
      })
    }

    throw new SocratesError("workspace_scaffold_failed", "Could not prepare the Socrates workspace scaffold", {
      details: { workspacePath, message: nodeError.message },
    })
  }
}

const sanitizeFileName = (fileName: string): string => {
  const parsed = path.parse(fileName)
  const base = parsed.name.replaceAll(/[^a-zA-Z0-9._-]/g, "_").replaceAll(/_+/g, "_") || "resource"
  const ext = parsed.ext.replaceAll(/[^a-zA-Z0-9.]/g, "")
  return `${base}${ext}`
}

const nextAvailablePath = (directory: string, fileName: string): { path: string; fileName: string } => {
  const parsed = path.parse(fileName)
  let candidateName = fileName
  let candidatePath = path.join(directory, candidateName)
  let index = 2

  while (fs.existsSync(candidatePath)) {
    candidateName = `${parsed.name}-${index}${parsed.ext}`
    candidatePath = path.join(directory, candidateName)
    index += 1
  }

  return { path: candidatePath, fileName: candidateName }
}

export const storeResourceFile = (input: StoreResourceFileInput): StoredResourceFile => {
  const scaffold = ensureWorkspaceScaffold({
    workspacePath: input.workspacePath,
    mode: "existing_folder",
  })
  const safeName = sanitizeFileName(input.originalName)
  const target = nextAvailablePath(scaffold.resourcesPath, safeName)
  fs.writeFileSync(target.path, input.data)
  return target
}

export const inferResourceKind = (
  fileName: string,
): "pdf" | "document" | "text" | "image" | "local_file" | "other" => {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === ".pdf") {
    return "pdf"
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg"].includes(ext)) {
    return "image"
  }
  if ([".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml"].includes(ext)) {
    return "text"
  }
  if ([".doc", ".docx", ".rtf", ".odt"].includes(ext)) {
    return "document"
  }
  return "local_file"
}
