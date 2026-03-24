/**
 * GSD tool registry — shared tool definitions that any provider can consume.
 */

import type { GsdToolDef } from "./types.js";

const TOOL_REGISTRY_KEY = Symbol.for("gsd-tool-registry");

function getRegistry(): Map<string, GsdToolDef> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[TOOL_REGISTRY_KEY]) g[TOOL_REGISTRY_KEY] = new Map<string, GsdToolDef>();
  return g[TOOL_REGISTRY_KEY] as Map<string, GsdToolDef>;
}

export function registerGsdTool(def: GsdToolDef): void {
  getRegistry().set(def.name, def);
}

export function replaceGsdTools(defs: readonly GsdToolDef[]): void {
  const registry = getRegistry();
  registry.clear();
  for (const def of defs) registry.set(def.name, def);
}

export function clearGsdTools(): void {
  getRegistry().clear();
}

export function getGsdTools(): readonly GsdToolDef[] {
  return Array.from(getRegistry().values());
}
