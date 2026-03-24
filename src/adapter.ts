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
} from "@gsd/pi-ai";
import type { GsdProviderInfo, GsdProviderDeps, ProviderAuthMode } from "./types.js";
import { getRegisteredProviderInfos, waitForProviderDeps } from "./provider-registry.js";

/**
 * When true, upstream Pi supports authMode on ProviderConfig natively.
 * Flip this once the authMode PR is merged into the vendored GSD2 Pi fork.
 *
 * When false, externalCli/none providers use a dummy API key literal to
 * bypass Pi's auth validation gates (hasAuth, getApiKey, getAvailable, etc.).
 * This works because Pi resolves the literal as a "key", passes it through
 * its auth pipeline, and the provider's streamSimple ignores it entirely.
 *
 * See: https://github.com/gsd-build/gsd-2 — feat(core): authMode support
 */
const UPSTREAM_AUTH_MODE_SUPPORT = false;

const KEYLESS_PROVIDER_DUMMY_KEY = "GSD_PROVIDER_KEYLESS";

function needsDummyKey(authMode: ProviderAuthMode): boolean {
  return authMode === "externalCli" || authMode === "none";
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

function createStreamSimple(
  info: GsdProviderInfo,
  getCtx: () => ExtensionContext | null,
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
      const deps: GsdProviderDeps | null = await waitForProviderDeps();
      if (deps === null) {
        output.stopReason = "error";
        output.errorMessage = "GSD provider deps not initialized — provider invoked before orchestration runtime was wired";
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
        return;
      }

      const userPrompt = extractUserPrompt(context.messages);
      const gsdContext = {
        modelId: model.id,
        systemPrompt: context.systemPrompt ?? "",
        userPrompt,
        supervisorConfig: deps.getSupervisorConfig(),
      };

      stream.push({ type: "start", partial: output });

      let activeContentIndex = -1;
      let activeThinkingIndex = -1;
      let ended = false;

      try {
        const gsdStream = info.createStream(gsdContext, deps);

        for await (const event of gsdStream) {
          switch (event.type) {
            case "text_delta": {
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

            case "tool_start": {
              const ctx = getCtx();
              if (ctx) {
                const statusText = event.detail
                  ? `${event.toolName.toLowerCase()}: ${event.detail}`
                  : event.toolName.toLowerCase();
                ctx.ui.setStatus(`${info.id}-tool`, statusText);
              }
              break;
            }

            case "tool_end": {
              const ctx = getCtx();
              if (ctx) ctx.ui.setStatus(`${info.id}-tool`, undefined);
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
          stream.end();
        }
      } catch (err) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
        stream.end();
      }
    })();

    return stream;
  };
}

/** Wire all registered providers to Pi. */
export async function wireProvidersToPI(pi: ExtensionAPI): Promise<void> {
  const piAi = await import("@gsd/pi-ai");

  let currentCtx: ExtensionContext | null = null;
  pi.on("agent_start", async (_event, ctx) => { currentCtx = ctx; });
  pi.on("agent_end", async () => { currentCtx = null; });

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
    const streamSimple = createStreamSimple(info, () => currentCtx, piAi.AssistantMessageEventStream);

    if (UPSTREAM_AUTH_MODE_SUPPORT) {
      pi.registerProvider(info.id, {
        authMode: info.authMode,
        api: apiId,
        baseUrl,
        apiKey: info.apiKey,
        streamSimple,
        models,
      } as Record<string, unknown>);
    } else {
      pi.registerProvider(info.id, {
        api: apiId,
        baseUrl,
        apiKey: needsDummyKey(info.authMode) ? KEYLESS_PROVIDER_DUMMY_KEY : info.apiKey,
        streamSimple,
        models,
      });
    }
  }
}
