import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const serverRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "apps", "server"));
const packageJsonPath = path.join(serverRoot, "package.json");
if (!fs.existsSync(packageJsonPath)) {
  throw new Error(`Packaged server package.json was not found at ${packageJsonPath}`);
}

const requireFromServer = createRequire(packageJsonPath);
const whisperPackageName = "@fugood/whisper.node";
const whisperPlatformPackageName = `@fugood/node-whisper-${process.platform}-${process.arch}`;

const whisperPackageEntry = requireFromServer.resolve(whisperPackageName);
const requireFromWhisperPackage = createRequire(whisperPackageEntry);
const whisperPlatformEntry = requireFromWhisperPackage.resolve(whisperPlatformPackageName);
if (!whisperPlatformEntry.endsWith(".node")) {
  throw new Error(`Whisper platform package did not resolve to a native addon: ${whisperPlatformEntry}`);
}

const whisper = requireFromServer(whisperPackageName);
const whisperNative = await whisper.loadWhisperModule();
if (typeof whisper.initWhisper !== "function" || typeof whisperNative.WhisperContext !== "function") {
  throw new Error("The packaged Whisper native binding did not expose its transcription runtime.");
}

const sherpa = requireFromServer("sherpa-onnx-node");
if (typeof sherpa.OfflineTts?.createAsync !== "function" || typeof sherpa.GenerationConfig !== "function") {
  throw new Error("The packaged sherpa-onnx native binding did not expose the Kokoro runtime.");
}

console.log(`Speech native runtime smoke passed (${whisperPlatformPackageName}, sherpa-onnx-node).`);
