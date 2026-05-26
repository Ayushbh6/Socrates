import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { prepareServerDataDirectory, resolveSocratesDbPath, resolveSocratesHome } from "../config"

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "socrates-server-config-test-"))

describe("server data directory config", () => {
  it("defaults to a user-owned Socrates home directory", () => {
    expect(resolveSocratesHome({})).toBe(path.join(os.homedir(), ".Socrates"))
    expect(resolveSocratesDbPath({})).toBe(path.join(os.homedir(), ".Socrates", "socrates.sqlite"))
  })

  it("supports SOCRATES_HOME and SOCRATES_DB_PATH overrides", () => {
    const homePath = path.join(tempDir(), "CustomHome")
    const dbPath = path.join(tempDir(), "custom.sqlite")

    expect(resolveSocratesHome({ SOCRATES_HOME: homePath })).toBe(homePath)
    expect(resolveSocratesDbPath({ SOCRATES_HOME: homePath })).toBe(path.join(homePath, "socrates.sqlite"))
    expect(resolveSocratesDbPath({ SOCRATES_DB_PATH: dbPath })).toBe(dbPath)
    expect(resolveSocratesDbPath({ SOCRATES_HOME: homePath, SOCRATES_DB_PATH: "~/custom.sqlite" })).toBe(
      path.join(os.homedir(), "custom.sqlite"),
    )
  })

  it("imports an existing legacy development database once", () => {
    const legacyDir = tempDir()
    const targetDir = tempDir()
    const legacyDevDbPath = path.join(legacyDir, "socrates.sqlite")
    const dbPath = path.join(targetDir, "nested", "socrates.sqlite")
    fs.writeFileSync(legacyDevDbPath, "legacy-db")
    fs.writeFileSync(`${legacyDevDbPath}-wal`, "legacy-wal")
    fs.writeFileSync(`${legacyDevDbPath}-shm`, "legacy-shm")

    const result = prepareServerDataDirectory({ dbPath, legacyDevDbPath }, {})

    expect(result).toEqual({ imported: true, sourcePath: legacyDevDbPath, targetPath: dbPath })
    expect(fs.readFileSync(dbPath, "utf8")).toBe("legacy-db")
    expect(fs.readFileSync(`${dbPath}-wal`, "utf8")).toBe("legacy-wal")
    expect(fs.readFileSync(`${dbPath}-shm`, "utf8")).toBe("legacy-shm")
  })

  it("does not import the legacy database when explicitly configured or already initialized", () => {
    const legacyDevDbPath = path.join(tempDir(), "socrates.sqlite")
    const dbPath = path.join(tempDir(), "socrates.sqlite")
    fs.writeFileSync(legacyDevDbPath, "legacy-db")
    fs.writeFileSync(dbPath, "existing-db")

    expect(prepareServerDataDirectory({ dbPath, legacyDevDbPath }, { SOCRATES_DB_PATH: dbPath })).toEqual({
      imported: false,
    })
    expect(prepareServerDataDirectory({ dbPath, legacyDevDbPath }, {})).toEqual({ imported: false })
    expect(fs.readFileSync(dbPath, "utf8")).toBe("existing-db")
  })
})
