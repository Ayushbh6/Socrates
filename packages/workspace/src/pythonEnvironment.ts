import fs from "node:fs"
import path from "node:path"
import { resolveWorkspacePath } from "./tools/common"

export type PythonEnvironmentHints = {
  workspacePath: string
  virtualEnvironments: string[]
  dependencyFiles: string[]
  packageManagers: string[]
  suggestedVirtualEnvironment?: string
}

const dependencyFileNames = new Set([
  "pyproject.toml",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "environment.yml",
  "environment.yaml",
  "pipfile",
  "pipfile.lock",
])

export const inspectPythonEnvironment = (workspacePath: string): PythonEnvironmentHints => {
  const root = resolveWorkspacePath(workspacePath)
  const entries = safeReadDir(root)
  const virtualEnvironments = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => isLikelyVirtualEnvironment(root, name))
    .sort(compareVirtualEnvironmentNames)
    .map((name) => `${name}/`)

  const dependencyFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(isPythonDependencyFile)
    .sort()

  const packageManagers = detectPackageManagers(dependencyFiles, virtualEnvironments)

  return {
    workspacePath: root,
    virtualEnvironments,
    dependencyFiles,
    packageManagers,
    ...(virtualEnvironments[0] ? { suggestedVirtualEnvironment: virtualEnvironments[0] } : {}),
  }
}

export const formatPythonEnvironmentHints = (hints: PythonEnvironmentHints): string => {
  const managers = hints.packageManagers.length > 0 ? hints.packageManagers.join(", ") : "none detected"
  const envs = hints.virtualEnvironments.length > 0 ? hints.virtualEnvironments.map((item) => `  - ${item}`).join("\n") : "  - none"
  const files = hints.dependencyFiles.length > 0 ? hints.dependencyFiles.map((item) => `  - ${item}`).join("\n") : "  - none"
  const guidance = pythonGuidanceForHints(hints)

  return `Active Workspace
  - Root: ${hints.workspacePath}
  - Terminal commands already start in this root. Do not guess or hardcode another workspace path.
  - The Terminal tool's compatibility id is bash, but it uses the platform-native shell. On Windows, write PowerShell-compatible commands instead of Unix-only pipelines unless the project provides those tools.

Python Environment Hints
- Local virtual environments found:
${envs}
- Dependency files found:
${files}
- Package managers detected: ${managers}

Python execution guidance for this workspace:
${guidance}`
}

const safeReadDir = (workspacePath: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(workspacePath, { withFileTypes: true })
  } catch {
    return []
  }
}

const isLikelyVirtualEnvironment = (workspacePath: string, name: string): boolean => {
  const lower = name.toLowerCase()
  if (fs.existsSync(path.join(workspacePath, name, "pyvenv.cfg"))) {
    return true
  }
  return lower === ".venv" || lower === "venv" || lower === "env" || lower.includes("venv") || lower.includes("virtualenv")
}

const compareVirtualEnvironmentNames = (left: string, right: string): number => {
  const rank = (name: string): number => {
    const lower = name.toLowerCase()
    if (lower === ".venv") return 0
    if (lower === "venv") return 1
    if (lower === "env") return 2
    return 3
  }
  return rank(left) - rank(right) || left.localeCompare(right)
}

const isPythonDependencyFile = (name: string): boolean => {
  const lower = name.toLowerCase()
  return dependencyFileNames.has(lower) || /^requirements.*\.txt$/.test(lower)
}

const detectPackageManagers = (dependencyFiles: string[], virtualEnvironments: string[]): string[] => {
  const lower = new Set(dependencyFiles.map((item) => item.toLowerCase()))
  const managers: string[] = []
  if (lower.has("poetry.lock")) managers.push("poetry")
  if (lower.has("pdm.lock")) managers.push("pdm")
  if (lower.has("uv.lock")) managers.push("uv")
  if (lower.has("environment.yml") || lower.has("environment.yaml")) managers.push("conda")
  if (virtualEnvironments.length > 0 || [...lower].some((item) => item.startsWith("requirements"))) managers.push("pip/venv")
  if (lower.has("pyproject.toml") && managers.length === 0) managers.push("pyproject")
  return managers
}

const pythonGuidanceForHints = (hints: PythonEnvironmentHints): string => {
  if (hints.packageManagers.includes("poetry")) {
    return "- Prefer Poetry commands such as `poetry install` and `poetry run python ...` instead of raw `pip`, unless the user says otherwise."
  }
  if (hints.packageManagers.includes("pdm")) {
    return "- Prefer PDM commands such as `pdm install` and `pdm run python ...` instead of raw `pip`, unless the user says otherwise."
  }
  if (hints.packageManagers.includes("uv")) {
    return "- Prefer uv commands such as `uv sync`, `uv pip install ...`, or `uv run python ...`, unless the user says otherwise."
  }
  if (hints.packageManagers.includes("conda")) {
    return "- A Conda environment file is present. Ask before creating a venv or installing packages with raw `pip` unless the user already requested that."
  }
  if (hints.suggestedVirtualEnvironment) {
    const env = hints.suggestedVirtualEnvironment
    return `- Use the existing \`${env}\` environment for installs and runs.
- On macOS/Linux, prefer commands like \`source ${env}bin/activate && python script.py\` and \`source ${env}bin/activate && pip install <packages>\`.
- On Windows, prefer commands like \`.\\${env}Scripts\\Activate.ps1; python script.py\` and \`.\\${env}Scripts\\Activate.ps1; python -m pip install <packages>\`.
- Do not create another virtual environment unless the user asks.`
  }
  return "- No project-local Python environment was detected. If dependency installation is needed, ask whether to create `.venv/`, use Conda, or use another environment before installing packages, unless the user already explicitly requested setup."
}
