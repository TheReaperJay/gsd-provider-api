/**
 * Self-contained onboarding for GSD provider extensions.
 *
 * The library owns @clack/prompts and picocolors — extensions do not need
 * to install them. Three tiers of behavior:
 *
 * 1. Custom `onboard()` on provider info → full control, receives clack/pico
 * 2. `onboarding.kind === "externalCli"` → default CLI flow: spinner + check()
 * 3. Neither → generic install message
 */

import type { GsdProviderInfo } from "./types.js";
import type pico from "picocolors";

export async function runPluginOnboarding(
  pp: GsdProviderInfo,
): Promise<{ ok: boolean }> {
  const [p, picoModule] = await Promise.all([
    import("@clack/prompts"),
    import("picocolors"),
  ]);
  const pc: typeof pico = (picoModule as { default?: typeof pico }).default ?? picoModule as typeof pico;

  if (pp.onboard) {
    const result = await pp.onboard(p, pc);
    return { ok: result };
  }

  if (pp.onboarding?.kind === "externalCli") {
    const s = p.spinner();
    s.start(`Checking ${pp.displayName}...`);
    const result = pp.onboarding.check();
    if (result.ok) {
      s.stop(`${pc.green(pp.displayName)} authenticated${result.email ? ` as ${result.email}` : ""}`);
      return { ok: true };
    }
    s.stop(`${pp.displayName}: ${result.reason}`);
    p.log.warn(result.instruction);
    return { ok: false };
  }

  p.log.info(`${pc.green(pp.displayName)} installed. See extension instructions for further steps.`);
  if (pp.models.length > 0) {
    p.log.info(`${pc.dim("If this is a provider, update your default with /provider.")}`);
  }

  return { ok: true };
}
