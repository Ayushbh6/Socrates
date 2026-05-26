import fs from "node:fs";
import path from "node:path";

const [, , artifactDirArg, tagArg, repoArg] = process.argv;
const artifactDir = path.resolve(artifactDirArg ?? "release-artifacts");
const tag = tagArg ?? process.env.GITHUB_REF_NAME;
const repo = repoArg ?? process.env.GITHUB_REPOSITORY ?? "Ayushbh6/Socrates";

if (!tag) {
  throw new Error("Release tag is required.");
}

const version = tag.replace(/^v/, "");
const files = fs.readdirSync(artifactDir, { recursive: true }).map((file) => path.join(artifactDir, String(file)));
const fileByBaseName = new Map(files.filter((file) => fs.statSync(file).isFile()).map((file) => [path.basename(file), file]));

const readSignature = (artifactName) => {
  const signaturePath = fileByBaseName.get(`${artifactName}.sig`);
  if (!signaturePath) {
    throw new Error(`Missing updater signature for ${artifactName}`);
  }
  return fs.readFileSync(signaturePath, "utf8").trim();
};

const releaseUrl = (artifactName) =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifactName)}`;

const findArtifact = (predicate) => {
  const artifact = [...fileByBaseName.keys()].find(predicate);
  if (!artifact) {
    throw new Error("Required updater artifact was not found.");
  }
  return artifact;
};

const macUpdater = findArtifact((name) => name.endsWith(".app.tar.gz"));
const windowsUpdater = findArtifact((name) => name.endsWith("-setup.exe"));

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  notes: `Socrates ${tag}`,
  platforms: {
    "darwin-aarch64": {
      signature: readSignature(macUpdater),
      url: releaseUrl(macUpdater),
    },
    "windows-x86_64": {
      signature: readSignature(windowsUpdater),
      url: releaseUrl(windowsUpdater),
    },
  },
};

fs.writeFileSync(path.join(artifactDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
