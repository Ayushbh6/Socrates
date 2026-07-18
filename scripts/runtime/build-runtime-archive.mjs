import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeScriptsRoot = path.join(repoRoot, "scripts", "runtime");
const runtimeCacheRoot = path.join(repoRoot, ".runtime-cache");
const outputDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "release-artifacts"));
const nodeCommand = process.execPath;

const platformArch = process.env.SOCRATES_RUNTIME_PLATFORM_ARCH ?? `${process.platform}-${process.arch}`;
const runtimeDir = path.join(runtimeCacheRoot, "cli-runtime", platformArch);
const archiveName = `socrates-runtime-${platformArch}.zip`;
const archivePath = path.join(outputDir, archiveName);

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const { env, maxOutputChars = 24000, streamOutput = true, ...spawnOptions } = options;
    let output = "";
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
      env: {
        ...process.env,
        ...env,
      },
    });
    const capture = (chunk, stream) => {
      const text = chunk.toString();
      output = `${output}${text}`;
      if (Number.isFinite(maxOutputChars)) {
        output = output.slice(-maxOutputChars);
      }
      if (streamOutput) {
        stream.write(chunk);
      }
    };
    child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk) => capture(chunk, process.stderr));
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        emitGithubError(output);
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });

const emitGithubError = (output) => {
  if (!process.env.GITHUB_ACTIONS) {
    return;
  }
  const tail = output.split(/\r?\n/).slice(-80).join("\n").trim();
  if (!tail) {
    return;
  }
  const escaped = tail.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.error(`::error title=Runtime archive command failed::${escaped}`);
};

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

await run(nodeCommand, [path.join(runtimeScriptsRoot, "build-runtime.mjs")], {
  env: {
    SOCRATES_RUNTIME_OUTPUT_DIR: runtimeDir,
    SOCRATES_RUNTIME_INCLUDE_NODE: "true",
    SOCRATES_RUNTIME_KIND: "cli",
    SOCRATES_RUNTIME_PLATFORM_ARCH: platformArch,
  },
});

const bundledNode = path.join(runtimeDir, "node", process.platform === "win32" ? "node.exe" : "bin/node");
await run(bundledNode, [path.join(runtimeScriptsRoot, "lancedb-smoke.mjs"), path.join(runtimeDir, "server")]);

fs.rmSync(archivePath, { force: true });

const archiveEntries = fs.readdirSync(runtimeDir).sort();
if (archiveEntries.length === 0) {
  throw new Error(`Runtime directory is empty: ${runtimeDir}`);
}

if (process.platform === "win32") {
  await run("tar.exe", ["-a", "-cf", archivePath, "-C", runtimeDir, ...archiveEntries]);
} else {
  await run("zip", ["-qr", archivePath, ...archiveEntries], { cwd: runtimeDir });
}

await assertArchiveLayout(archivePath);

const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "manifest.json"), "utf8"));
if (manifest.runtimeKind !== "cli" || typeof manifest.node !== "string") {
  throw new Error("Runtime archive manifest is not a bundled-node CLI runtime.");
}

const sizeMb = Math.round((fs.statSync(archivePath).size / 1024 / 1024) * 10) / 10;
console.log(`Created ${archivePath} (${sizeMb} MB) on ${os.platform()}/${os.arch()}`);

async function assertArchiveLayout(archivePath) {
  const entries = await listArchiveEntries(archivePath);
  const dotPrefixedEntries = entries.filter((entry) => entry === "./" || entry.startsWith("./"));
  if (dotPrefixedEntries.length > 0) {
    throw new Error(
      `Runtime archive entries must not be prefixed with "./"; found ${dotPrefixedEntries.slice(0, 5).join(", ")}`,
    );
  }

  const entrySet = new Set(entries);
  for (const requiredEntry of ["launcher.mjs", "manifest.json"]) {
    if (!entrySet.has(requiredEntry)) {
      const nestedMatches = entries.filter((entry) => entry.endsWith(`/${requiredEntry}`));
      throw new Error(
        `Runtime archive must contain ${requiredEntry} at the zip root.${
          nestedMatches.length > 0 ? ` Found nested entries: ${nestedMatches.slice(0, 5).join(", ")}` : ""
        }`,
      );
    }
  }

  const environmentEntries = entries.filter((entry) =>
    entry.split("/").some((segment) => segment === ".env" || segment.startsWith(".env.")),
  );
  if (environmentEntries.length > 0) {
    throw new Error(
      `Runtime archive must not contain environment files; found ${environmentEntries.slice(0, 5).join(", ")}`,
    );
  }
}

async function listArchiveEntries(archivePath) {
  const output =
    process.platform === "win32"
      ? await run("tar.exe", ["-tf", archivePath], { maxOutputChars: Number.POSITIVE_INFINITY, streamOutput: false })
      : await run("unzip", ["-Z1", archivePath], { maxOutputChars: Number.POSITIVE_INFINITY, streamOutput: false });
  return output
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}
