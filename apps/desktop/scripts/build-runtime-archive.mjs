import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const outputDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "release-artifacts"));
const nodeCommand = process.execPath;

const platformArch = process.env.SOCRATES_RUNTIME_PLATFORM_ARCH ?? `${process.platform}-${process.arch}`;
const runtimeDir = path.join(desktopRoot, ".cache", "cli-runtime", platformArch);
const archiveName = `socrates-runtime-${platformArch}.zip`;
const archivePath = path.join(outputDir, archiveName);

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
      env: {
        ...process.env,
        ...options.env,
      },
    });
    const capture = (chunk, stream) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-24000);
      stream.write(chunk);
    };
    child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk) => capture(chunk, process.stderr));
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
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

await run(nodeCommand, [path.join(desktopRoot, "scripts", "build-runtime.mjs")], {
  env: {
    SOCRATES_RUNTIME_OUTPUT_DIR: runtimeDir,
    SOCRATES_RUNTIME_INCLUDE_NODE: "false",
    SOCRATES_RUNTIME_PLATFORM_ARCH: platformArch,
  },
});

fs.rmSync(archivePath, { force: true });

if (process.platform === "win32") {
  await run("tar.exe", ["-a", "-cf", archivePath, "-C", runtimeDir, "."]);
} else {
  await run("zip", ["-qr", archivePath, "."], { cwd: runtimeDir });
}

const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "manifest.json"), "utf8"));
if (manifest.runtimeKind !== "cli" || manifest.node) {
  throw new Error("Runtime archive manifest is not a CLI runtime.");
}

const sizeMb = Math.round((fs.statSync(archivePath).size / 1024 / 1024) * 10) / 10;
console.log(`Created ${archivePath} (${sizeMb} MB) on ${os.platform()}/${os.arch()}`);
