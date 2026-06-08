# Socrates CLI

Run Socrates as a local-first web app:

```bash
npx @socrates-ai/cli
```

The CLI downloads the matching runtime bundle from GitHub Releases, stores it under `~/.Socrates/runtimes/`, starts local services on `127.0.0.1`, and opens the browser.

Force a fresh runtime download/extract with:

```bash
npx @socrates-ai/cli --reset-runtime
```

When testing from inside this repo's `apps/cli` package, run the local bin with
Node instead of `npx`. npm can resolve the current package as local but not link
its own bin into `npx`'s PATH from inside the package directory.

macOS/Linux:

```bash
node bin/socrates.mjs --reset-runtime
```

Windows PowerShell:

```powershell
node .\bin\socrates.mjs --reset-runtime
```
