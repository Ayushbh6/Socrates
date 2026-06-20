import fs from "node:fs"
import path from "node:path"
import { inspectPythonEnvironment, type PythonEnvironmentHints } from "./pythonEnvironment"
import { resolveWorkspacePath } from "./tools/common"

export type JavaScriptWorkspaceHints = {
  packageManager?: string
  packageManagers: string[]
  dependencyFiles: string[]
  packageFiles: string[]
  packageNames: string[]
  frameworks: string[]
  scripts: string[]
}

export type RustWorkspaceHints = {
  dependencyFiles: string[]
  packageManagers: string[]
}

export type WorkspaceEnvironmentHints = {
  workspacePath: string
  detectedStack: string[]
  python: PythonEnvironmentHints
  javascript: JavaScriptWorkspaceHints
  rust: RustWorkspaceHints
}

const ignoredDirectoryNames = new Set(["node_modules", "dist", "build", ".next", ".socrates", "tmp-opencode"])
const rootJavaScriptFiles = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "tsconfig.json"]
const packageRoots = ["apps", "packages"]

export const inspectWorkspaceEnvironment = (workspacePath: string): WorkspaceEnvironmentHints => {
  const root = resolveWorkspacePath(workspacePath)
  const python = inspectPythonEnvironment(root)
  const javascript = inspectJavaScriptWorkspace(root)
  const rust = inspectRustWorkspace(root)
  const detectedStack = detectStack({ python, javascript, rust })

  return {
    workspacePath: root,
    detectedStack,
    python,
    javascript,
    rust,
  }
}

const inspectJavaScriptWorkspace = (root: string): JavaScriptWorkspaceHints => {
  const dependencyFiles = existingRootFiles(root, rootJavaScriptFiles)
  const packageFiles = findPackageFiles(root)
  const packages = packageFiles.map((filePath) => readPackageJson(path.join(root, filePath))).filter((pkg): pkg is PackageJson => pkg !== undefined)
  const rootPackage = readPackageJson(path.join(root, "package.json"))
  const packageManagers = detectJavaScriptPackageManagers(root, rootPackage)
  const frameworks = detectJavaScriptFrameworks(root, packages, dependencyFiles)
  const packageNames = packages.map((pkg) => pkg.name).filter((name): name is string => typeof name === "string" && name.length > 0).sort()
  const scripts = Object.keys(rootPackage?.scripts ?? {}).sort().slice(0, 12)

  return {
    ...(typeof rootPackage?.packageManager === "string" ? { packageManager: rootPackage.packageManager } : {}),
    packageManagers,
    dependencyFiles,
    packageFiles,
    packageNames,
    frameworks,
    scripts,
  }
}

const inspectRustWorkspace = (root: string): RustWorkspaceHints => {
  const dependencyFiles = findBoundedFiles(root, ["Cargo.toml", "Cargo.lock"])
  return {
    dependencyFiles,
    packageManagers: dependencyFiles.some((filePath) => filePath.endsWith("Cargo.toml") || filePath.endsWith("Cargo.lock")) ? ["cargo"] : [],
  }
}

const detectStack = (input: {
  python: PythonEnvironmentHints
  javascript: JavaScriptWorkspaceHints
  rust: RustWorkspaceHints
}): string[] => {
  const stack = new Set<string>()
  if (input.python.virtualEnvironments.length > 0 || input.python.dependencyFiles.length > 0) {
    stack.add("python")
  }
  if (input.javascript.packageFiles.length > 0 || input.javascript.dependencyFiles.length > 0) {
    stack.add("nodejs")
  }
  if (input.javascript.dependencyFiles.some((filePath) => filePath.endsWith("tsconfig.json")) || input.javascript.frameworks.includes("typescript")) {
    stack.add("typescript")
  }
  for (const framework of input.javascript.frameworks) {
    if (framework !== "typescript") {
      stack.add(framework)
    }
  }
  if (input.rust.dependencyFiles.length > 0) {
    stack.add("rust")
  }
  return [...stack].sort()
}

const existingRootFiles = (root: string, names: string[]): string[] =>
  names.filter((name) => isFile(path.join(root, name))).sort()

