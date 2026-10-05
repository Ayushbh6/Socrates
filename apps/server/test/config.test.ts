import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_NAMES, loadSettings, prepareHome, readKeys, resolveConfig, saveSettings, Settings, writeKey } from "../src";
import { tempDir } from "./helpers";

describe("data folder", () => {
  it("defaults to ~/.socrates-v2 on port 4200, and follows SOCRATES_HOME and SOCRATES_PORT", () => {
    expect(resolveConfig({})).toMatchObject({ home: path.join(homedir(), ".socrates-v2"), port: 4200 });
    const config = resolveConfig({ SOCRATES_HOME: "~/elsewhere", SOCRATES_PORT: "4300" });
    expect(config).toMatchObject({ home: path.join(homedir(), "elsewhere"), port: 4300, dbPath: path.join(homedir(), "elsewhere", "ledger.db"), keysPath: path.join(homedir(), "elsewhere", ".env") });
    expect(() => resolveConfig({ SOCRATES_PORT: "web" })).toThrow("SOCRATES_PORT must be a port number");
  });

  it("refuses the folder Socrates 0.1 uses, and creates its own readable only by the user", () => {
    const old = tempDir();
    writeFileSync(path.join(old, "socrates.sqlite"), "");
    expect(() => prepareHome(resolveConfig({ SOCRATES_HOME: old }))).toThrow("belongs to Socrates 0.1");
    const fresh = path.join(tempDir(), "v2");
    prepareHome(resolveConfig({ SOCRATES_HOME: fresh }));
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(existsSync(path.join(fresh, "logs"))).toBe(true);
  });
});

describe("keys", () => {
  it("keeps only known keys, in a file readable only by the user", () => {
    const file = path.join(tempDir(), ".env");
    writeFileSync(file, 'OTHER="x"\nGEMINI_API_KEY="old"\n');
    writeKey(file, "GEMINI_API_KEY", "new-key");
    writeKey(file, "OPENAI_API_KEY", "sk-test_1");
    expect(readKeys(file)).toEqual({ GEMINI_API_KEY: "new-key", OPENAI_API_KEY: "sk-test_1" });
    expect(readFileSync(file, "utf8")).not.toContain("OTHER");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeKey(file, "GEMINI_API_KEY", null);
    expect(readKeys(file)).toEqual({ OPENAI_API_KEY: "sk-test_1" });
    expect(() => writeKey(file, "PATH", "x")).toThrow("Unknown key PATH");
    expect(() => writeKey(file, "GEMINI_API_KEY", 'a"b')).toThrow("one line of printable characters");
    expect(() => writeKey(file, "GEMINI_API_KEY", "a\nOPENAI_API_KEY=b")).toThrow("one line of printable characters");
    expect(KEY_NAMES).toContain("ANTHROPIC_API_KEY");
  });
});

describe("settings", () => {
  it("start from the defaults, round-trip, and refuse a broken file instead of resetting it", () => {
    const file = path.join(tempDir(), "settings.json");
    expect(loadSettings(file)).toEqual({ chat: null, router: null, embeddings: { provider: "ollama", model: null, url: null }, timeZone: null, workingFolder: null, access: { scope: "folders", folders: [], approvals: "ask" }, profile: { name: null, onboarded: false } });
    const chosen = Settings.parse({ chat: { provider: "anthropic", model: "claude-opus-5-5" }, timeZone: "Europe/Berlin" });
    saveSettings(file, chosen);
    expect(loadSettings(file)).toEqual(chosen);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{ not json");
    expect(() => loadSettings(file)).toThrow("is not valid JSON");
    writeFileSync(file, JSON.stringify({ chat: { provider: "nobody", model: "x" } }));
    expect(() => loadSettings(file)).toThrow("chat.provider");
    expect(() => Settings.parse({ timeZone: "Mars/Base" })).toThrow("IANA time zone");
  });
});
