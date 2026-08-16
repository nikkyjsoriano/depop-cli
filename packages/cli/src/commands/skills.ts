/**
 * `depop skills` — install the bundled agent playbooks as agent skills.
 *
 *   depop skills list              what's available
 *   depop skills add [<skill>…]    install (all of them by default)
 *   depop skills update            refresh everything installed here
 *
 * Install target: ./.claude/skills (project) by default; --global for
 * ~/.claude/skills; --dir <path> for anything else (e.g. .agents/skills).
 */
import { join } from "node:path";

import { UsageError } from "../args.ts";
import { packageRoot } from "../context.ts";
import { emit, pc, ui } from "../output.ts";
import {
  bundledSkills,
  installSkill,
  installTarget,
  installedSkills,
  type SkillInfo,
} from "../skill-files.ts";

/**
 * The session-model skill (login, `status --json`, exit codes) that every other
 * playbook builds on — so it rides along with every install.
 */
const ROOT_SKILL = "depop";

export function skills(rest: string[], asJson: boolean): number {
  const [sub, ...args] = rest;
  switch (sub) {
    case "list":
      return list(asJson);
    case "add":
      return add(args, asJson);
    case "update":
      return update(args, asJson);
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      return sub === undefined ? 1 : 0;
    default:
      throw new UsageError(`unknown skills subcommand "${sub}". Try: list, add, update.`);
  }
}

function available(): SkillInfo[] {
  return bundledSkills(join(packageRoot(), "skills"));
}

/** Resolve a skill name to the bundled skill, with the available names on a miss. */
function resolveSpec(spec: string): SkillInfo {
  const all = available();
  const found = all.find((s) => s.source === spec);
  if (!found) {
    throw new UsageError(`no skill "${spec}". Available: ${all.map((s) => s.source).join(", ")}`);
  }
  return found;
}

function list(asJson: boolean): number {
  const rows = available();

  if (asJson) {
    emit(rows.map(({ source, name, description }) => ({ source, name, description })), true);
    return 0;
  }

  ui.heading("Available skills");
  for (const s of rows) {
    ui.print(`  ${pc.bold(s.source.padEnd(12))} ${pc.dim(truncate(s.description, 80))}`);
  }
  ui.info("\nInstall: depop skills add [<skill>…]  [--global | --dir <path>]");
  return 0;
}

function add(args: string[], asJson: boolean): number {
  const { specs, flags } = splitFlags(args);
  const target = installTarget(flags);

  // No names = install everything. Otherwise the named skills, deduped, always
  // with the root skill so the agent has the session-model context.
  const toInstall = new Map<string, SkillInfo>();
  if (specs.length === 0) {
    for (const skill of available()) toInstall.set(skill.name, skill);
  } else {
    const root = resolveSpec(ROOT_SKILL);
    toInstall.set(root.name, root);
    for (const spec of specs) {
      const skill = resolveSpec(spec);
      toInstall.set(skill.name, skill);
    }
  }

  const installed = [...toInstall.values()].map((skill) => ({
    source: skill.source,
    name: skill.name,
    path: installSkill(skill, target),
  }));

  if (asJson) {
    emit(installed, true);
    return 0;
  }
  for (const s of installed) ui.success(`${s.name} → ${s.path}`);
  ui.info("Restart your agent session (or /reload skills) to pick them up.");
  return 0;
}

function update(args: string[], asJson: boolean): number {
  const { specs, flags } = splitFlags(args);
  if (specs.length > 0) {
    throw new UsageError(
      "skills update takes no positionals — it refreshes everything installed in the target",
    );
  }
  const target = installTarget(flags);

  const results: Array<{ source: string; name: string; status: "updated" | "missing-source" }> = [];
  for (const { provenance } of installedSkills(target)) {
    let skill: SkillInfo | undefined;
    try {
      skill = resolveSpec(provenance.source);
    } catch {
      skill = undefined;
    }
    if (!skill) {
      results.push({ source: provenance.source, name: provenance.source, status: "missing-source" });
      continue;
    }
    installSkill(skill, target);
    results.push({ source: skill.source, name: skill.name, status: "updated" });
  }

  if (asJson) {
    emit(results, true);
    return 0;
  }
  if (results.length === 0) {
    ui.info(`No depop-managed skills found in ${target}.`);
    return 0;
  }
  for (const r of results) {
    if (r.status === "updated") ui.success(`${r.name} refreshed`);
    else ui.warn(`${r.source}: no longer shipped — left as-is`);
  }
  return 0;
}

/** skills subcommands take only boolean --global and string --dir. */
function splitFlags(args: string[]): {
  specs: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const specs: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--global") {
      flags["global"] = true;
    } else if (tok === "--dir") {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new UsageError("--dir needs a path");
      flags["dir"] = next;
    } else if (tok.startsWith("--")) {
      throw new UsageError(`unknown flag ${tok}`);
    } else {
      specs.push(tok);
    }
  }
  return { specs, flags };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function printHelp(): void {
  ui.print(`depop skills — install the agent playbooks for this CLI.

Usage:
  depop skills list              List available skills
  depop skills add [<skill>…]    Install skills (all of them if none named)
  depop skills update            Refresh installed skills in the target

Target (for add/update):
  (default)        ./.claude/skills          project-level
  --global         ~/.claude/skills          all your projects
  --dir <path>     anywhere (e.g. .agents/skills)

Examples:
  depop skills add
  depop skills add search --global
  depop skills update`);
}
