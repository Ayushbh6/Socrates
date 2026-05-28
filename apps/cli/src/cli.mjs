import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  availablePort,
  defaultSocratesHome,
  ensureRuntime,
  openBrowser,
  parseArgs,
  platformArchFor,
  runRuntime,
} from "./runtime.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

export const runCli = async (argv) => {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(helpText());
    return;
  }

  if (options.version) {
    console.log(packageJson.version);
    return;
  }

  assertNodeVersion(process.versions.node);

  const platformArch = platformArchFor(process.platform, process.arch);
  const socratesHome = path.resolve(options.home ?? defaultSocratesHome());
  const backendPort = options.backendPort ?? (await availablePort());
  let webPort = options.webPort ?? (await availablePort());
  while (!options.webPort && webPort === backendPort) {
    webPort = await availablePort();
  }
  if (webPort === backendPort) {
    throw new Error("Backend and web ports must be different.");
  }

  console.log("Socrates is starting...");
  console.log(`Data: ${socratesHome}`);

  const runtime = await ensureRuntime({
    home: socratesHome,
    platformArch,
    version: options.runtimeVersion,
    reset: options.resetRuntime,
    log: (message) => console.log(message),
  });

  console.log(`Runtime: ${runtime.runtimeDir}`);
  console.log(`Backend: http://127.0.0.1:${backendPort}`);
  console.log(`App: http://127.0.0.1:${webPort}`);

  await runRuntime({
    runtimeDir: runtime.runtimeDir,
    socratesHome,
    backendPort,
    webPort,
    nodePath: process.execPath,
    onReady: async (ready) => {
      console.log("");
      console.log(`Socrates is ready: ${ready.webUrl}`);
      console.log("Press Ctrl+C to stop.");
      if (!options.noOpen) {
        await openBrowser(ready.webUrl, { spawn });
      }
    },
  });
};

const assertNodeVersion = (version) => {
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`Socrates requires Node.js 20 or newer. Current Node.js version is ${version}.`);
  }
};

const helpText = () => `Socrates ${packageJson.version}

Usage:
  socrates [options]

Options:
  --version                 Print the CLI version.
  --no-open                 Start Socrates without opening the browser.
  --home <path>             Use a custom Socrates data directory.
  --backend-port <port>     Use a fixed backend port.
  --web-port <port>         Use a fixed web port.
  --runtime-version <tag>   Use a specific GitHub Release tag, e.g. v0.1.2.
  --reset-runtime           Redownload and extract the runtime bundle.
  --help                    Show this help.
`;