const findPackageFiles = (root: string): string[] => {
  const files = new Set<string>()
  if (isFile(path.join(root, "package.json"))) {
    files.add("package.json")
  }
  for (const rootName of packageRoots) {
    const absoluteRoot = path.join(root, rootName)
    for (const entry of safeReadDir(absoluteRoot)) {
      if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) {
        continue
      }
      const packagePath = path.join(rootName, entry.name, "package.json")
      if (isFile(path.join(root, packagePath))) {
        files.add(packagePath)
      }
    }
  }
  return [...files].sort()
}

const findBoundedFiles = (root: string, names: string[]): string[] => {
  const wanted = new Set(names)
  const files = new Set<string>()
  for (const name of names) {
    if (isFile(path.join(root, name))) {
      files.add(name)
    }
  }
  for (const rootName of packageRoots) {
    const absoluteRoot = path.join(root, rootName)
    for (const entry of safeReadDir(absoluteRoot)) {
      if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) {
        continue
      }
      const packageRoot = path.join(absoluteRoot, entry.name)
      for (const child of safeReadDir(packageRoot)) {
        if (child.isFile() && wanted.has(child.name)) {
          files.add(path.join(rootName, entry.name, child.name))
        }
        if (child.isDirectory() && !ignoredDirectoryNames.has(child.name)) {
          for (const grandchild of safeReadDir(path.join(packageRoot, child.name))) {
            if (grandchild.isFile() && wanted.has(grandchild.name)) {
              files.add(path.join(rootName, entry.name, child.name, grandchild.name))
            }
          }
        }
      }
    }
  }
  return [...files].sort()
}

type PackageJson = {
  name?: string
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const readPackageJson = (filePath: string): PackageJson | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageJson
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

const detectJavaScriptPackageManagers = (root: string, rootPackage: PackageJson | undefined): string[] => {
  const managers = new Set<string>()
  const declared = rootPackage?.packageManager?.split("@")[0]
  if (declared) managers.add(declared)
  if (isFile(path.join(root, "pnpm-lock.yaml")) || isFile(path.join(root, "pnpm-workspace.yaml"))) managers.add("pnpm")
  if (isFile(path.join(root, "package-lock.json"))) managers.add("npm")
  if (isFile(path.join(root, "yarn.lock"))) managers.add("yarn")
  if (isFile(path.join(root, "bun.lockb"))) managers.add("bun")
  return [...managers].sort()
}

const detectJavaScriptFrameworks = (root: string, packages: PackageJson[], dependencyFiles: string[]): string[] => {
  const dependencyNames = new Set<string>()
  for (const pkg of packages) {
    for (const name of Object.keys(pkg.dependencies ?? {})) dependencyNames.add(name)
    for (const name of Object.keys(pkg.devDependencies ?? {})) dependencyNames.add(name)
  }
  const frameworks = new Set<string>()
  if (dependencyNames.has("typescript") || dependencyFiles.some((filePath) => filePath.endsWith("tsconfig.json"))) frameworks.add("typescript")
  if (dependencyNames.has("next") || hasBoundedFile(root, "next.config.ts")) frameworks.add("nextjs")
  if (dependencyNames.has("react") || dependencyNames.has("react-dom")) frameworks.add("react")
  if (dependencyNames.has("fastify")) frameworks.add("fastify")
  if (dependencyNames.has("drizzle-orm")) frameworks.add("drizzle")
  if (dependencyNames.has("better-sqlite3")) frameworks.add("sqlite")
  if ([...dependencyNames].some((name) => name.startsWith("@tauri-apps/")) || hasBoundedFile(root, "tauri.conf.json")) frameworks.add("tauri")
  if (dependencyNames.has("vitest")) frameworks.add("vitest")
  if (dependencyNames.has("tailwindcss")) frameworks.add("tailwind")
  if (dependencyNames.has("zod")) frameworks.add("zod")
  if ([...dependencyNames].some((name) => name.startsWith("@ai-sdk/") || name === "ai" || name === "@openrouter/ai-sdk-provider")) frameworks.add("ai-sdk")
  return [...frameworks].sort()
}

const hasBoundedFile = (root: string, name: string): boolean => findBoundedFiles(root, [name]).length > 0

const safeReadDir = (directoryPath: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
  } catch {
    return []
  }
}

const isFile = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}
