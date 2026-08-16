/**
 * Dynamic command dispatch: `depop <command> [flags]`.
 *
 * Commands aren't hard-coded — they're the operations in `spec/openapi.yaml`
 * (operationId / x-depop-command). Flags are the operation's parameters; their
 * choices come from `schema.enum`. This is what makes the connector
 * "data, not code".
 */
import type { Definition, OperationView } from "@depop/core";
import { Connector } from "@depop/sdk";

import {
  buildArgsMap,
  flagFromParameter,
  flagFromWorkflowArg,
  parseArgs,
  type CliFlag,
} from "../args.ts";
import type { CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";

/** The CLI flags for an operation — its parameters, or a workflow's x-depop-args. */
function flagsFor(op: OperationView): CliFlag[] {
  if (op.isWorkflow) return (op.operation["x-depop-args"] ?? []).map(flagFromWorkflowArg);
  return op.parameters.map(flagFromParameter);
}

export async function runCommand(
  ctx: CliContext,
  commandName: string,
  commandArgs: string[],
  asJson: boolean,
): Promise<number> {
  const { definition } = ctx;

  const op = definition.spec.byCommand(commandName);
  if (!op) {
    ui.error(`Unknown command "${commandName}".`);
    printCommands(definition);
    return 1;
  }

  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    printOperationHelp(op);
    return 0;
  }

  // --dry-run is a workflow-wide flag, not a connector arg; pull it out first.
  const dryRun = commandArgs.includes("--dry-run");
  const opArgs = commandArgs.filter((a) => a !== "--dry-run");

  const flags = flagsFor(op);
  const parsed = parseArgs(opArgs, flags);

  // The first positional binds to the first declared flag, so
  // `depop search "t-shirt"` works without naming the flag.
  if (parsed.positionals.length > 0 && flags[0] && parsed.flags[flags[0].name] === undefined) {
    parsed.flags[flags[0].name] = parsed.positionals[0]!;
  }

  const args = buildArgsMap(parsed, flags);

  // Auth is only required to actually call the operation.
  const connector = Connector.load(definition, ctx.store);
  try {
    if (op.isWorkflow) {
      const result = await connector.runWorkflow(op, args, { dryRun });
      emit(result, asJson);
      return 0;
    }
    const result = await connector.call(op, args);
    emit(asJson ? result.data : (result.result ?? result.data), asJson);
    return 0;
  } finally {
    // Release the browser-proxy server (if used) so the process can exit.
    connector.close();
  }
}

// -- help rendering ---------------------------------------------------------

/** The spec's commands — used by `--help` and by the unknown-command error. */
export function printCommands(definition: Definition): void {
  const cmds = definition.spec.commands();
  ui.print("\nCommands:");
  for (const c of cmds) {
    ui.print(`  ${pc.bold((c.command ?? "").padEnd(16))} ${pc.dim(c.summary ?? "")}`);
  }
  ui.print("\nRun `depop <command> --help` for flags.");
}

function printOperationHelp(op: OperationView): void {
  ui.heading(`depop ${op.command}`);
  if (op.summary) ui.print(op.summary);
  if (op.description) ui.print(pc.dim(op.description));

  const flags = flagsFor(op);
  if (flags.length === 0) {
    ui.print("\nNo flags.");
    return;
  }
  ui.print("\nFlags:");
  for (const f of flags) ui.print("  " + flagHelp(f));
}

function flagHelp(f: CliFlag): string {
  const req = f.required ? pc.red(" (required)") : "";
  const repeat = f.multiple ? pc.dim(" [repeatable]") : "";
  const choiceHint = f.enum?.length ? pc.dim(` {${f.enum.join(", ")}}`) : "";
  const resolveHint = f.resolvable ? pc.dim(" [accepts id or label]") : "";
  // Show a flag's partners here, not just in the error you get for omitting them.
  const needsHint = f.requires?.length
    ? pc.dim(` [needs ${f.requires.map((r) => `--${r}`).join(" ")}]`)
    : "";
  return `--${f.name.padEnd(16)} ${pc.dim(f.description ?? "")}${choiceHint}${resolveHint}${needsHint}${req}${repeat}`;
}
