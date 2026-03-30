/**
 * Generic adapter that bridges GSD provider declarations to Pi.
 *
 * wireProvidersToPI reads getRegisteredProviderInfos() and calls
 * pi.registerProvider() for each provider.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  Message,
  StopReason,
  ToolCall,
} from "@gsd/pi-ai";
import type {
  GsdProviderInfo,
  GsdProviderDeps,
  GsdStreamContext,
  PluginLifecycleHandler,
  GsdToolResultPayload,
} from "./types.js";
import { getRegisteredProviderInfos, waitForProviderDeps, getProviderDeps, setProviderDeps } from "./provider-registry.js";
import { readPluginState, writePluginState } from "./plugin-state.js";
import { runPluginOnboarding } from "./plugin-onboarding.js";

const LIFECYCLE_PHASES = ["beforeInstall", "afterInstall", "beforeRemove", "afterRemove"] as const;
type LifecyclePhase = typeof LIFECYCLE_PHASES[number];

const PHASE_TO_REGISTRAR: Record<LifecyclePhase, string> = {
  beforeInstall: "registerBeforeInstall",
  afterInstall: "registerAfterInstall",
  beforeRemove: "registerBeforeRemove",
  afterRemove: "registerAfterRemove",
};

const LIFECYCLE_HOOKS_PATCHED_KEY = Symbol.for("gsd-provider-api-lifecycle-hooks-patched");
const PROVIDERS_WIRED_KEY = Symbol.for("gsd-provider-api-providers-wired");
const EXTERNAL_TOOL_RESULT_KEY = "externalResult";

type SessionNameApi = {
  get: () => string | undefined;
  set: (name: string) => void;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readAbortSignal(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const maybeSignal = (extra as Record<string, unknown>).signal;
  return maybeSignal instanceof AbortSignal ? maybeSignal : undefined;
}

function readToolCallId(extra: unknown): string {
  if (!extra || typeof extra !== "object") {
    return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  const maybeId = (extra as Record<string, unknown>).toolCallId;
  if (typeof maybeId === "string" && maybeId.trim().length > 0) {
    return maybeId;
  }
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeToolResult(raw: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const content = obj.content;
    if (Array.isArray(content)) {
      const normalized = content.map((part) => {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") {
            return { type: "text" as const, text: p.text };
          }
        }
        return { type: "text" as const, text: String(part ?? "") };
      });
      return { content: normalized, isError: obj.isError === true };
    }
  }
  return { content: [{ type: "text", text: typeof raw === "string" ? raw : JSON.stringify(raw) }] };
}

type ContextGsdTool = NonNullable<GsdStreamContext["tools"]>[number];

function extractGsdToolsFromContext(tools: unknown): GsdStreamContext["tools"] {
  if (!Array.isArray(tools)) return undefined;

  const mapped = tools
    .map((tool): ContextGsdTool | null => {
      const record = toRecord(tool);
      const name = typeof record.name === "string" ? record.name : "";
      if (!name.startsWith("gsd_")) return null;

      const description =
        typeof record.description === "string" && record.description.trim().length > 0
          ? record.description
          : name;
      const schema = toRecord(record.parameters);
      const executeImpl = typeof record.execute === "function"
        ? record.execute as (
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
          onUpdate?: unknown,
        ) => Promise<unknown>
        : null;
      if (!executeImpl) return null;

      return {
        name,
        description,
        schema,
        execute: async (args: Record<string, unknown>, extra?: unknown) => {
          const raw = await executeImpl(
            readToolCallId(extra),
            args,
            readAbortSignal(extra),
            undefined,
          );
          return normalizeToolResult(raw);
        },
      };
    })
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null);

  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Register lifecycle hooks and session-start onboarding with Pi.
 *
 * Lifecycle hooks: for each provider and each phase, if the provider
 * defines a handler, register it with Pi. No handler = no registration.
 *
 * Onboarding: on session_start, for each provider with an onboarding
 * field, read the plugin's own .state.json. If onboarding hasn't passed
 * yet, run the check and update the state file in the plugin's directory.
 *
 * The registrar methods (registerBeforeInstall, etc.) exist on the runtime
 * ExtensionAPI object but are not yet in the published gsd-pi type
 * declarations. Accessed via dynamic lookup until the types are updated.
 */
