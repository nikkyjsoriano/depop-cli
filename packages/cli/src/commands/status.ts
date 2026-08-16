/** `depop status` — show whether the stored session is usable. */
import { isExpired, unixNow } from "@depop/core";

import type { CliContext } from "../context.ts";
import { emit, pc, ui } from "../output.ts";

export function status(ctx: CliContext, asJson: boolean): number {
  const cred = ctx.store.get();

  if (!cred) {
    // `logged_in: false` is a first-class answer, not an error: an agent checks
    // this before every run, so it exits 0 either way.
    if (asJson) emit({ logged_in: false }, true);
    else ui.info("Not logged in. Try: depop login");
    return 0;
  }

  const expired = isExpired(cred);
  const row = {
    logged_in: true,
    state: expired ? "expired" : "active",
    captured_at: cred.captured_at,
    expires_at: cred.expires_at ?? null,
    expires_in_seconds: cred.expires_at ? cred.expires_at - unixNow() : null,
    // null when the spec has no verify op (capture was never probed).
    verified: cred.validation ? cred.validation.ok : null,
    verified_at: cred.validation?.checked_at ?? null,
  };

  if (asJson) {
    emit(row, true);
    return 0;
  }

  const badge = expired ? pc.red("● expired") : pc.green("● active");
  // Only annotate when the session was actually probed; `null` means "not
  // checked", which we leave unannotated.
  const verified =
    row.verified === true
      ? pc.dim(" (verified)")
      : row.verified === false
        ? pc.red(" (verification failed)")
        : "";
  ui.heading("Depop session");
  ui.print(`  ${badge}  ${pc.bold(ctx.definition.manifest.display_name)}${verified}`);
  return 0;
}
