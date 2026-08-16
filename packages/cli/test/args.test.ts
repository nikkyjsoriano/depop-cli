/**
 * Flag parsing and validation: the layer between argv and a connector call.
 *
 * The `requires` cases matter most. A flag whose partners are missing has no
 * route to the wire, so without this check the command would report success on
 * a request that quietly dropped what the user asked to change.
 */
import { expect, test } from "bun:test";

import type { WorkflowArg } from "@mastro/core";

import { buildArgsMap, flagFromWorkflowArg, parseArgs, UsageError } from "../src/args.ts";

/** Build the flag set the Depop update command declares, in miniature. */
function updateFlags() {
  const args: WorkflowArg[] = [
    { name: "id", required: true },
    { name: "price" },
    { name: "department", enum: ["menswear", "womenswear"] },
    { name: "type", requires: ["department"] },
    { name: "size", requires: ["department", "type"] },
    { name: "address-id", requires: ["parcel-size"] },
    { name: "parcel-size" },
    { name: "colour", multiple: true },
  ];
  return args.map(flagFromWorkflowArg);
}

function build(tokens: string[]): Record<string, unknown> {
  const flags = updateFlags();
  return buildArgsMap(parseArgs(tokens, flags), flags);
}

test("a flag with all its partners present is accepted", () => {
  const args = build(["--id", "1", "--department", "menswear", "--type", "tshirts", "--size", "M"]);
  expect(args).toEqual({ id: "1", department: "menswear", type: "tshirts", size: "M" });
});

test("a flag missing its partners is a usage error, not a silent drop", () => {
  expect(() => build(["--id", "1", "--size", "M"])).toThrow(UsageError);
  expect(() => build(["--id", "1", "--size", "M"])).toThrow(/--size needs --department, --type/);
});

test("only the absent partners are named", () => {
  expect(() => build(["--id", "1", "--department", "menswear", "--size", "M"])).toThrow(/needs --type/);
});

test("ship-from address on its own is rejected, it rides inside the shipping block", () => {
  expect(() => build(["--id", "1", "--address-id", "42475963"])).toThrow(/--address-id needs --parcel-size/);
  expect(build(["--id", "1", "--address-id", "42475963", "--parcel-size", "large"])).toEqual({
    id: "1",
    "address-id": "42475963",
    "parcel-size": "large",
  });
});

test("requires is only checked for flags the user actually passed", () => {
  expect(build(["--id", "1", "--price", "20"])).toEqual({ id: "1", price: "20" });
});

test("required and enum checks still apply", () => {
  expect(() => build(["--price", "20"])).toThrow(/missing required flag\(s\): --id/);
  expect(() => build(["--id", "1", "--department", "petwear"])).toThrow(/not allowed/);
});

test("a value flag left without a value is rejected, not sent as true", () => {
  // `--price --dry-run` reaches the parser as a bare `--price`, because the
  // global flags are stripped first. Sending `price: true` would be worse than
  // saying nothing.
  expect(() => build(["--id", "1", "--price"])).toThrow(/--price needs a value/);
  expect(() => build(["--id", "1", "--colour"])).toThrow(/--colour needs a value/);
  // The `=` form still carries a value that looks like a flag.
  expect(build(["--id", "1", "--price=--20"]).price).toBe("--20");
});

test("an undeclared flag is rejected, not quietly dropped", () => {
  // A typo'd flag never reaches the args map, so without this the command would
  // report success on an edit that silently left it out.
  expect(() => build(["--id", "1", "--descriptionn", "text"])).toThrow(/unknown flag\(s\): --descriptionn/);
  expect(() => build(["--id", "1", "--price", "20", "--nope", "x"])).toThrow(/--nope/);
});

test("a repeatable flag collects into a list", () => {
  expect(build(["--id", "1", "--colour", "navy", "--colour", "green"]).colour).toEqual(["navy", "green"]);
});
