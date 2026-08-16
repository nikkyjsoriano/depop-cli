/** `depop logout` — delete the stored credential. */
import type { CliContext } from "../context.ts";
import { ui } from "../output.ts";

export function logout(ctx: CliContext): number {
  if (ctx.store.delete()) ui.success("Removed the stored Depop credential.");
  else ui.warn("No stored credential — you're already logged out.");
  return 0;
}
