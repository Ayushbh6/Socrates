import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const runtimeDir = path.resolve(process.argv[2] ?? "");
if (!runtimeDir || !fs.existsSync(path.join(runtimeDir, "manifest.json"))) {
  throw new Error("Usage: node packaged-runtime-smoke.mjs <runtime-directory>");
}

const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "manifest.json"), "utf8"));
const nodeExecutable = path.join(runtimeDir, manifest.node ?? (process.platform === "win32" ? "node/node.exe" : "node/bin/node"));
const launcher = path.join(runtimeDir, manifest.launcher ?? "launcher.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-packaged-smoke-"));
const socratesHome = path.resolve(root, "home");
const dbPath = path.resolve(root, "state", "socrates.sqlite");
fs.mkdirSync(socratesHome, { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

for (const resolved of [socratesHome, dbPath]) {
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`Smoke-test state escaped its temporary root: ${resolved}`);
  }
}
console.log(`Packaged runtime smoke state: SOCRATES_HOME=${socratesHome} SOCRATES_DB_PATH=${dbPath}`);

const [backendPort, webPort] = await Promise.all([freePort(), freePort()]);
const env = { ...process.env };
for (const name of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"]) {
  delete env[name];
}
Object.assign(env, {
  SOCRATES_HOME: socratesHome,
  SOCRATES_DB_PATH: dbPath,
  SOCRATES_BACKEND_PORT: String(backendPort),
  SOCRATES_WEB_PORT: String(webPort),
  SOCRATES_RUNTIME_DIR: runtimeDir,
});

const child = spawn(nodeExecutable, [launcher], {
  cwd: runtimeDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-48_000);
  });
}

try {
  await waitFor(() => request(backendPort, "/health"), (response) => response.statusCode === 200, 180_000, "backend health");
  await waitFor(() => request(webPort, "/welcome"), (response) => response.statusCode === 200, 60_000, "Classic welcome page");
  const flowRoute = await request(backendPort, "/api/v2/capabilities");
  if (flowRoute.statusCode !== 404) {
    throw new Error(`Stable runtime exposed /api/v2/capabilities with status ${flowRoute.statusCode}.`);
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Packaged runtime did not create its database at ${dbPath}.`);
  }
  await smokePackagedTerminal(runtimeDir, nodeExecutable, root, env);
  console.log(`Packaged runtime smoke passed on ${process.platform}/${process.arch}.`);
} catch (error) {
  const tail = output.trim().split(/\r?\n/).slice(-80).join("\n");
  throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\nRuntime output:\n${tail}` : ""}`);
} finally {
  await stopChild(child);
  fs.rmSync(root, { recursive: true, force: true });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 2_000 }, (response) => {
      response.resume();
      response.once("end", () => resolve({ statusCode: response.statusCode ?? 0 }));
    });
    req.once("timeout", () => req.destroy(new Error("request timed out")));
    req.once("error", reject);
  });
}

async function waitFor(operation, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await operation();
      if (predicate(result)) return result;
    } catch {
      // Startup races are expected until the sidecar is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function stopChild(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => processHandle.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(processHandle.pid), "/t", "/f"], { stdio: "ignore" });
  } else if (!exited) {
    processHandle.kill("SIGKILL");
  }
}

async function smokePackagedTerminal(runtimeRoot, nodePath, stateRoot, runtimeEnv) {
  const supervisorEntry = path.join(runtimeRoot, "server", "dist", "ws", "terminalSupervisorProcess.js");
  const hostEntry = path.join(runtimeRoot, "server", "dist", "ws", "terminalHostProcess.js");
  for (const entry of [supervisorEntry, hostEntry]) {
    if (!fs.existsSync(entry)) throw new Error(`Packaged Terminal entry is missing: ${entry}`);
  }

  const workspace = path.join(stateRoot, "terminal-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\socrates-packaged-smoke-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `socrates-packaged-${process.pid}-${Date.now()}.sock`);
  const supervisor = spawn(nodePath, [supervisorEntry, socketPath], {
    cwd: runtimeRoot,
    env: { ...runtimeEnv, SOCRATES_TERMINAL_SUPERVISOR_IDLE_MS: "60000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let supervisorOutput = "";
  for (const stream of [supervisor.stdout, supervisor.stderr]) {
    stream.on("data", (chunk) => {
      supervisorOutput = `${supervisorOutput}${chunk.toString()}`.slice(-16_000);
    });
  }

  const terminalId = "packaged-smoke";
  let processId;
  try {
    await waitFor(
      () => supervisorRequest(socketPath, { id: "health", method: "health" }),
      (response) => response.ok === true,
      10_000,
      "packaged Terminal supervisor",
    );
    const command = process.platform === "win32"
      ? "Write-Output packaged-terminal-ok; Start-Sleep -Milliseconds 750"
      : "printf 'packaged-terminal-ok\\n'; sleep 0.75";
    const started = await supervisorRequest(socketPath, {
      id: "start",
      method: "start",
      terminalId,
      workspacePath: workspace,
      input: { operation: "start", command, name: "packaged-smoke", timeoutMs: 10_000, charLimit: 16_000 },
    });
    if (!started.ok || !started.output?.process?.processId) {
      throw new Error(`Packaged Terminal failed to start: ${JSON.stringify(started.error ?? started)}`);
    }
    processId = started.output.process.processId;
    await waitFor(
      () => supervisorRequest(socketPath, {
        id: "output",
        method: "output",
        terminalId,
        processId,
        input: { operation: "output", processId, charLimit: 16_000 },
      }),
      (response) => response.ok === true && response.output?.stdout?.includes("packaged-terminal-ok"),
      10_000,
      "packaged Terminal command output",
    );
    console.log("Packaged Terminal supervisor smoke passed.");
  } catch (error) {
    const tail = supervisorOutput.trim().split(/\r?\n/).slice(-40).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\nTerminal supervisor output:\n${tail}` : ""}`);
  } finally {
    if (processId) {
      await supervisorRequest(socketPath, { id: "stop", method: "stop", terminalId, processId }).catch(() => undefined);
    }
    await supervisorRequest(socketPath, { id: "shutdown", method: "shutdown" }).catch(() => undefined);
    await stopChild(supervisor);
    if (process.platform !== "win32" && fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  }
}

function supervisorRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("error", reject);
    socket.setTimeout(5_000, () => socket.destroy(new Error("Terminal supervisor request timed out.")));
  });
}