export function wireLifecycleHooks(pi: ExtensionAPI): void {
  const runtime = pi as unknown as Record<symbol, unknown>;
  if (runtime[LIFECYCLE_HOOKS_PATCHED_KEY]) return;
  runtime[LIFECYCLE_HOOKS_PATCHED_KEY] = true;

  const piRuntime = pi as unknown as Record<string, (fn: (ctx: unknown) => Promise<void>) => void>;

  for (const info of getRegisteredProviderInfos()) {
    for (const phase of LIFECYCLE_PHASES) {
      const handler: PluginLifecycleHandler | undefined = info[phase];
      if (!handler) continue;

      const registrarName = PHASE_TO_REGISTRAR[phase];
      const registrar = piRuntime[registrarName];
      if (typeof registrar !== "function") continue;

      registrar.call(pi, async (ctx: unknown) => {
        await handler(ctx as Parameters<PluginLifecycleHandler>[0]);
      });
    }
  }

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    for (const info of getRegisteredProviderInfos()) {
      if (!info.onboarding && !info.onboard) continue;

      const state = readPluginState(info.pluginDir);
      if (state.onboardingPassed) continue;

      const { ok } = await runPluginOnboarding(
        info,
        pi as unknown as Parameters<typeof runPluginOnboarding>[1],
        ctx as Parameters<typeof runPluginOnboarding>[2],
      );
      writePluginState(info.pluginDir, {
        onboardingChecked: true,
        onboardingPassed: ok,
      });
    }
  });
}

function extractUserPrompt(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map(c => c.text)
          .join("\n");
      }
    }
  }
  return "";
}

function normalizeSessionName(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 120);
}

function extractMessageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const part = block as Record<string, unknown>;
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function deriveSessionName(userPrompt: string, messages: Message[], providerLabel: string): string {
  const fromUser = normalizeSessionName(userPrompt);
  if (fromUser.length > 0) return fromUser;

  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractMessageText(messages[i]!);
    if (!text) continue;
    const unitMatch = text.match(/^\s*##\s*UNIT:\s*(.+)$/im);
    if (unitMatch?.[1]) {
      const normalized = normalizeSessionName(unitMatch[1]);
      if (normalized.length > 0) return normalized;
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const normalized = normalizeSessionName(extractMessageText(messages[i]!));
    if (normalized.length > 0) return normalized;
  }

  return normalizeSessionName(providerLabel) || "Session";
}

function ensureSessionHasName(sessionNameApi: SessionNameApi, candidateName: string): void {
  if (candidateName.trim().length === 0) return;
  try {
    const existing = sessionNameApi.get();
    if (typeof existing === "string" && existing.trim().length > 0) return;
    sessionNameApi.set(candidateName);
  } catch {
    // Non-fatal: session naming is best-effort metadata.
  }
}

type MutableToolCall = ToolCall & Record<string, unknown>;

function parseToolCallArguments(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asToolCallContent(value: unknown): MutableToolCall | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "toolCall") return null;
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  if (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments)) {
    record.arguments = {};
  }
  return record as MutableToolCall;
}

