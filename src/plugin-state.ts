/**
 * Plugin-owned runtime state — read/write .state.json in the plugin's directory.
 *
 * Each plugin stores its own state file. gsd-provider-api surfaces the
 * accessors; the plugin's pluginDir determines where the file lives.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginRuntimeState } from "./types.js";

const STATE_FILENAME = ".state.json";

function defaultState(): PluginRuntimeState {
  return { onboardingChecked: false, onboardingPassed: false };
}

function normalizePluginDir(pluginDir: string): string | null {
  if (typeof pluginDir !== "string") return null;
  const trimmed = pluginDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Read the plugin's runtime state from its own directory. Returns defaults if no state file exists. */
export function readPluginState(pluginDir: string): PluginRuntimeState {
  const normalizedDir = normalizePluginDir(pluginDir);
  if (!normalizedDir) return defaultState();

  try {
    const raw = readFileSync(join(normalizedDir, STATE_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as Partial<PluginRuntimeState>;
    return {
      onboardingChecked: parsed.onboardingChecked === true,
      onboardingPassed: parsed.onboardingPassed === true,
    };
  } catch {
    return defaultState();
  }
}

/** Write the plugin's runtime state to its own directory. Merges with existing state. No-op for invalid pluginDir input. */
export function writePluginState(pluginDir: string, update: Partial<PluginRuntimeState>): void {
  const normalizedDir = normalizePluginDir(pluginDir);
  if (!normalizedDir) return;

  const current = readPluginState(pluginDir);
  const merged: PluginRuntimeState = { ...current, ...update };
  mkdirSync(normalizedDir, { recursive: true });
  writeFileSync(join(normalizedDir, STATE_FILENAME), JSON.stringify(merged, null, 2) + "\n", "utf-8");
}
