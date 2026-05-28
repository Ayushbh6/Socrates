import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const runtimeDir = path.resolve(process.env.SOCRATES_RUNTIME_OUTPUT_DIR ?? path.join(desktopRoot, "runtime"));
const cacheDir = path.join(desktopRoot, ".cache");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeVersion = process.env.SOCRATES_DESKTOP_NODE_VERSION ?? "v20.20.2";
const includeNodeRuntime = process.env.SOCRATES_RUNTIME_INCLUDE_NODE !== "false";
const runtimeKind = process.env.SOCRATES_RUNTIME_KIND ?? (includeNodeRuntime ? "desktop" : "cli");
const runtimePlatformArch = process.env.SOCRATES_RUNTIME_PLATFORM_ARCH ?? `${process.platform}-${process.arch}`;

const nodePlatform = (() => {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported desktop packaging platform: ${process.platform}`);
})();

const nodeArch = (() => {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported desktop packaging architecture: ${process.arch}`);
})();

const nodePackageBase = `node-${nodeVersion}-${nodePlatform}-${nodeArch}`;
const nodeArchiveName = `${nodePackageBase}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
const nodeArchivePath = path.join(cacheDir, nodeArchiveName);
const nodeDownloadUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`;
const cliPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "cli", "package.json"), "utf8"));
const runtimeVersion = process.env.SOCRATES_RUNTIME_VERSION ?? process.env.GITHUB_REF_NAME?.replace(/^v/, "") ?? cliPackageJson.version;

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

const copy = (source, target) => {
  fs.cpSync(source, target, { recursive: true, force: true, dereference: true });
};

const assertFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found at ${filePath}`);
  }
};

const removePackagedEnvFiles = (target) => {
  for (const entry of fs.readdirSync(target)) {
    if (entry === ".env" || entry.startsWith(".env.")) {
      fs.rmSync(path.join(target, entry), { recursive: true, force: true });
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

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

await buildServerPackages();
await run(pnpmCommand, ["--filter", "web", "build"], {
  env: {
    NEXT_PUBLIC_SOCRATES_API_BASE_URL: "http://127.0.0.1:4000",
    SOCRATES_API_BASE_URL: "http://127.0.0.1:4000",
  },
});

await run(pnpmCommand, ["--filter", "@socrates/server", "deploy", "--prod", path.join(runtimeDir, "server")]);
removePackagedEnvFiles(path.join(runtimeDir, "server"));
exposePnpmHoistedDependencies(path.join(runtimeDir, "server"));
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

copy(path.join(desktopRoot, "scripts", "launcher.mjs"), path.join(runtimeDir, "launcher.mjs"));

if (includeNodeRuntime) {
  await downloadFile(nodeDownloadUrl, nodeArchivePath);
  await extractNodeRuntime(path.join(runtimeDir, "node"));
}

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
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Prepared Socrates desktop runtime at ${runtimeDir}`);
