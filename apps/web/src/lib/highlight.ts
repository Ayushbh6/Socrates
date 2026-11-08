import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** Code coloured by language for the tool cards and answers; the colours are theme tokens (`--hl-*` in styles.css). */
const LANGS = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, python, ruby, rust, scss, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);
const ALIASES: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", sh: "bash", shell: "bash", zsh: "bash", console: "bash", py: "python", rb: "ruby", rs: "rust", yml: "yaml", html: "xml", toml: "ini", jsonl: "json", jsonc: "json", "c++": "cpp", cs: "csharp", kt: "kotlin", md: "markdown", docker: "dockerfile", make: "makefile" };

/** Past this size code is shown plain: colouring it would cost more than it helps. */
const MAX_CHARS = 60_000;

/** The code as highlighted HTML (escaped by highlight.js), or null for an unknown language or text too long. */
export function highlight(code: string, language: string | null | undefined): string | null {
  if (!language || code.length > MAX_CHARS) return null;
  const name = ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  if (!hljs.getLanguage(name)) return null;
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
