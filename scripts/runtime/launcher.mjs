import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runtimeDir =
  path.resolve(process.env.SOCRATES_RUNTIME_DIR ?? path.dirname(fileURLToPath(import.meta.url)));
const backendPort = Number(process.env.SOCRATES_BACKEND_PORT ?? 4100);
const webPort = Number(process.env.SOCRATES_WEB_PORT ?? 3100);
const host = "127.0.0.1";
const socratesHome = process.env.SOCRATES_HOME ?? path.join(os.homedir(), ".Socrates");
const children = [];

const manifestPath = path.join(runtimeDir, "manifest.json");
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
const bundledNode =
  typeof manifest.node === "string" ? path.join(runtimeDir, manifest.node) : undefined;
const nodeExecutable = bundledNode && fs.existsSync(bundledNode) ? bundledNode : process.execPath;
const serverEntry = path.join(runtimeDir, "server", "dist", "index.js");
const webEntry = path.join(runtimeDir, "web", "apps", "web", "server.js");
const webCwd = path.dirname(webEntry);

const assertFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found at ${filePath}`);
  }
};

const waitForHttp = (port, pathname, label, timeoutMs = 180_000) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const request = http.get({ host, port, path: pathname, timeout: 1000 }, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`${label} did not become ready on ${host}:${port}${pathname}`));
          return;
        }
        setTimeout(check, 500);
      });
      request.on("timeout", () => {
        request.destroy();
      });
    };
    check();
  });

const start = (label, args, options) => {
  const child = spawn(nodeExecutable, args, {
    stdio: ["ignore", "ignore", "pipe"],
    ...options,
    env: {
      ...process.env,
      NODE_ENV: "production",
      ...options.env,
    },
  });
  children.push(child);
  child.stderr.on("data", (chunk) => {
    console.error(`[${label}] ${chunk.toString().trimEnd()}`);
  });
  child.once("exit", (code, signal) => {
    if (signal || shuttingDown) {
      return;
    }
    console.error(`[${label}] exited with code ${code}`);
    shutdown(1);
  });
  return child;
};

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children.splice(0).reverse()) {
    child.kill();
  }
  process.exit(code);
};

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
process.once("SIGHUP", () => shutdown(0));

assertFile(serverEntry, "Socrates server entry");
assertFile(webEntry, "Socrates web entry");

start("server", [serverEntry], {
  cwd: path.join(runtimeDir, "server"),
  env: {
    HOST: host,
    PORT: String(backendPort),
    SOCRATES_HOME: socratesHome,
  },
});

await waitForHttp(backendPort, "/health", "Socrates server");

start("web", [webEntry], {
  cwd: webCwd,
  env: {
    HOSTNAME: host,
    PORT: String(webPort),
    SOCRATES_API_BASE_URL: `http://${host}:${backendPort}`,
    NEXT_PUBLIC_SOCRATES_API_BASE_URL: `http://${host}:${backendPort}`,
  },
});

await waitForHttp(webPort, "/welcome", "Socrates web");

console.log(
  JSON.stringify({
    type: "socrates.runtime.ready",
    webUrl: `http://${host}:${webPort}`,
    apiBaseUrl: `http://${host}:${backendPort}`,
    socratesHome,
  }),
);

setInterval(() => undefined, 60_000);
