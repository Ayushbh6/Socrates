import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(serverRoot, "src", "memory", "defaults")
const target = path.join(serverRoot, "dist", "memory", "defaults")

if (!fs.existsSync(source)) {
  throw new Error(`Memory asset source directory was not found: ${source}`)
}

fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.cpSync(source, target, { recursive: true })

console.log(`Copied memory assets to ${target}`)
