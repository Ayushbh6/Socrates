import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeScriptsRoot = path.join(repoRoot, "scripts", "runtime");
const runtimeCacheRoot = path.join(repoRoot, ".runtime-cache");
const runtimeDir = path.resolve(process.env.SOCRATES_RUNTIME_OUTPUT_DIR ?? path.join(runtimeCacheRoot, "runtime"));
const cacheDir = path.join(runtimeCacheRoot, "downloads");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeVersion = process.env.SOCRATES_RUNTIME_NODE_VERSION ?? process.env.SOCRATES_DESKTOP_NODE_VERSION ?? "v20.20.2";
const includeNodeRuntime = process.env.SOCRATES_RUNTIME_INCLUDE_NODE !== "false";
const runtimeKind = process.env.SOCRATES_RUNTIME_KIND ?? "cli";
const runtimePlatformArch = process.env.SOCRATES_RUNTIME_PLATFORM_ARCH ?? `${process.platform}-${process.arch}`;

const nodePlatform = (() => {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported runtime packaging platform: ${process.platform}`);
})();

const nodeArch = (() => {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported runtime packaging architecture: ${process.arch}`);
})();

const nodePackageBase = `node-${nodeVersion}-${nodePlatform}-${nodeArch}`;
const nodeArchiveName = `${nodePackageBase}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
const nodeArchivePath = path.join(cacheDir, nodeArchiveName);
const nodeDownloadUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`;
const cliPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "cli", "package.json"), "utf8"));
const runtimeVersion = process.env.SOCRATES_RUNTIME_VERSION ?? process.env.GITHUB_REF_NAME?.replace(/^v/, "") ?? cliPackageJson.version;
const whisperNodeVersion = "1.0.22";
const whisperNodeCpuTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const { env, ...spawnOptions } = options;
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32" && command === pnpmCommand,
      ...spawnOptions,
      env: {
        ...process.env,
        ...env,
      },
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });

const pnpmMajorVersion = () => {
  const result = spawnSync(pnpmCommand, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32" && pnpmCommand.endsWith(".cmd"),
  });
  if (result.status !== 0) {
    return undefined;
  }
  const major = Number.parseInt(result.stdout.trim().split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : undefined;
};

const pnpmDeployArgs = (target) => {
  const major = pnpmMajorVersion();
  const modernPnpmDeployArgs =
    major !== undefined && major >= 10 ? ["--config.dangerouslyAllowAllBuilds=true"] : [];
  return [
    ...modernPnpmDeployArgs,
    "--filter",
    "@socrates/server",
    "deploy",
    ...(major !== undefined && major >= 10 ? ["--legacy"] : []),
    "--prod",
    target,
  ];
};

const copy = (source, target) => {
  fs.cpSync(source, target, { recursive: true, force: true, dereference: true });
};

const assertFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found at ${filePath}`);
  }
};

const isEnvironmentFileName = (name) => name === ".env" || name.startsWith(".env.");

const removePackagedEnvFiles = (target) => {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (isEnvironmentFileName(entry.name)) {
      fs.rmSync(entryPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      removePackagedEnvFiles(entryPath);
    }
  }
};

const removePackagedServerSelfReference = (serverRoot) => {
  for (const selfReference of [
    path.join(serverRoot, "node_modules", "@socrates", "server"),
    path.join(serverRoot, "node_modules", ".pnpm", "node_modules", "@socrates", "server"),
  ]) {
    fs.rmSync(selfReference, { recursive: true, force: true });
  }
};

const assertNoExternalRuntimeLinks = (target) => {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolvedTarget = fs.realpathSync(entryPath);
        const relativeTarget = path.relative(target, resolvedTarget);
        const pointsInsideRuntime =
          relativeTarget === "" ||
          (!path.isAbsolute(relativeTarget) && relativeTarget !== ".." && !relativeTarget.startsWith(`..${path.sep}`));
        if (!pointsInsideRuntime) {
          throw new Error(`Packaged runtime link escapes the runtime root: ${entryPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath);
      }
    }
  };
  visit(target);
};

const pruneUnusedLanceDbEmbeddingExtras = (serverRoot) => {
  const nodeModules = path.join(serverRoot, "node_modules");
  const directEntries = [
    path.join(nodeModules, "@huggingface"),
    path.join(nodeModules, "@img"),
    path.join(nodeModules, "onnxruntime-common"),
    path.join(nodeModules, "onnxruntime-node"),
    path.join(nodeModules, "onnxruntime-web"),
    path.join(nodeModules, "openai"),
    path.join(nodeModules, "sharp"),
  ];
  for (const entry of directEntries) {
    fs.rmSync(entry, { recursive: true, force: true });
  }

  const virtualStore = path.join(nodeModules, ".pnpm");
  if (!fs.existsSync(virtualStore)) {
    return;
  }
  const unusedPrefixes = [
    "@huggingface+transformers@",
    "@img+",
    "onnxruntime-common@",
    "onnxruntime-node@",
    "onnxruntime-web@",
    "openai@4.29.2",
    "sharp@",
  ];
  for (const entry of fs.readdirSync(virtualStore)) {
    if (unusedPrefixes.some((prefix) => entry.startsWith(prefix))) {
      fs.rmSync(path.join(virtualStore, entry), { recursive: true, force: true });
    }
  }
};

