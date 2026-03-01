/**
 * OTel LLM Capture Plugin (self-contained)
 *
 * Captures LLM provider traffic (prompts/responses) and exports traces
 * via its own OTel SDK setup. Does NOT require diagnostics-otel.
 *
 * Reads connection settings from `diagnostics.otel` in openclaw.json
 * (endpoint, serviceName, sampleRate) but sets up its own
 * BasicTracerProvider + BatchSpanProcessor + OTLPTraceExporter.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookAgentContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent, redactSensitiveText } from "openclaw/plugin-sdk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Tracer, Span } from "@opentelemetry/api";

import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";

interface LlmCaptureConfig {
  enabled?: boolean;
  includeContent?: boolean;
  maxContentLength?: number;
  sampleRate?: number;
}

const DEFAULT_CONFIG: Required<LlmCaptureConfig> = {
  enabled: true,
  includeContent: false,
  maxContentLength: 5000,
  sampleRate: 1.0,
};

interface SpanContext {
  span: Span;
  startTime: number;
  sessionId: string;
  provider: string;
  model: string;
}

function sanitizeContent(value: string, max: number): string {
  return redactSensitiveText(value).slice(0, max);
}

const plugin = {
  id: "otel-llm-capture",
  name: "OTel LLM Capture",
  description:
    "Self-contained OTel LLM capture. Captures LLM provider traffic (prompts/responses) and exports traces directly. Does not require diagnostics-otel.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: {
        type: "boolean",
        description: "Enable LLM capture (default: true)",
        default: true,
      },
      includeContent: {
        type: "boolean",
        description:
          "Include actual prompt/response content in spans. WARNING: May contain sensitive data. (default: false)",
        default: false,
      },
      maxContentLength: {
        type: "number",
        description: "Maximum characters to include per prompt/response (default: 5000)",
        default: 5000,
      },
      sampleRate: {
        type: "number",
        description: "Sampling rate 0.0-1.0. 1.0 = capture all (default: 1.0)",
        default: 1.0,
        minimum: 0,
        maximum: 1,
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const rawConfig = (api.pluginConfig ?? {}) as LlmCaptureConfig;
    const config = { ...DEFAULT_CONFIG, ...rawConfig };

    if (!config.enabled) {
      api.logger.debug("otel-llm-capture: disabled by config");
      return;
    }

    // Read OTel connection settings from diagnostics.otel (shared config)
    const otelConfig = api.config.diagnostics?.otel;
    const endpoint = otelConfig?.endpoint ?? "http://127.0.0.1:4318";
    const serviceName = otelConfig?.serviceName ?? "openclaw-gateway";

    // Set up our own TracerProvider with OTLP exporter
    const exporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    });

    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": serviceName,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });

    // Register globally so spans flow through our pipeline
    trace.setGlobalTracerProvider(provider);

    const tracer = provider.getTracer("openclaw");

    api.logger.info(
      `otel-llm-capture: started (self-contained), exporting to ${endpoint}`
    );

    // Flush pending spans on shutdown
    const shutdown = async () => {
      try {
        await provider.shutdown();
      } catch {
        // best-effort
      }
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    const spanContextByRunId = new Map<string, SpanContext>();
    const latestBySessionId = new Map<
      string,
      { runId: string; provider: string; model: string; promptPreview?: string; at: number }
    >();
    // Track user identity per conversation (channel:handle or channel:senderId)
    const userByConversationId = new Map<string, string>();

    // --- Capture user identity from incoming messages ---
    api.on(
      "message_received",
      (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => {
        if (!event.from) return;
        const meta = event.metadata ?? {};
        const handle = meta.senderUsername ?? meta.senderName ?? meta.senderId ?? event.from;
        const userId = ctx.channelId
          ? `${ctx.channelId}:${handle}`
          : String(handle);
        // Key by conversationId (chat-level) and by from (sender-level)
        if (ctx.conversationId) {
          userByConversationId.set(ctx.conversationId, userId);
        }
        // Also key by channelId:from so LLM hooks can look up by session's messageProvider
        userByConversationId.set(`__last_${ctx.channelId ?? "unknown"}`, userId);
      }
    );

    // --- LLM Input Hook ---
    api.on(
      "llm_input",
      (event: PluginHookLlmInputEvent, _ctx: PluginHookAgentContext) => {
        if (config.sampleRate < 1.0 && Math.random() > config.sampleRate) {
          return;
        }

        const attributes: Record<string, string | number | boolean> = {
          // Langfuse observation mapping
          "langfuse.observation.type": "generation",
          "langfuse.observation.model.name": event.model,
          "langfuse.session.id": event.sessionId,
          // OTel GenAI semantic conventions
          "openinference.span.kind": "LLM",
          "gen_ai.system": event.provider,
          "gen_ai.request.model": event.model,
          "model": event.model,
          // OpenClaw-specific
          "openclaw.llm.provider": event.provider,
          "openclaw.llm.model": event.model,
          "openclaw.llm.run_id": event.runId,
          "openclaw.llm.session_id": event.sessionId,
          "openclaw.llm.images_count": event.imagesCount,
        };

        const historyCount = Array.isArray(event.historyMessages)
          ? event.historyMessages.length
          : 0;
        attributes["openclaw.llm.history_messages_count"] = historyCount;

        if (config.includeContent) {
          const inputPayload: Record<string, unknown> = {};
          if (event.systemPrompt) {
            inputPayload.system = sanitizeContent(event.systemPrompt, config.maxContentLength);
          }
          if (event.prompt) {
            inputPayload.user = sanitizeContent(event.prompt, config.maxContentLength);
          }
          if (historyCount > 0) {
            inputPayload.history_preview = event.historyMessages.slice(-2);
          }

          const inputJson = JSON.stringify(inputPayload);
          attributes["langfuse.observation.input"] = inputJson;
          attributes["langfuse.trace.input"] = inputJson;
        }

        // Attach user identity to trace
        const userId =
          userByConversationId.get(event.sessionId) ??
          (_ctx.messageProvider ? userByConversationId.get(`__last_${_ctx.messageProvider}`) : undefined);
        if (userId) {
          attributes["langfuse.user.id"] = userId;
        }

        const span = tracer.startSpan("llm.request", {
          attributes,
          kind: 1, // SpanKind.CLIENT
        });

        spanContextByRunId.set(event.runId, {
          span,
          startTime: Date.now(),
          sessionId: event.sessionId,
          provider: event.provider,
          model: event.model,
        });

        latestBySessionId.set(event.sessionId, {
          runId: event.runId,
          provider: event.provider,
          model: event.model,
          promptPreview: config.includeContent
            ? sanitizeContent(event.prompt ?? "", Math.min(config.maxContentLength, 500))
            : undefined,
          at: Date.now(),
        });
      }
    );

    // --- LLM Output Hook ---
    api.on(
      "llm_output",
      (event: PluginHookLlmOutputEvent, _ctx: PluginHookAgentContext) => {
        const context = spanContextByRunId.get(event.runId);
        if (!context) return;

        const span = context.span;
        const durationMs = Date.now() - context.startTime;

        const responseCount = event.assistantTexts?.length || 0;
        span.setAttribute("openclaw.llm.response.texts_count", responseCount);

        if (config.includeContent && responseCount > 0) {
          const outputJson = responseCount > 1
            ? JSON.stringify(event.assistantTexts.map(t => sanitizeContent(t, config.maxContentLength)))
            : sanitizeContent(event.assistantTexts[0] || "", config.maxContentLength);
          span.setAttribute("langfuse.observation.output", outputJson);
          span.setAttribute("langfuse.trace.output", outputJson);
        }

        if (event.usage) {
          const usage = event.usage;
          if (typeof usage.input === "number") {
            span.setAttribute("openclaw.llm.tokens.input", usage.input);
            span.setAttribute("gen_ai.usage.input_tokens", usage.input);
          }
          if (typeof usage.output === "number") {
            span.setAttribute("openclaw.llm.tokens.output", usage.output);
            span.setAttribute("gen_ai.usage.output_tokens", usage.output);
          }
          if (typeof usage.cacheRead === "number") {
            span.setAttribute("openclaw.llm.tokens.cache_read", usage.cacheRead);
          }
          if (typeof usage.cacheWrite === "number") {
            span.setAttribute("openclaw.llm.tokens.cache_write", usage.cacheWrite);
          }
          if (typeof usage.total === "number") {
            span.setAttribute("openclaw.llm.tokens.total", usage.total);
            span.setAttribute("gen_ai.usage.total_tokens", usage.total);
          }
        }

        span.setAttribute("openclaw.llm.duration_ms", durationMs);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        spanContextByRunId.delete(event.runId);
      }
    );

    // --- Enrich session.stuck diagnostic events ---
    onDiagnosticEvent((evt) => {
      if (evt.type !== "session.stuck") return;
      const latest = evt.sessionId ? latestBySessionId.get(evt.sessionId) : undefined;
      const attributes: Record<string, string | number> = {
        "openclaw.session_id": evt.sessionId ?? "",
        "openclaw.session_key": evt.sessionKey ?? "",
        "openclaw.state": evt.state,
        "openclaw.age_ms": evt.ageMs,
        "openclaw.queue_depth": evt.queueDepth ?? 0,
      };
      if (latest) {
        attributes["openclaw.llm.run_id"] = latest.runId;
        attributes["openclaw.llm.provider"] = latest.provider;
        attributes["openclaw.llm.model"] = latest.model;
        attributes["openclaw.llm.last_seen_at_ms"] = latest.at;
        if (latest.promptPreview) {
          attributes["input.value"] = latest.promptPreview;
        }
      }
      const span = tracer.startSpan("openclaw.session.stuck.enriched", { attributes });
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
      span.end();
    });

    // --- Cleanup orphaned spans on session end ---
    api.on("session_end", (_event, ctx: PluginHookAgentContext) => {
      const sessionId = ctx.sessionId;
      if (!sessionId) return;
      latestBySessionId.delete(sessionId);
      userByConversationId.delete(sessionId);

      for (const [runId, context] of spanContextByRunId) {
        if (context.sessionId === sessionId) {
          context.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Session ended before LLM response",
          });
          context.span.end();
          spanContextByRunId.delete(runId);
        }
      }
    });
  },
};

export default plugin;
