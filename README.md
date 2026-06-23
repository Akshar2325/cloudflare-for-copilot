# Cloudflare AI for GitHub Copilot Chat

Use Cloudflare Workers AI directly inside Copilot Chat with BYOK credentials, dynamic model catalogs, and multi-account routing.

## Highlights

- Direct Cloudflare API integration (`/ai/v1/chat/completions`)
- No local proxy, no local port configuration
- Multiple Cloudflare accounts with rotation + failover
- Curated Cloudflare model list out of the box
- Optional custom model catalog via settings
- Reasoning controls (`thinkingMode`, `reasoningLevel`, per-model overrides)
- Tool calling and vision passthrough when model supports it

## Supported Curated Models

- `@cf/moonshotai/kimi-k2.7-code` (tools, vision, reasoning)
- `@cf/moonshotai/kimi-k2.6` (tools, vision, reasoning)
- `@cf/zai-org/glm-5.2` (tools, reasoning)
- `@cf/google/gemma-4-26b-a4b-it` (tools, vision, reasoning)
- `@cf/openai/gpt-oss-120b` (tools, reasoning)

Capabilities are based on Cloudflare Workers AI model docs.

## Setup

1. Install extension.
2. Open command palette.
3. Run `Cloudflare AI: Manage Provider`.
4. Choose `Add Account`.
5. Enter:
   - Cloudflare Account ID
   - API Token with Workers AI permissions
   - Friendly label

After at least one account is configured, Cloudflare models appear in Copilot's model picker.

## Account Routing

Routing behavior:

- Primary account is tried first when configured.
- Remaining accounts are tried in round-robin order.
- `429` marks an account exhausted for ~1 hour.
- `401` and `403` automatically fail over to next account.

Use `Cloudflare AI: Manage Provider` to:

- Add / remove accounts
- Set primary account
- Show account status
- Configure thinking behavior

## Reasoning and Thinking

Settings:

- `cloudflareAI.thinkingMode`: `off` | `auto` | `on`
- `cloudflareAI.reasoningLevel`: `low` | `medium` | `high`
- `cloudflareAI.modelReasoningOverrides`: per-model override map

When reasoning is enabled for a reasoning-capable model, extension sends `reasoning_effort`.

## Dynamic Model Catalog

By default, curated models are used.

To define your own catalog, set `cloudflareAI.modelCatalog`:

```json
"cloudflareAI.modelCatalog": [
  {
    "id": "cf-custom-kimi",
    "cfModelId": "@cf/moonshotai/kimi-k2.7-code",
    "displayName": "Cloudflare: Kimi K2.7 Custom",
    "contextWindow": 262144,
    "maxOutputTokens": 32768,
    "supportsTools": true,
    "supportsVision": true,
    "supportsReasoning": true
  }
]
```

## Development

```bash
pnpm install
pnpm run compile
```

Common scripts:

- `pnpm run watch`
- `pnpm run lint`
- `pnpm run format`
- `pnpm run test`

## License

MIT
