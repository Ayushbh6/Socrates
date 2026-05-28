import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn as defaultSpawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const defaultRepo = "Ayushbh6/Socrates";
const host = "127.0.0.1";

export const defaultSocratesHome = () => path.join(os.homedir(), ".Socrates");

export const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--no-open":
        options.noOpen = true;
        break;
      case "--reset-runtime":
      case "--resest-runtime":
        options.resetRuntime = true;
        break;
      case "--home":
        options.home = requiredValue(argv, (index += 1), arg);
        break;
      case "--backend-port":
        options.backendPort = parsePort(requiredValue(argv, (index += 1), arg), arg);
        break;
      case "--web-port":
        options.webPort = parsePort(requiredValue(argv, (index += 1), arg), arg);
        break;
      case "--runtime-version":
        options.runtimeVersion = requiredValue(argv, (index += 1), arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
};

export const platformArchFor = (platform, arch) => {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  throw new Error(`Unsupported platform: ${platform}-${arch}. Socrates currently supports macOS arm64, macOS x64, and Windows x64.`);
};

export const runtimeAssetName = (platformArch) => `socrates-runtime-${platformArch}.zip`;

export const runtimeRoot = (home) => path.join(home, "runtimes");

export const runtimeCacheDir = (home) => path.join(home, "cache");

export const runtimeDirFor = (home, version, platformArch) => path.join(runtimeRoot(home), version, platformArch);

export const availablePort = () =>
  new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
        } else {
          reject(new Error("Could not reserve a local port."));
        }
      });
    });
    server.once("error", reject);
  });

export const parseSha256Sums = (content) => {
  const entries = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) {
      entries.set(path.basename(match[2]), match[1].toLowerCase());
    }
  }
  return entries;
};

export const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });

export const verifyChecksum = async (filePath, sumsContent) => {
  const expected = parseSha256Sums(sumsContent).get(path.basename(filePath));
  if (!expected) {
    throw new Error(`SHA256SUMS does not include ${path.basename(filePath)}.`);
  }
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`Checksum verification failed for ${path.basename(filePath)}.`);
  }
};

export const ensureRuntime = async ({ home, platformArch, version, reset = false, log = () => undefined }) => {
  fs.mkdirSync(home, { recursive: true });
  const release = await fetchRelease(version);
  const resolvedVersion = release.tagName;
  const runtimeDir = runtimeDirFor(home, resolvedVersion, platformArch);
  const launcher = path.join(runtimeDir, "launcher.mjs");

  if (!reset && fs.existsSync(launcher)) {
    return { version: resolvedVersion, runtimeDir };
  }

  const assetName = runtimeAssetName(platformArch);
  const runtimeAsset = selectAsset(release.assets, assetName);
  const sumsAsset = selectAsset(release.assets, "SHA256SUMS");
  const cacheDir = path.join(runtimeCacheDir(home), resolvedVersion);
  const archivePath = path.join(cacheDir, assetName);
  const sumsPath = path.join(cacheDir, "SHA256SUMS");

  fs.mkdirSync(cacheDir, { recursive: true });
  log(`Downloading ${assetName}...`);
  await downloadFile(runtimeAsset.url, archivePath);
  await downloadFile(sumsAsset.url, sumsPath);
  await verifyChecksum(archivePath, fs.readFileSync(sumsPath, "utf8"));

  const tempDir = `${runtimeDir}.tmp-${Date.now()}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  await extractZip(archivePath, tempDir);
  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });
  fs.renameSync(tempDir, runtimeDir);

  if (!fs.existsSync(launcher)) {
    throw new Error(`Runtime archive did not contain launcher.mjs.`);
  }
  return { version: resolvedVersion, runtimeDir };
};

export const runRuntime = ({ runtimeDir, socratesHome, backendPort, webPort, nodePath, onReady }) =>
  new Promise((resolve, reject) => {
    const launcher = path.join(runtimeDir, "launcher.mjs");
    const child = defaultSpawn(nodePath, [launcher], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        SOCRATES_RUNTIME_DIR: runtimeDir,
        SOCRATES_HOME: socratesHome,
        SOCRATES_BACKEND_PORT: String(backendPort),
        SOCRATES_WEB_PORT: String(webPort),
      },
    });

    let ready = false;
    let buffer = "";

    const shutdown = () => {
      child.kill();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseReadyLine(line);
        if (parsed) {
          ready = true;
          void onReady(parsed).catch(reject);
        } else {
          console.log(line);
        }
      }
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      if (!ready && code !== 0) {
        reject(new Error(`Socrates runtime exited before becoming ready with code ${code ?? signal}.`));
        return;
      }
      resolve();
    });
  });

export const openBrowser = async (url, { spawn = defaultSpawn } = {}) => {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
};

export const selectAsset = (assets, name) => {
  const asset = assets.find((item) => item.name === name);
  if (!asset) {
    throw new Error(`GitHub Release is missing ${name}.`);
  }
  return asset;
};

const fetchRelease = async (version) => {
  const repo = process.env.SOCRATES_RELEASE_REPO ?? defaultRepo;
  const pathPart = version ? `releases/tags/${encodeURIComponent(version)}` : "releases/latest";
  const response = await fetch(`https://api.github.com/repos/${repo}/${pathPart}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "@socrates-ai/cli",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not fetch Socrates release metadata: HTTP ${response.status}.`);
  }
  const json = await response.json();
  return {
    tagName: json.tag_name,
    assets: (json.assets ?? []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
};

const downloadFile = async (url, target) => {
  const response = await fetch(url, {
    headers: {
      "user-agent": "@socrates-ai/cli",
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  }
  const tempTarget = `${target}.tmp`;
  fs.rmSync(tempTarget, { force: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempTarget));
  fs.renameSync(tempTarget, target);
};

const extractZip = async (archivePath, targetDir) => {
  if (process.platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${targetDir}' -Force`,
    ]);
    return;
  }
  await run("unzip", ["-q", archivePath, "-d", targetDir]);
};

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = defaultSpawn(command, args, { stdio: "ignore" });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
    child.once("error", reject);
  });

const parseReadyLine = (line) => {
  try {
    const parsed = JSON.parse(line);
    if (parsed?.type === "socrates.runtime.ready" && typeof parsed.webUrl === "string") {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const requiredValue = (argv, index, flag) => {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};

const parsePort = (value, flag) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${flag} requires a valid TCP port.`);
  }
  return port;
};