function createStreamSimple(
  info: GsdProviderInfo,
  getCtx: () => ExtensionContext | null,
  sessionNameApi: SessionNameApi,
  StreamClass: new () => AssistantMessageEventStream,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = new StreamClass();

    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    (async () => {
      const deps: GsdProviderDeps = await waitForProviderDeps() ?? {
        getSupervisorConfig: () => ({}),
        shouldBlockContextWrite: () => ({ block: false }),
        getMilestoneId: () => null,
        isDepthVerified: () => false,
        getIsUnitDone: () => false,
        onToolStart: () => {},
        onToolEnd: () => {},
        getBasePath: () => process.cwd(),
        getUnitInfo: () => ({ unitType: "interactive", unitId: "session" }),
      };

      const userPrompt = extractUserPrompt(context.messages);
      const gsdTools = extractGsdToolsFromContext((context as unknown as { tools?: unknown }).tools);
      const gsdContext: GsdStreamContext = {
        modelId: model.id,
        systemPrompt: context.systemPrompt ?? "",
        userPrompt,
        messages: context.messages,
        signal: options?.signal,
        tools: gsdTools,
        supervisorConfig: deps.getSupervisorConfig(),
      };

      ensureSessionHasName(sessionNameApi, deriveSessionName(userPrompt, context.messages, info.displayName));

      stream.push({ type: "start", partial: output });

      let activeContentIndex = -1;
      let activeThinkingIndex = -1;
      let activeToolStatusId: string | null = null;
      let hasProgressStatus = false;
      let ended = false;
      const toolCallIndexById = new Map<string, number>();
      const toolCallArgsBufferById = new Map<string, string>();
      const pendingToolResultsById = new Map<string, { toolName: string; result: GsdToolResultPayload }>();

      function clearToolStatus(toolCallId?: string): void {
        if (activeToolStatusId === null) return;
        if (toolCallId && activeToolStatusId !== toolCallId) return;
        const ctx = getCtx();
        if (ctx) ctx.ui.setStatus(`${info.id}-tool`, undefined);
        activeToolStatusId = null;
      }

      function setToolStatus(toolCallId: string, toolName: string, detail?: string): void {
        const ctx = getCtx();
        if (!ctx) return;
        const statusText = detail
          ? `${toolName.toLowerCase()}: ${detail}`
          : toolName.toLowerCase();
        ctx.ui.setStatus(`${info.id}-tool`, statusText);
        activeToolStatusId = toolCallId;
      }

      function clearProgressStatus(): void {
        if (!hasProgressStatus) return;
        const ctx = getCtx();
        if (ctx) ctx.ui.setStatus(`${info.id}-progress`, undefined);
        hasProgressStatus = false;
      }

      function setProgressStatus(text: string): void {
        const ctx = getCtx();
        if (!ctx) return;
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized.length === 0) {
          clearProgressStatus();
          return;
        }
        ctx.ui.setStatus(`${info.id}-progress`, normalized);
        hasProgressStatus = true;
      }

      function attachToolResult(toolCallId: string, toolName: string, result: GsdToolResultPayload): void {
        const existingIndex = toolCallIndexById.get(toolCallId);
        if (existingIndex === undefined) {
          pendingToolResultsById.set(toolCallId, { toolName, result });
          return;
        }
        const block = asToolCallContent(output.content[existingIndex]);
        if (!block) return;
        block[EXTERNAL_TOOL_RESULT_KEY] = result;
      }

      function ensureToolCall(toolCallId: string, toolName?: string): { index: number; block: MutableToolCall } {
        const pending = pendingToolResultsById.get(toolCallId);
        const existingIndex = toolCallIndexById.get(toolCallId);
        if (existingIndex !== undefined) {
          const existing = asToolCallContent(output.content[existingIndex]);
          if (existing) {
            const resolvedToolName = toolName || pending?.toolName;
            if (resolvedToolName && existing.name !== resolvedToolName) existing.name = resolvedToolName;
            return { index: existingIndex, block: existing };
          }
          toolCallIndexById.delete(toolCallId);
        }

        const toolCall: MutableToolCall = {
          type: "toolCall",
          id: toolCallId,
          name: (toolName && toolName.trim().length > 0 ? toolName : pending?.toolName) || "tool",
          arguments: {},
        };
        output.content.push(toolCall as unknown as AssistantMessage["content"][number]);
        const index = output.content.length - 1;
        toolCallIndexById.set(toolCallId, index);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });

        if (pending) {
          toolCall[EXTERNAL_TOOL_RESULT_KEY] = pending.result;
          pendingToolResultsById.delete(toolCallId);
        }

        return { index, block: toolCall };
      }

      try {
        const gsdStream = info.createStream(gsdContext, deps);

        for await (const event of gsdStream) {
          switch (event.type) {
            case "text_delta": {
              clearProgressStatus();
              if (activeContentIndex === -1) {
                const textBlock: TextContent = { type: "text", text: "" };
                output.content.push(textBlock);
                activeContentIndex = output.content.length - 1;
                stream.push({ type: "text_start", contentIndex: activeContentIndex, partial: output });
              }
              const block = output.content[activeContentIndex];
              if (block && block.type === "text") block.text += event.text;
              stream.push({ type: "text_delta", contentIndex: activeContentIndex, delta: event.text, partial: output });
              break;
            }

            case "thinking_delta": {
              if (activeThinkingIndex === -1) {
                output.content.push({ type: "thinking", thinking: "" });
                activeThinkingIndex = output.content.length - 1;
                stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
              }
              const thinkBlock = output.content[activeThinkingIndex];
              if (thinkBlock && thinkBlock.type === "thinking") thinkBlock.thinking += event.thinking;
              stream.push({ type: "thinking_delta", contentIndex: activeThinkingIndex, delta: event.thinking, partial: output });
              break;
            }

            case "progress_delta": {
              setProgressStatus(event.text);
              break;
            }

            case "tool_call_start": {
              ensureToolCall(event.toolCallId, event.toolName);
              setToolStatus(event.toolCallId, event.toolName, event.detail);
              break;
            }

            case "tool_call_delta": {
              const { index, block } = ensureToolCall(event.toolCallId);
              const current = toolCallArgsBufferById.get(event.toolCallId) ?? "";
              const next = current + event.delta;
              toolCallArgsBufferById.set(event.toolCallId, next);

              const parsedArgs = parseToolCallArguments(next);
              if (parsedArgs) {
                block.arguments = parsedArgs;
              }
              stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta, partial: output });
              break;
            }

            case "tool_call_end": {
              const { index, block } = ensureToolCall(event.toolCallId);
              const bufferedArgs = toolCallArgsBufferById.get(event.toolCallId);
              if (bufferedArgs !== undefined) {
                const parsedArgs = parseToolCallArguments(bufferedArgs);
                if (parsedArgs) {
                  block.arguments = parsedArgs;
                }
              }
              stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
              clearToolStatus(event.toolCallId);
              toolCallArgsBufferById.delete(event.toolCallId);
              break;
            }

            case "tool_result": {
              attachToolResult(event.toolCallId, event.toolName, event.result);
              clearToolStatus(event.toolCallId);
              break;
            }

            case "completion": {
              if (activeContentIndex >= 0) {
                const block = output.content[activeContentIndex];
                const text = block && block.type === "text" ? block.text : "";
                stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
                activeContentIndex = -1;
              }
              if (activeThinkingIndex >= 0) {
                const thinkBlock = output.content[activeThinkingIndex];
                const thinkText = thinkBlock && thinkBlock.type === "thinking" ? thinkBlock.thinking : "";
                stream.push({ type: "thinking_end", contentIndex: activeThinkingIndex, content: thinkText, partial: output });
                activeThinkingIndex = -1;
              }

              output.usage.input = event.usage.inputTokens;
              output.usage.output = event.usage.outputTokens;
              if (event.usage.cacheReadTokens !== undefined) output.usage.cacheRead = event.usage.cacheReadTokens;
              if (event.usage.cacheWriteTokens !== undefined) output.usage.cacheWrite = event.usage.cacheWriteTokens;
              output.usage.totalTokens = event.usage.inputTokens + event.usage.outputTokens;

              output.stopReason = (event.stopReason === "stop" || event.stopReason === "length" || event.stopReason === "toolUse")
                ? event.stopReason as StopReason
                : "stop";

              stream.push({
                type: "done",
                reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">,
                message: output,
              });
              clearToolStatus();
              clearProgressStatus();
              stream.end();
              ended = true;
              break;
            }

            case "error": {
              if (activeContentIndex >= 0) {
                const block = output.content[activeContentIndex];
                const text = block && block.type === "text" ? block.text : "";
                stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
                activeContentIndex = -1;
              }
              if (activeThinkingIndex >= 0) {
                const thinkBlock = output.content[activeThinkingIndex];
                const thinkText = thinkBlock && thinkBlock.type === "thinking" ? thinkBlock.thinking : "";
                stream.push({ type: "thinking_end", contentIndex: activeThinkingIndex, content: thinkText, partial: output });
                activeThinkingIndex = -1;
              }
              output.stopReason = "error";
              output.errorMessage = event.message;
              stream.push({ type: "error", reason: "error", error: output });
              clearToolStatus();
              clearProgressStatus();
              stream.end();
              ended = true;
              break;
            }
          }
        }

        if (!ended) {
          if (activeContentIndex >= 0) {
            const block = output.content[activeContentIndex];
            const text = block && block.type === "text" ? block.text : "";
            stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
          }
          if (activeThinkingIndex >= 0) {
            const thinkBlock = output.content[activeThinkingIndex];
            const thinkText = thinkBlock && thinkBlock.type === "thinking" ? thinkBlock.thinking : "";
            stream.push({ type: "thinking_end", contentIndex: activeThinkingIndex, content: thinkText, partial: output });
          }
          stream.push({ type: "done", reason: "stop", message: output });
          clearToolStatus();
          clearProgressStatus();
          stream.end();
        }
      } catch (err) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
        clearToolStatus();
        clearProgressStatus();
        stream.end();
      }
    })();

    return stream;
  };
}

