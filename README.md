# OTel LLM Capture Plugin

A lightweight, self-contained OpenClaw plugin that captures LLM provider traffic (prompts and responses) and exports distributed traces to any OpenTelemetry-compatible endpoint.

## Overview

This plugin hooks into OpenClaw's `llm_input`, `llm_output`, `message_received`, and `session_end` events to create OpenTelemetry traces for every LLM call. It sets up its own `BasicTracerProvider` with a `BatchSpanProcessor` and `OTLPTraceExporter`, so **no additional plugins (like `diagnostics-otel`) are required**. Spans are exported directly to your configured OTLP endpoint (e.g., Langfuse, Jaeger, Grafana Tempo).

## Requirements

- OpenClaw >= 2026.2.0
- `@opentelemetry/api` ^1.9.0 (peer dependency)
- An OTLP-compatible endpoint to receive traces

## Installation

1. Verify the plugin is in your extensions directory:
```bash
ls ~/.openclaw/extensions/otel-llm-capture/
```

2. Add to your OpenClaw config (`~/.openclaw/openclaw.json`):
```json
{
  "plugins": {
    "entries": {
      "otel-llm-capture": {
        "enabled": true,
        "config": {
          "includeContent": false,
          "maxContentLength": 5000,
          "sampleRate": 1.0
        }
      }
    }
  }
}
```

3. Configure the OTLP endpoint (optional — defaults to `http://127.0.0.1:4318`):
```json
{
  "diagnostics": {
    "otel": {
      "endpoint": "https://your-otel-endpoint.example.com",
      "serviceName": "openclaw-gateway"
    }
  }
}
```

The plugin reads `diagnostics.otel.endpoint` and `diagnostics.otel.serviceName` from your OpenClaw config. If not set, it defaults to `http://127.0.0.1:4318` and `openclaw-gateway` respectively.

4. Restart the gateway:
```bash
openclaw gateway restart
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `includeContent` | boolean | `false` | Include actual prompt/response text in spans. **Warning:** May contain sensitive data |
| `maxContentLength` | number | `5000` | Maximum characters to include per text field |
| `sampleRate` | number | `1.0` | Sampling rate (0.0–1.0). `1.0` = capture all requests |

## Span Attributes

**Span Name:** `llm.request` (SpanKind: CLIENT)

### Always included

| Attribute | Description |
|-----------|-------------|
| `langfuse.observation.type` | Always `"generation"` |
| `langfuse.observation.model.name` | Model name |
| `langfuse.session.id` | Session identifier |
| `openinference.span.kind` | Always `"LLM"` |
| `gen_ai.system` | LLM provider (e.g., `"ollama"`, `"openai"`) |
| `gen_ai.request.model` | Model name |
| `model` | Model name |
| `openclaw.llm.provider` | LLM provider |
| `openclaw.llm.model` | Model name |
| `openclaw.llm.run_id` | Unique run identifier |
| `openclaw.llm.session_id` | Session identifier |
| `openclaw.llm.images_count` | Number of images in the request |
| `openclaw.llm.history_messages_count` | Number of history messages |

### Set on `llm_output`

| Attribute | Description |
|-----------|-------------|
| `openclaw.llm.response.texts_count` | Number of response texts |
| `openclaw.llm.tokens.input` | Input tokens used |
| `openclaw.llm.tokens.output` | Output tokens used |
| `openclaw.llm.tokens.cache_read` | Cache read tokens (if supported) |
| `openclaw.llm.tokens.cache_write` | Cache write tokens (if supported) |
| `openclaw.llm.tokens.total` | Total tokens used |
| `openclaw.llm.duration_ms` | Request duration in milliseconds |
| `gen_ai.usage.input_tokens` | Input tokens (OTel convention) |
| `gen_ai.usage.output_tokens` | Output tokens (OTel convention) |
| `gen_ai.usage.total_tokens` | Total tokens (OTel convention) |

### Conditional (when `includeContent: true`)

| Attribute | Description |
|-----------|-------------|
| `langfuse.observation.input` | JSON-encoded input payload (system prompt, user prompt, history preview) |
| `langfuse.observation.output` | Response text (or JSON array if multiple responses) |
| `langfuse.trace.input` | Same as `langfuse.observation.input` |
| `langfuse.trace.output` | Same as `langfuse.observation.output` |

### Conditional (when user identity is available)

| Attribute | Description |
|-----------|-------------|
| `langfuse.user.id` | User identity in `channelId:handle` format |

## User Identity Tracking

The plugin listens to `message_received` events to capture user identity. It extracts the sender's username, name, or ID from message metadata and associates it with the conversation. When an LLM call is made within that conversation, the user identity is attached to the trace via `langfuse.user.id`.

## Diagnostic Event Enrichment

The plugin enriches `session.stuck` diagnostic events with the latest LLM request context. When a session gets stuck, it creates an error span (`openclaw.session.stuck.enriched`) that includes:

- Session state and age
- Queue depth
- Last LLM provider, model, and run ID
- Prompt preview (if `includeContent` is enabled)

## Langfuse Integration

This plugin exports traces directly to any OTLP endpoint. For Langfuse, point the `diagnostics.otel.endpoint` to your Langfuse OTLP ingestion URL. The plugin emits Langfuse-compatible attributes (`langfuse.observation.*`, `langfuse.trace.*`, `langfuse.session.id`, `langfuse.user.id`) so traces appear correctly in the Langfuse UI as generation observations.

## Performance

- **Self-contained** — sets up its own `BasicTracerProvider` and `BatchSpanProcessor`
- **Minimal memory overhead** — only tracks active spans in a Map, cleaned up after each `llm_output`
- **Batch processing** — spans are batched before export via `BatchSpanProcessor`
- **Sampling support** — reduce overhead with `sampleRate < 1.0`
- **Session cleanup** — orphaned spans are ended on `session_end`
- **Graceful shutdown** — flushes pending spans on `SIGTERM`/`SIGINT`

## Security Considerations

- **Content capture is off by default** — `includeContent` defaults to `false`
- **Never enable `includeContent`** in environments where prompts may contain PII unless you have appropriate data handling in place
- All captured content is passed through `redactSensitiveText()` from `openclaw/plugin-sdk` and truncated to `maxContentLength`
- Consider using `sampleRate: 0.1` in production to reduce data volume

## Troubleshooting

**Plugin not capturing spans?**
- Check that the plugin is enabled in `openclaw.json`
- Verify the OTLP endpoint is reachable from the gateway
- Check OpenClaw logs: `openclaw logs`

**Spans not appearing in your tracing backend?**
- Verify `diagnostics.otel.endpoint` is set to the correct OTLP URL
- Ensure the endpoint accepts OTLP/Proto format at `/v1/traces`
- Check network connectivity between the gateway and the endpoint

**Token counts missing?**
- Not all LLM providers report usage data; token attributes are only set when the provider includes them in the response

## Development

The plugin uses OpenClaw's hook system:
- `message_received` — Captures user identity from incoming messages
- `llm_input` — Creates a span when a request is sent to the LLM provider
- `llm_output` — Completes the span with response data and token usage
- `session_end` — Cleans up orphaned spans and tracking data

It also listens for `session.stuck` diagnostic events via `onDiagnosticEvent()` to enrich them with LLM context.

## License

MIT — Part of the OpenClaw ecosystem
