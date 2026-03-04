# OTel LLM Capture Plugin

A lightweight OpenClaw plugin that captures LLM provider traffic (prompts and responses) and exports to OpenTelemetry via the existing `diagnostics-otel` plugin.

## Overview

This plugin hooks into OpenClaw's `llm_input` and `llm_output` events to create OpenTelemetry traces for every LLM call. It uses the global OTel tracer from `diagnostics-otel`, so **no additional OTLP configuration is needed** — spans automatically flow to your existing Langfuse endpoint.

## Requirements

- OpenClaw >= 2026.2.0
- `diagnostics-otel` plugin must be enabled and configured
- `@opentelemetry/api` (provided by `diagnostics-otel`)

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

3. Restart the gateway:
```bash
openclaw gateway restart
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `includeContent` | boolean | `false` | Include actual prompt/response text in spans. **Warning:** May contain sensitive data |
| `maxContentLength` | number | `5000` | Maximum characters to include per text field |
| `sampleRate` | number | `1.0` | Sampling rate (0.0-1.0). 1.0 = capture all requests |

## Langfuse Integration

This plugin works with Langfuse via the `diagnostics-otel` exporter. It emits both OpenClaw attributes and common OTEL/Langfuse-friendly fields (`input.value`, `output.value`, `gen_ai.*`):

**Span Name:** `openclaw.request`

**Attributes:**
- `openclaw.llm.provider` — LLM provider (e.g., "ollama", "openai")
- `openclaw.llm.model` — Model name (e.g., "kimi-k2.5")
- `openclaw.llm.run_id` — Unique run identifier
- `openclaw.llm.session_id` — Session identifier
- `openclaw.llm.images_count` — Number of images in the request
- `openclaw.llm.history_messages_count` — Number of history messages
- `openclaw.llm.tokens.input` — Input tokens used
- `openclaw.llm.tokens.output` — Output tokens used
- `openclaw.llm.tokens.cache_read` — Cache read tokens (if supported)
- `openclaw.llm.tokens.cache_write` — Cache write tokens (if supported)
- `openclaw.llm.tokens.total` — Total tokens used
- `openclaw.llm.duration_ms` — Request duration in milliseconds

**Optional (when `includeContent: true`):**
- `openclaw.llm.system_prompt` — System prompt (truncated)
- `openclaw.llm.user_prompt` — User prompt (truncated)
- `openclaw.llm.history_preview` — Last 2 history messages
- `openclaw.llm.response.text` — First response text (truncated)
- `input.value` — Prompt payload shown as trace input
- `output.value` — Response payload shown as trace output
- `gen_ai.usage.input_tokens` — Input tokens
- `gen_ai.usage.output_tokens` — Output tokens
- `gen_ai.usage.total_tokens` — Total tokens

## Performance

- **No additional OTLP connections** — reuses `diagnostics-otel` exporter
- **Minimal memory overhead** — only tracks active spans in a Map
- **Automatic cleanup** — spans are deleted after `llm_output` event
- **Sampling support** — reduce overhead with `sampleRate < 1.0`
- **Session cleanup** — orphaned spans are ended on `session_end`

## Security Considerations

- **Never commit `includeContent: true`** to version control if prompts may contain PII
- The plugin redacts captured prompt/response content with `redactSensitiveText()` from `openclaw/plugin-sdk`
- Consider using `sampleRate: 0.1` in production to reduce data volume

## Troubleshooting

**Plugin not capturing spans?**
- Check that `diagnostics-otel` is enabled and has `traces: true`
- Verify the OTLP endpoint is reachable
- Check OpenClaw logs: `openclaw logs`

**Spans not appearing in Langfuse?**
- Verify `diagnostics-otel` is properly exporting to Langfuse
- Check Langfuse project settings for OTel endpoint
- Ensure `OTEL_EXPORTER_OTLP_ENDPOINT` or config `endpoint` is set correctly

## Development

The plugin uses OpenClaw's hook system:
- `llm_input` — Fires when a request is sent to the LLM provider
- `llm_output` — Fires when the response is received
- `session_end` — Cleanup for any orphaned spans

## License

MIT — Part of the OpenClaw ecosystem