/** Wire all registered providers to Pi. */
export async function wireProvidersToPI(pi: ExtensionAPI): Promise<void> {
  const runtime = pi as unknown as Record<symbol, unknown>;
  if (runtime[PROVIDERS_WIRED_KEY]) return;
  runtime[PROVIDERS_WIRED_KEY] = true;

  const piAi = await import("@gsd/pi-ai");

  let currentCtx: ExtensionContext | null = null;
  pi.on("agent_start", async (_event, ctx) => { currentCtx = ctx; });
  pi.on("agent_end", async () => { currentCtx = null; });

  const sessionNameApi: SessionNameApi = {
    get: () => {
      try {
        return pi.getSessionName();
      } catch {
        return undefined;
      }
    },
    set: (name: string) => {
      try {
        pi.setSessionName(name);
      } catch {
        // best-effort only
      }
    },
  };

  for (const info of getRegisteredProviderInfos()) {
    const apiId = (info.api ?? info.id) as Api;
    const baseUrl = info.baseUrl ?? `${info.id}:`;
    const models = info.models.map(m => ({
      id: m.id,
      name: m.displayName,
      api: apiId,
      reasoning: m.reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    const streamSimple = createStreamSimple(info, () => currentCtx, sessionNameApi, piAi.AssistantMessageEventStream);

    pi.registerProvider(info.id, {
      authMode: info.authMode,
      isReady: info.isReady,
      api: apiId,
      baseUrl,
      apiKey: info.apiKey,
      streamSimple,
      models,
    } as Record<string, unknown>);
  }
}
