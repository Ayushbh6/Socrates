import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { LoadedSkill } from "@socrates/tools";
import { parse as parseYaml } from "yaml";

/**
 * Installed Skills (agent-harness.md, "Capability sources"): one folder per
 * Skill under the global Skills folder, each holding a SKILL.md whose YAML
 * frontmatter names and describes it and whose body is its instructions.
 */

export const SKILL_FILE = "SKILL.md";
export const SKILL_DESCRIPTION_MAX_CHARS = 1_024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface InstalledSkill {
  name: string;
  description: string;
  tags: string[];
  aliases: string[];
  dir: string;
}

/** Split a SKILL.md into its frontmatter and body, or explain why it cannot be read. */
export function parseSkillFile(text: string): { frontmatter: Record<string, unknown>; body: string } | { error: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^﻿/, ""));
  if (!match) return { error: "it does not start with a --- frontmatter block" };
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]!);
  } catch (error) {
    return { error: `its frontmatter is not valid YAML (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return { error: "its frontmatter is not a mapping" };
  return { frontmatter: frontmatter as Record<string, unknown>, body: text.slice(match[0].length + (text.startsWith("﻿") ? 1 : 0)) };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
}

/** Validate one Skill folder. Its frontmatter name must equal the folder name. */
export function readSkillMetadata(dir: string): InstalledSkill | { error: string } {
  const file = path.join(dir, SKILL_FILE);
  const parsed = parseSkillFile(readFileSync(file, "utf8"));
  if ("error" in parsed) return parsed;
  const { name, description } = parsed.frontmatter;
  if (typeof name !== "string" || !NAME.test(name)) return { error: "its frontmatter name is missing or not a plain identifier (letters, digits, - and _, at most 64)" };
  if (name !== path.basename(dir)) return { error: `its name ${name} does not match its folder ${path.basename(dir)}` };
  if (typeof description !== "string" || !description.trim()) return { error: "its frontmatter description is missing" };
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) return { error: `its description is longer than ${SKILL_DESCRIPTION_MAX_CHARS} characters` };
  return { name, description: description.trim(), tags: strings(parsed.frontmatter.tags), aliases: strings(parsed.frontmatter.aliases), dir };
}

/** Every valid Skill in the folder, by name, and a reason for each folder that was skipped. */
export function scanSkills(root: string): { skills: InstalledSkill[]; problems: string[] } {
  const skills: InstalledSkill[] = [];
  const problems: string[] = [];
  if (!existsSync(root)) return { skills, problems };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    if (!existsSync(path.join(dir, SKILL_FILE))) continue;
    try {
      const skill = readSkillMetadata(dir);
      if ("error" in skill) problems.push(`Skill ${entry.name} skipped: ${skill.error}.`);
      else skills.push(skill);
    } catch (error) {
      problems.push(`Skill ${entry.name} skipped: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/**
 * A Skill's full content, read fresh from disk on every load so an edited
 * Skill is detected by its digest. The version is a short hash of the whole
 * file; the instructions are the body after the frontmatter. Dependencies are
 * catalog names listed in the optional frontmatter `dependencies`.
 */
export function loadSkill(skill: InstalledSkill): LoadedSkill {
  const metadata = readSkillMetadata(skill.dir);
  if ("error" in metadata) throw new Error(`Skill ${skill.name} is invalid: ${metadata.error}.`);
  const text = readFileSync(path.join(skill.dir, SKILL_FILE), "utf8");
  const parsed = parseSkillFile(text);
  if ("error" in parsed) throw new Error(`Skill ${skill.name} can no longer be read: ${parsed.error}.`);
  return {
    version: createHash("sha256").update(text).digest("hex").slice(0, 12),
    instructions: parsed.body.trim(),
    resourceBase: { kind: "directory", path: realpathSync(skill.dir) },
    dependencies: strings(parsed.frontmatter.dependencies),
  };
}