const exposePnpmHoistedDependencies = (target, hoistedNodeModulesOverride) => {
  const nodeModules = path.join(target, "node_modules");
  const hoistedNodeModules = hoistedNodeModulesOverride ?? path.join(nodeModules, ".pnpm", "node_modules");
  if (!fs.existsSync(hoistedNodeModules)) {
    return;
  }
  fs.mkdirSync(nodeModules, { recursive: true });
  for (const entry of fs.readdirSync(hoistedNodeModules)) {
    const source = path.join(hoistedNodeModules, entry);
    const destination = path.join(nodeModules, entry);
    if (entry.startsWith("@")) {
      fs.mkdirSync(destination, { recursive: true });
      for (const scopedEntry of fs.readdirSync(source)) {
        const scopedSource = path.join(source, scopedEntry);
        const scopedDestination = path.join(destination, scopedEntry);
        if (!fs.existsSync(scopedDestination)) {
          createPackageLink(scopedSource, scopedDestination);
        }
      }
      continue;
    }
    if (!fs.existsSync(destination)) {
      createPackageLink(source, destination);
    }
  }
};

const createPackageLink = (source, destination) => {
  if (process.platform === "win32") {
    copy(source, destination);
    return;
  }
  const relativeSource = path.relative(path.dirname(destination), source);
  fs.symlinkSync(relativeSource, destination, "dir");
};

const downloadFile = async (url, target) => {
  if (fs.existsSync(target)) {
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  }
  const tempTarget = `${target}.tmp`;
  const file = fs.createWriteStream(tempTarget);
  await new Promise((resolve, reject) => {
    response.body.pipeTo(
      new WritableStream({
        write(chunk) {
          file.write(Buffer.from(chunk));
        },
        close() {
          file.end(resolve);
        },
        abort(error) {
          file.destroy(error);
          reject(error);
        },
      }),
    ).catch(reject);
  });
  fs.renameSync(tempTarget, target);
};

const buildServerPackages = async () => {
  for (const packageName of [
    "@socrates/shared",
    "@socrates/contracts",
    "@socrates/workspace",
    "@socrates/providers",
    "@socrates/mcp",
    "@socrates/core",
    "@socrates/server",
  ]) {
    await run(pnpmCommand, ["--filter", packageName, "build"]);
  }
};

const assertPackagedServerDependencies = () => {
  for (const packageName of ["shared", "contracts", "workspace", "providers", "mcp", "core"]) {
    assertFile(
      path.join(runtimeDir, "server", "node_modules", "@socrates", packageName, "dist", "index.js"),
      `Packaged @socrates/${packageName} dist entry`,
    );
  }
  assertFile(
    path.join(runtimeDir, "server", "node_modules", "@fugood", "whisper.node", "package.json"),
    "Packaged Whisper Node adapter",
  );
  assertFile(
    path.join(runtimeDir, "server", "node_modules", "sherpa-onnx-node", "package.json"),
    "Packaged sherpa-onnx Node adapter",
  );
};

const assertWhisperPlatformLockCoverage = () => {
  const serverPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "server", "package.json"), "utf8"));
  if (serverPackageJson.dependencies?.["@fugood/whisper.node"] !== whisperNodeVersion) {
    throw new Error(`@fugood/whisper.node must remain exact-pinned to ${whisperNodeVersion}.`);
  }
  const lockfile = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  for (const target of whisperNodeCpuTargets) {
    const packageKey = `@fugood/node-whisper-${target}@${whisperNodeVersion}`;
    if (!lockfile.includes(packageKey)) {
      throw new Error(`Whisper native package is missing from pnpm-lock.yaml: ${packageKey}`);
    }
  }
};

const smokePackagedSpeechRuntime = async (nodeExecutable) => {
  await run(nodeExecutable, [
    path.join(runtimeScriptsRoot, "speech-native-smoke.mjs"),
    path.join(runtimeDir, "server"),
  ]);
};

const extractNodeRuntime = async (target) => {
  const extractDir = path.join(cacheDir, "node-extract", `${nodePackageBase}-${Date.now()}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${nodeArchivePath}' -DestinationPath '${extractDir}' -Force`], {
      cwd: repoRoot,
    });
  } else {
    await run("tar", ["-xzf", nodeArchivePath, "-C", extractDir], { cwd: repoRoot });
  }

  const extractedRoot = path.join(extractDir, nodePackageBase);
  if (!fs.existsSync(extractedRoot)) {
    throw new Error(`Extracted Node runtime was not found at ${extractedRoot}`);
  }
  copy(extractedRoot, target);
};

