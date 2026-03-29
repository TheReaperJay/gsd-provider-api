/**
 * Shared contracts for GSD provider integration.
 *
 * These interfaces define the boundary between GSD orchestration and provider
 * plugins (claude-code, codex, gemini, etc.).
 */

import type { z } from "zod";
import type { spawnSync } from "node:child_process";
import type { Message } from "@gsd/pi-ai";

/** Matches core provider auth semantics exactly. */
export type ProviderAuthMode = "apiKey" | "oauth" | "externalCli" | "none";

/** Tool definition that any provider can wrap in its own format (SDK MCP, CLI schema, etc.). */
export interface GsdToolDef {
  name: string;
  description: string;
  // Either a Zod raw shape or a plain JSON-schema-like object.
  schema: Record<string, z.ZodTypeAny> | Record<string, unknown>;
  // "extra" allows provider-specific execution context (e.g. AbortSignal).
  execute: (
    args: Record<string, unknown>,
    extra?: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; [key: string]: unknown }>;
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

/** Tool result payload shared by external provider streams. */
export interface GsdToolResultPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** Canonical result shape for executed tools in provider streams. */
export interface GsdToolResultPayload {
  content: GsdToolResultPart[];
  isError: boolean;
  details?: unknown;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/** Discriminated union of all events emitted by a provider stream. */
export type GsdEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string; detail?: string }
  | { type: "tool_call_delta"; toolCallId: string; delta: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "tool_result"; toolCallId: string; toolName: string; result: GsdToolResultPayload }
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
  messages: Message[];
  /** Abort signal from Pi streamSimple options (e.g. user pressed Esc). */
  signal?: AbortSignal;
  tools?: GsdToolDef[];
  supervisorConfig: {
    soft_timeout_minutes?: number;
    idle_timeout_minutes?: number;
    hard_timeout_minutes?: number;
  };
}

// ─── Plugin Lifecycle ────────────────────────────────────────────────────────

/** Context passed to plugin lifecycle hooks during install/remove phases. */
export interface PluginLifecycleContext {
  source: string;
  installedPath?: string;
  scope: "user" | "project";
  cwd: string;
  interactive: boolean;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Handler signature for plugin lifecycle hooks. */
export type PluginLifecycleHandler = (ctx: PluginLifecycleContext) => Promise<void> | void;

// ─── Plugin Runtime State ────────────────────────────────────────────────────

/** Per-plugin runtime state, persisted to the plugin's own directory. */
export interface PluginRuntimeState {
  onboardingChecked: boolean;
  onboardingPassed: boolean;
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

  /** Absolute path to the plugin's own directory. Used for plugin-owned state storage. */
  pluginDir: string;

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

  /** Optional runtime readiness check. Return false if the provider cannot accept requests (e.g., CLI not authenticated, local server not running). Called by Pi's isProviderRequestReady() before default auth checks. */
  isReady?: () => boolean;

  /** Models available from this provider. */
  models: GsdModel[];

  /** Create a GSD-native event stream for the given context and deps. */
  createStream: (context: GsdStreamContext, deps: GsdProviderDeps) => GsdEventStream;

  /**
   * Custom onboarding flow. If provided, this overrides default onboarding.
   *
   * The library passes @clack/prompts and picocolors — the extension does
   * not need to install them. Parameters typed as unknown because the
   * library dynamically imports them.
   */
  onboard?: (
    clack: unknown,
    pico: unknown,
  ) => Promise<boolean>;

  /** Runs before the extension package is installed. */
  beforeInstall?: PluginLifecycleHandler;

  /** Runs after the extension package is installed and runtime deps are verified. */
  afterInstall?: PluginLifecycleHandler;

  /** Runs before the extension package is removed. */
  beforeRemove?: PluginLifecycleHandler;

  /** Runs after the extension package is removed. */
  afterRemove?: PluginLifecycleHandler;
}
