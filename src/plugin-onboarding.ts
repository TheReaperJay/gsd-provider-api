/**
 * Default onboarding flow for plugin providers.
 *
 * If the provider declares a custom `onboard()` function, that is called and its
 * boolean result is wrapped in `{ ok }`.
 *
 * Otherwise the default fallback logs a generic installation message and returns ok.
 * The default does not assume the extension is a provider CLI, does not run auth
 * checks, and does not change the user's default provider.
 */

import type { GsdProviderInfo } from "./types.js";
import type { AuthStorage } from "@gsd/pi-coding-agent";

type ClackModule = typeof import("@clack/prompts");
type PicoModule = {
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  reset: (s: string) => string;
};

export async function runPluginOnboarding(
  pp: GsdProviderInfo,
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<{ ok: boolean }> {
  if (pp.onboard) {
    const result = await pp.onboard(p, pc, authStorage);
    return { ok: result };
  }

  p.log.info(`${pc.green(pp.displayName)} installed. See extension instructions for further steps.`);
  if (pp.models.length > 0) {
    p.log.info(`${pc.dim("If this is a provider, update your default with /provider.")}`);
  }

  return { ok: true };
}
