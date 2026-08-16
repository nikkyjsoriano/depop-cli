/**
 * Shared CLI dependencies, wired once and passed to every command.
 * Keeps commands free of construction logic and easy to test.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthBroker, FileStore, loadDefinition, type CredentialStore, type Definition } from "@depop/core";

export interface CliContext {
  definition: Definition;
  store: CredentialStore;
  broker: AuthBroker;
}

/**
 * The installed package root — the directory that ships `spec/` and `skills/`.
 * Found by walking up from this module, so it works both from the repo
 * (packages/cli/src/) and from the published bundle (dist/).
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("depop install is broken: cannot locate the bundled spec/ directory.");
}

export function createContext(): CliContext {
  const definition = loadDefinition(join(packageRoot(), "spec"));
  const store = new FileStore();
  const broker = new AuthBroker(store);
  return { definition, store, broker };
}