const bundledNodeExecutable = (nodeRoot) => path.join(nodeRoot, process.platform === "win32" ? "node.exe" : "bin/node");

const bundledNpmCli = (nodeRoot) => {
  const candidates =
    process.platform === "win32"
      ? [path.join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")]
      : [path.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!cli) {
    throw new Error(`Bundled npm CLI was not found under ${nodeRoot}`);
  }
  return cli;
};

const rebuildPackagedNativeServerDependencies = async () => {
  if (!includeNodeRuntime) {
    return;
  }
  const nodeRoot = path.join(runtimeDir, "node");
  const nodeExecutable = bundledNodeExecutable(nodeRoot);
  assertFile(nodeExecutable, "Bundled Node executable");

  const serverRoot = path.join(runtimeDir, "server");
  const sqlitePackageRoot = fs.realpathSync(path.join(serverRoot, "node_modules", "better-sqlite3"));
  fs.rmSync(path.join(sqlitePackageRoot, "build"), { recursive: true, force: true });
  await run(nodeExecutable, [bundledNpmCli(nodeRoot), "rebuild", "--foreground-scripts", "--ignore-scripts=false", "--workspaces=false", "--prefix", sqlitePackageRoot], {
    cwd: sqlitePackageRoot,
    env: {
      PATH: `${path.dirname(nodeExecutable)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
};

assertWhisperPlatformLockCoverage();

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

await buildServerPackages();
await run(pnpmCommand, ["--filter", "web", "build"], {
  env: {
    NEXT_PUBLIC_SOCRATES_API_BASE_URL: "http://127.0.0.1:4000",
    SOCRATES_API_BASE_URL: "http://127.0.0.1:4000",
  },
});

const packagedServerRoot = path.join(runtimeDir, "server");
await run(pnpmCommand, pnpmDeployArgs(packagedServerRoot));
removePackagedServerSelfReference(packagedServerRoot);
removePackagedEnvFiles(packagedServerRoot);
pruneUnusedLanceDbEmbeddingExtras(packagedServerRoot);
exposePnpmHoistedDependencies(packagedServerRoot);
assertPackagedServerDependencies();

copy(path.join(repoRoot, "apps", "server", "dist"), path.join(runtimeDir, "server", "dist"));
copy(path.join(repoRoot, "apps", "server", "drizzle"), path.join(runtimeDir, "server", "drizzle"));

const standaloneRoot = path.join(repoRoot, "apps", "web", ".next", "standalone");
const standaloneAppRoot = path.join(standaloneRoot, "apps", "web");
if (!fs.existsSync(path.join(standaloneAppRoot, "server.js"))) {
  throw new Error(`Next standalone server was not found at ${path.join(standaloneAppRoot, "server.js")}`);
}
copy(standaloneRoot, path.join(runtimeDir, "web"));
copy(path.join(repoRoot, "apps", "web", ".next", "static"), path.join(runtimeDir, "web", "apps", "web", ".next", "static"));
exposePnpmHoistedDependencies(path.join(runtimeDir, "web"));
exposePnpmHoistedDependencies(
  path.join(runtimeDir, "web", "apps", "web"),
  path.join(runtimeDir, "web", "node_modules", ".pnpm", "node_modules"),
);

const publicDir = path.join(repoRoot, "apps", "web", "public");
if (fs.existsSync(publicDir)) {
  copy(publicDir, path.join(runtimeDir, "web", "apps", "web", "public"));
}

copy(path.join(runtimeScriptsRoot, "launcher.mjs"), path.join(runtimeDir, "launcher.mjs"));

if (includeNodeRuntime) {
  await downloadFile(nodeDownloadUrl, nodeArchivePath);
  await extractNodeRuntime(path.join(runtimeDir, "node"));
  await rebuildPackagedNativeServerDependencies();
}

await smokePackagedSpeechRuntime(
  includeNodeRuntime ? bundledNodeExecutable(path.join(runtimeDir, "node")) : process.execPath,
);

removePackagedEnvFiles(runtimeDir);
assertNoExternalRuntimeLinks(packagedServerRoot);

fs.writeFileSync(path.join(runtimeDir, ".gitkeep"), "");

fs.writeFileSync(
  path.join(runtimeDir, "manifest.json"),
  `${JSON.stringify(
    {
      version: runtimeVersion,
      runtimeKind,
      platformArch: runtimePlatformArch,
      ...(includeNodeRuntime ? { node: process.platform === "win32" ? "node/node.exe" : "node/bin/node" } : {}),
      nodeVersion,
      launcher: "launcher.mjs",
      serverEntry: "server/dist/index.js",
      webEntry: "web/apps/web/server.js",
      speechRuntimes: {
        stt: `@fugood/whisper.node@${whisperNodeVersion}`,
        tts: "sherpa-onnx-node@1.13.4",
      },
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Prepared Socrates npm runtime at ${runtimeDir}`);
