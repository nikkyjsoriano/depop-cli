/**
 * depop CLI router.
 *
 *   depop login             capture a browser session
 *   depop logout            forget the stored session
 *   depop status            show whether the session is usable
 *   depop skills [...]      install the agent skills
 *   depop extension [...]   install the browser extension
 *   depop <command>         call the Depop API (search, me, list, update)
 *
 * Built-in verbs are handled directly; anything else is looked up in
 * `spec/openapi.yaml` and dispatched from that operation.
 */
import { createContext } from "./context.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { status } from "./commands/status.ts";
import { skills } from "./commands/skills.ts";
import { extension } from "./commands/extension.ts";
import { printCommands, runCommand } from "./commands/call.ts";
import { jsonMode, ui } from "./output.ts";
import { VERSION } from "./version.ts";

export async function run(argv: string[]): Promise<number> {
  const asJson = jsonMode(argv);
  const args = argv.filter((a) => a !== "--json");
  const [command, ...rest] = args;

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }

  // `--help` needs the spec loaded to list the API commands, so it falls
  // through to the context below rather than short-circuiting here.
  const ctx = createContext();

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    printCommands(ctx.definition);
    return command ? 0 : 1;
  }

  switch (command) {
    case "login":
      return login(ctx);
    case "logout":
      return logout(ctx);
    case "status":
      return status(ctx, asJson);
    case "skills":
      return skills(rest, asJson);
    case "extension":
      return extension(rest, asJson);
    default:
      // Treat `command` as an operation in the spec: `depop search ...`
      return runCommand(ctx, command, rest, asJson);
  }
}

/** Thin wrapper so `bin.ts` stays a one-liner and all errors map to exit codes. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Map any thrown value to a clean message + exit code. Every depop error type
 * (UsageError, NotAuthenticatedError, BrokerError, …) already carries an
 * actionable message, so we print that and exit. An error may opt into a
 * non-default exit code by exposing a numeric `exitCode` (UsageError → 2);
 * everything else exits 1. New error types work without editing this function.
 */
function handleError(err: unknown): number {
  ui.error(err instanceof Error ? err.message : String(err));
  return exitCodeOf(err);
}

function exitCodeOf(err: unknown): number {
  // A handled error is always a failure: honor a custom positive code (e.g.
  // UsageError's 2) but never let an `exitCode: 0` mask the failure as success.
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" && code > 0 ? code : 1;
}

function printHelp(): void {
  ui.print(`depop — drive your logged-in Depop session from the terminal.

Usage:
  depop login                   Capture your Depop session from the browser
  depop logout                  Forget the stored session
  depop status                  Show whether the session is usable
  depop skills add              Install the agent skills (.claude/skills)
  depop extension install       Install the browser extension (needed for login)
  depop <command> --help        Show a command's flags

Global flags:
  --json                         Machine-readable output (for agents)
  --version, -v                  Print version

Examples:
  depop login
  depop search "carhartt jacket" --conditions used_good --sizes M
  depop skills add --global`);
}
