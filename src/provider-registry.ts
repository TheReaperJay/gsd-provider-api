/**
 * GSD Provider Registry — shared registration point for GSD provider plugins.
 */

import type { GsdProviderInfo, GsdProviderDeps } from "./types.js";

const REGISTRY_KEY = Symbol.for("gsd-provider-registry");
const DEPS_KEY = Symbol.for("gsd-provider-deps");

function getRegistry(): GsdProviderInfo[] {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = [];
  return g[REGISTRY_KEY] as GsdProviderInfo[];
}

function getStoredDeps(): { value: GsdProviderDeps | null; waiters: Array<(deps: GsdProviderDeps) => void> } {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[DEPS_KEY]) g[DEPS_KEY] = { value: null, waiters: [] };
  return g[DEPS_KEY] as { value: GsdProviderDeps | null; waiters: Array<(deps: GsdProviderDeps) => void> };
}

export function registerProviderInfo(info: GsdProviderInfo): void {
  const registry = getRegistry();
  const existing = registry.findIndex(p => p.id === info.id);
  if (existing >= 0) registry[existing] = info;
  else registry.push(info);
}

export function getRegisteredProviderInfos(): readonly GsdProviderInfo[] {
  return getRegistry();
}

export function setProviderDeps(deps: GsdProviderDeps): void {
  const stored = getStoredDeps();
  stored.value = deps;
  const waiters = stored.waiters.splice(0, stored.waiters.length);
  for (const resolve of waiters) resolve(deps);
}

export function clearProviderDeps(): void {
  getStoredDeps().value = null;
}

export function getProviderDeps(): GsdProviderDeps | null {
  return getStoredDeps().value;
}

export async function waitForProviderDeps(timeoutMs = 3000): Promise<GsdProviderDeps | null> {
  const stored = getStoredDeps();
  if (stored.value) return stored.value;

  return await new Promise<GsdProviderDeps | null>((resolve) => {
    const timer = setTimeout(() => {
      const idx = stored.waiters.indexOf(waiter);
      if (idx >= 0) stored.waiters.splice(idx, 1);
      resolve(null);
    }, timeoutMs);

    const waiter = (deps: GsdProviderDeps) => {
      clearTimeout(timer);
      resolve(deps);
    };

    stored.waiters.push(waiter);
  });
}

export function removeProviderInfo(id: string): boolean {
  const registry = getRegistry();
  const idx = registry.findIndex(p => p.id === id);
  if (idx >= 0) {
    registry.splice(idx, 1);
    return true;
  }
  return false;
}

export function clearRegisteredProviderInfos(): void {
  getRegistry().splice(0, getRegistry().length);
}
