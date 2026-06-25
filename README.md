# Cloudflare AI for GitHub Copilot Chat

Use Cloudflare Workers AI models directly inside Copilot Chat with multi-account routing and configurable reasoning.

## Features

- Direct Cloudflare Workers AI API integration (`/ai/v1/chat/completions`)
- Multi-account support with automatic rotation and failover
- Curated Cloudflare model list out of the box
- Reasoning and thinking support (`reasoning_effort`)
- Tool calling and vision passthrough when model supports it

## Supported Models

- `@cf/moonshotai/kimi-k2.7-code` (tools, vision, reasoning)
- `@cf/moonshotai/kimi-k2.6` (tools, vision, reasoning)
- `@cf/zai-org/glm-5.2` (tools, reasoning)
- `@cf/google/gemma-4-26b-a4b-it` (tools, vision, reasoning)
- `@cf/openai/gpt-oss-120b` (tools, reasoning)

## Setup

1. Install the extension.
2. Open VS Code command palette (`Ctrl+Shift+P`).
3. Run **Cloudflare AI: Manage Provider** → **Add Account**.
4. Enter your Cloudflare Account ID, API Token, and a label.
5. Models will appear in the Copilot model picker.

## Account Routing

- Primary account is tried first.
- Remaining accounts are tried in round-robin order.
- `429` (rate limited) marks an account as exhausted until midnight UTC.
- `401` / `403` automatically fail over to the next account.

## Development

```bash
npm install
npm run compile
```

Common scripts:

- `npm run watch` — watch mode
- `npm run lint` — run ESLint
- `npm run format` — run Prettier
- `npm run package` — build VSIX

## 📄 License

MIT — see [LICENSE](LICENSE)
