/**
 * Shared contracts for GSD provider integration.
 *
 * These interfaces define the boundary between GSD orchestration and provider
 * plugins (claude-code, codex, gemini, etc.).
 */

import type { z } from "zod";
import type { spawnSync } from "node:child_process";

/** Matches core provider auth semantics exactly. */
export type ProviderAuthMode = "apiKey" | "oauth" | "externalCli" | "none";

/** Tool definition that any provider can wrap in its own format (SDK MCP, CLI schema, etc.). */
export interface GsdToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  execute: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/**
 * Shared deps contract for all GSD providers.
 *
 * Every provider receives these callbacks from GSD orchestration.
 */
export interface GsdProviderDeps {
  getSupervisorConfig: () => {
    soft_timeout_minutes?: number;
    idle_timeout_minutes?: number;
    hard_timeout_minutes?: number;
  };
  shouldBlockContextWrite: (
    toolName: string,
    inputPath: string,
    milestoneId: string | null,
    depthVerified: boolean,
  ) => { block: boolean; reason?: string };
  getMilestoneId: () => string | null;
  isDepthVerified: () => boolean;
  getIsUnitDone: () => boolean;
  onToolStart: (toolCallId: string) => void;
  onToolEnd: (toolCallId: string) => void;
  getBasePath: () => string;
  getUnitInfo: () => { unitType: string; unitId: string };
}

// ─── Usage ───────────────────────────────────────────────────────────────────

/** Token usage reported at the end of a provider stream. */
export interface GsdUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/** Discriminated union of all events emitted by a provider stream. */
export type GsdEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; detail?: string }
  | { type: "tool_end"; toolCallId: string }
  | { type: "completion"; usage: GsdUsage; stopReason: string }
  | { type: "error"; message: string; category: "rate_limit" | "auth" | "timeout" | "unknown"; retryAfterMs?: number };

/** Async iterable of GsdEvent — the return type of GsdProviderInfo.createStream. */
export type GsdEventStream = AsyncIterable<GsdEvent>;

// ─── Model ───────────────────────────────────────────────────────────────────

/** A model exposed by a GSD provider. */
export interface GsdModel {
  id: string;
  displayName: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

// ─── Stream Context ───────────────────────────────────────────────────────────

/** Context passed to GsdProviderInfo.createStream for each invocation. */
export interface GsdStreamContext {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  tools?: GsdToolDef[];
  supervisorConfig: {
    soft_timeout_minutes?: number;
    idle_timeout_minutes?: number;
    hard_timeout_minutes?: number;
  };
}

// ─── Provider Onboarding ─────────────────────────────────────────────────────

export type CliCheckResult =
  | { ok: true; email?: string; displayInfo?: string }
  | { ok: false; reason: string; instruction: string };

/** Optional default onboarding metadata for external CLI providers. */
export interface GsdProviderOnboardingExternalCli {
  kind: "externalCli";
  hint: string;
  check: (spawnFn?: typeof spawnSync) => CliCheckResult;
}

export type GsdProviderOnboarding = GsdProviderOnboardingExternalCli;

// ─── Provider Info ───────────────────────────────────────────────────────────

/** Static metadata + declarative stream factory for a GSD provider. */
export interface GsdProviderInfo {
  /** Provider ID — matches what's passed to pi.registerProvider(). */
  id: string;

  /** Human-readable name for onboarding UI. */
  displayName: string;

  /** Matches core auth mode semantics directly. */
  authMode: ProviderAuthMode;

  /** API ID used for registerProvider(). Defaults to provider id when omitted. */
  api?: string;

  /** Optional base URL override. Defaults to `${id}:`. */
  baseUrl?: string;

  /** Optional apiKey env/config string for apiKey-mode providers. */
  apiKey?: string;

  /** Optional default onboarding behavior. */
  onboarding?: GsdProviderOnboarding;

  /** Default model ID to set after successful onboarding. */
  defaultModel?: string;

  /** Models available from this provider. */
  models: GsdModel[];

  /** Create a GSD-native event stream for the given context and deps. */
  createStream: (context: GsdStreamContext, deps: GsdProviderDeps) => GsdEventStream;

  /**
   * Custom onboarding flow. If provided, this overrides default onboarding.
   *
   * Parameters are typed as unknown because @clack/prompts and picocolors
   * are dynamic imports.
   */
  onboard?: (
    clack: unknown,
    pico: unknown,
    authStorage: unknown,
  ) => Promise<boolean>;
}
