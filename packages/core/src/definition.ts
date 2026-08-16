/**
 * The connector definition — the `spec/` directory that describes Depop.
 *
 *   auth.manifest.json            what the extension captures in the browser
 *   openapi.yaml | openapi.json   the API surface (OpenAPI 3.1 + x-depop-*)
 *   reference/                    bundled taxonomy JSON for x-depop-resolve
 *
 * This is the whole "connector is data, not code" seam: every CLI command, flag
 * and request comes from these files, so a Depop API change is a spec edit.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OpenApiSpec, parseOpenApi } from "./openapi-spec.ts";
import { validateManifest } from "./schemas/index.ts";
import type { AuthManifest } from "./types.ts";

export interface Definition {
  /** Directory the definition was loaded from — `reference/` paths resolve against it. */
  dir: string;
  manifest: AuthManifest;
  spec: OpenApiSpec;
}

export class DefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionError";
  }
}

const SPEC_FILES = ["openapi.yaml", "openapi.yml", "openapi.json"];

/** Load and validate the definition in `dir`. Throws if either file is missing. */
export function loadDefinition(dir: string): Definition {
  const manifestPath = join(dir, "auth.manifest.json");
  if (!existsSync(manifestPath)) {
    throw new DefinitionError(`no auth.manifest.json in ${dir} — the install looks incomplete.`);
  }
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));

  for (const file of SPEC_FILES) {
    const path = join(dir, file);
    if (existsSync(path)) {
      return { dir, manifest, spec: parseOpenApi(readFileSync(path, "utf8")) };
    }
  }
  throw new DefinitionError(`no openapi.yaml in ${dir} — the install looks incomplete.`);
}
