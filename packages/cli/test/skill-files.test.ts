import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageError } from "../src/args.ts";
import {
  bundledSkills,
  installSkill,
  installTarget,
  installedSkills,
  readSkill,
} from "../src/skill-files.ts";

function makeSkillDir(root: string, name: string, frontmatter: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\nbody\n`);
  return dir;
}

describe("readSkill", () => {
  test("parses name and description from frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "depop-skills-"));
    const dir = makeSkillDir(root, "search", "name: depop-search\ndescription: Find things.");
    const skill = readSkill(dir, "search");
    expect(skill).toEqual({
      source: "search",
      name: "depop-search",
      description: "Find things.",
      dir,
    });
  });

  test("rejects a SKILL.md without frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "depop-skills-"));
    const dir = join(root, "bare");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "# no frontmatter\n");
    expect(() => readSkill(dir, "bare")).toThrow(UsageError);
  });

  test("rejects frontmatter missing a description", () => {
    const root = mkdtempSync(join(tmpdir(), "depop-skills-"));
    const dir = makeSkillDir(root, "incomplete", "name: only-a-name");
    expect(() => readSkill(dir, "incomplete")).toThrow(/name and description/);
  });
});

describe("bundledSkills", () => {
  test("lists skill directories, skips non-skill entries", () => {
    const skillsRoot = join(mkdtempSync(join(tmpdir(), "depop-pkg-")), "skills");
    makeSkillDir(skillsRoot, "search", "name: depop-p-search\ndescription: d");
    makeSkillDir(skillsRoot, "depop", "name: depop-p-depop\ndescription: d");
    mkdirSync(join(skillsRoot, "empty-dir")); // no SKILL.md → ignored
    writeFileSync(join(skillsRoot, "stray.md"), "not a skill");

    const found = bundledSkills(skillsRoot);
    expect(found.map((s) => s.source)).toEqual(["depop", "search"]);
  });

  test("returns [] when there is no skills directory", () => {
    expect(bundledSkills(join(tmpdir(), "no-skills-here-xyz"))).toEqual([]);
  });
});

describe("installSkill / installedSkills", () => {
  test("copies the directory under the skill name and stamps provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "depop-skills-"));
    const dir = makeSkillDir(root, "search", "name: depop-search\ndescription: d");
    writeFileSync(join(dir, "extra.json"), "{}"); // sidecar resources travel too
    const target = join(root, "out");

    const dest = installSkill(readSkill(dir, "search"), target);

    expect(dest).toBe(join(target, "depop-search"));
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("depop-search");
    expect(readFileSync(join(dest, "extra.json"), "utf8")).toBe("{}");

    const installed = installedSkills(target);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.provenance.source).toBe("search");
  });

  test("ignores unmanaged directories and corrupt sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "depop-skills-"));
    const target = join(root, "out");
    mkdirSync(join(target, "hand-written-skill"), { recursive: true });
    mkdirSync(join(target, "corrupt"), { recursive: true });
    writeFileSync(join(target, "corrupt", ".depop.json"), `{"source": 42}`);

    expect(installedSkills(target)).toEqual([]);
  });

  test("returns [] for a missing target", () => {
    expect(installedSkills(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });
});

describe("installTarget", () => {
  test("defaults to project .claude/skills", () => {
    expect(installTarget({})).toBe(join(process.cwd(), ".claude", "skills"));
  });

  test("--dir wins over --global", () => {
    expect(installTarget({ dir: "/tmp/x", global: true })).toBe("/tmp/x");
  });

  test("--global targets the home skills folder", () => {
    expect(installTarget({ global: true })).toContain(join(".claude", "skills"));
    expect(installTarget({ global: true })).not.toBe(join(process.cwd(), ".claude", "skills"));
  });

  test("rejects a boolean --dir", () => {
    expect(() => installTarget({ dir: true })).toThrow(UsageError);
  });
});
