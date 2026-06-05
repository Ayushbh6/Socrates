import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  availablePort,
  parseArgs,
  parseSha256Sums,
  platformArchFor,
  powerShellSingleQuoted,
  runtimeAssetName,
  runtimeDirFor,
  selectAsset,
  verifyChecksum,
  zipExtractCommandsFor,
} from "./runtime.mjs";

describe("Socrates CLI runtime helpers", () => {
  it("maps supported platform assets", () => {
    expect(platformArchFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformArchFor("darwin", "x64")).toBe("darwin-x64");
    expect(platformArchFor("win32", "x64")).toBe("win32-x64");
    expect(runtimeAssetName("darwin-arm64")).toBe("socrates-runtime-darwin-arm64.zip");
    expect(() => platformArchFor("linux", "x64")).toThrow(/Unsupported platform/);
  });

  it("parses CLI flags", () => {
    expect(
      parseArgs([
        "--no-open",
        "--home",
        "/tmp/socrates",
        "--backend-port",
        "4317",
        "--web-port",
        "4318",
        "--runtime-version",
        "v0.1.0",
        "--reset-runtime",
      ]),
    ).toEqual({
      noOpen: true,
      home: "/tmp/socrates",
      backendPort: 4317,
      webPort: 4318,
      runtimeVersion: "v0.1.0",
      resetRuntime: true,
    });
    expect(parseArgs(["--resest-runtime"])).toEqual({ resetRuntime: true });
  });

  it("selects release assets and rejects missing assets", () => {
    const assets = [{ name: "socrates-runtime-darwin-arm64.zip", url: "https://example.test/runtime.zip" }];
    expect(selectAsset(assets, "socrates-runtime-darwin-arm64.zip")).toEqual(assets[0]);
    expect(() => selectAsset(assets, "SHA256SUMS")).toThrow(/missing SHA256SUMS/);
  });

  it("prefers Windows tar extraction before falling back to PowerShell Expand-Archive", () => {
    const commands = zipExtractCommandsFor("win32", "C:\\Users\\O'Neil\\.Socrates\\cache\\runtime.zip", "C:\\Users\\O'Neil\\.Socrates\\runtime");
    expect(commands[0]).toEqual({
      command: "tar.exe",
      args: ["-xf", "C:\\Users\\O'Neil\\.Socrates\\cache\\runtime.zip", "-C", "C:\\Users\\O'Neil\\.Socrates\\runtime"],
    });
    expect(commands[1].command).toBe("powershell.exe");
    expect(commands[1].args[2]).toContain("O''Neil");
    expect(powerShellSingleQuoted("C:\\Users\\O'Neil")).toBe("'C:\\Users\\O''Neil'");
  });

  it("verifies checksum files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-cli-test-"));
    const file = path.join(dir, "socrates-runtime-darwin-arm64.zip");
    fs.writeFileSync(file, "runtime");
    const sums = parseSha256Sums(
      "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23  socrates-runtime-darwin-arm64.zip\n",
    );
    expect(sums.get("socrates-runtime-darwin-arm64.zip")).toBe(
      "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23",
    );
    await expect(
      verifyChecksum(
        file,
        "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23  socrates-runtime-darwin-arm64.zip\n",
      ),
    ).resolves.toBeUndefined();
  });

  it("builds runtime cache paths", () => {
    expect(runtimeDirFor("/tmp/home", "v0.1.0", "win32-x64")).toBe(path.join("/tmp/home", "runtimes", "v0.1.0", "win32-x64"));
  });

  it("reserves a local TCP port", async () => {
    const port = await availablePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
