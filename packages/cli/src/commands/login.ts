/** `depop login` — run the browser capture flow and persist auth. */
import type { Definition, PersistedCredential, ValidationResult } from "@depop/core";
import { Connector } from "@depop/sdk";

import type { CliContext } from "../context.ts";
import { ui } from "../output.ts";

export async function login(ctx: CliContext): Promise<number> {
  const { definition } = ctx;
  ui.heading(`Connecting ${definition.manifest.display_name}`);

  const credential = await ctx.broker.capture(
    definition,
    {
      onBootstrapUrl: (url) => ui.info(`If the browser didn't open, visit:\n  ${url}`),
      onStatus: (msg) => ui.info(msg),
    },
    { verify: verifyCredential },
  );

  ui.success(`Logged in to ${definition.manifest.display_name}.`);
  if (credential.expires_at) {
    ui.info(`Session expires ${new Date(credential.expires_at * 1000).toLocaleString()}.`);
  }
  ui.info("Try: depop --help");
  return 0;
}

/**
 * A liveness probe the broker runs after capture, if the spec declares
 * `x-depop-auth.verify`. It calls that operation through a real Connector (so
 * the browser proxy path is exercised) and returns the structured outcome.
 * Lives in the CLI so the broker stays SDK-free.
 */
async function verifyCredential(
  definition: Definition,
  credential: PersistedCredential,
): Promise<ValidationResult> {
  const connector = Connector.forCredential(definition, credential);
  try {
    return await connector.verify();
  } finally {
    connector.close();
  }
}
