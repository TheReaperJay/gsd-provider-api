/**
 * Self-contained onboarding for GSD provider extensions.
 *
 * The library owns @clack/prompts and picocolors — extensions do not need
 * to install them. Three tiers of behavior:
 *
 * 1. Custom `onboard()` on provider info → full control, receives clack/pico
 * 2. `onboarding.kind === "externalCli"` → check + prompt to set default
 * 3. Neither → generic install message + prompt to set default
 *
 * When the check passes and the provider has models, the user is prompted
 * to set the provider as their default. Uses ctx.modelRegistry.find() to
 * look up the full Model object and pi.setModel() to persist the choice.
 */

import type { GsdProviderInfo } from "./types.js";
import type pico from "picocolors";

interface OnboardingPi {
  setModel(model: unknown, options?: { persist?: boolean }): Promise<boolean>;
}

interface OnboardingCtx {
  modelRegistry: { find(provider: string, modelId: string): unknown };
}

const DEFAULT_PROMPT_SEEN_KEY = Symbol.for("gsd-provider-api-default-prompt-seen");

function markDefaultPromptSeen(providerId: string): boolean {
  const runtime = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtime[DEFAULT_PROMPT_SEEN_KEY];
  const seen = existing instanceof Set ? existing as Set<string> : new Set<string>();
  if (!(existing instanceof Set)) runtime[DEFAULT_PROMPT_SEEN_KEY] = seen;
  if (seen.has(providerId)) return false;
  seen.add(providerId);
  return true;
}

function clearConfirmAnswerEchoLine(output: NodeJS.WriteStream = process.stdout): void {
  if (!output.isTTY) return;
  output.write("\u001B[1A");
  output.write("\u001B[2K");
  output.write("\u001B[1G");
}

async function promptSetDefault(
  pp: GsdProviderInfo,
  pi: OnboardingPi,
  ctx: OnboardingCtx,
  p: typeof import("@clack/prompts"),
  pc: typeof pico,
): Promise<void> {
  if (pp.models.length === 0) return;
  if (!markDefaultPromptSeen(pp.id)) return;

  const shouldSet = await p.confirm({
    message: `Set ${pp.displayName} as your default provider?`,
  });
  clearConfirmAnswerEchoLine();

  if (p.isCancel(shouldSet) || !shouldSet) return;

  let selectedModelId: string;

  if (pp.models.length === 1) {
    selectedModelId = pp.models[0].id;
  } else {
    const picked = await p.select({
      message: "Which model?",
      options: pp.models.map(m => ({
        value: m.id,
        label: m.displayName,
      })),
    });
    if (p.isCancel(picked)) return;
    selectedModelId = picked as string;
  }

  const model = ctx.modelRegistry.find(pp.id, selectedModelId);
  if (!model) {
    p.log.warn(`${pc.yellow("Could not find model in registry. Use /provider to set manually.")}`);
    return;
  }

  const success = await pi.setModel(model, { persist: true });
  if (success) {
    p.log.info(`${pc.green("Default set to")} ${pp.models.find(m => m.id === selectedModelId)?.displayName ?? selectedModelId}`);
  } else {
    p.log.warn(`${pc.yellow("Failed to set default model. Use /provider to set manually.")}`);
  }
}

export async function runPluginOnboarding(
  pp: GsdProviderInfo,
  pi: OnboardingPi,
  ctx: OnboardingCtx,
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
      await promptSetDefault(pp, pi, ctx, p, pc);
      return { ok: true };
    }
    s.stop(`${pp.displayName}: ${result.reason}`);
    p.log.warn(result.instruction);
    return { ok: false };
  }

  p.log.info(`${pc.green(pp.displayName)} installed.`);
  await promptSetDefault(pp, pi, ctx, p, pc);

  return { ok: true };
}
