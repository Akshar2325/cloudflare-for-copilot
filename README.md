# Cloudflare AI for GitHub Copilot Chat

Use Cloudflare Workers AI models directly inside Copilot Chat with configurable reasoning.

## Features

- Direct Cloudflare Workers AI API integration (`/ai/v1/chat/completions`)
- Curated Cloudflare model list out of the box
- Reasoning and thinking support (`reasoning_effort`)
- Tool calling and vision passthrough when model supports it
- Automatic quota exhaustion tracking (resets at midnight UTC)

## Supported Models

- `@cf/moonshotai/kimi-k2.7-code` (tools, vision, reasoning)
- `@cf/moonshotai/kimi-k2.6` (tools, vision, reasoning)
- `@cf/zai-org/glm-5.2` (tools, reasoning)
- `@cf/google/gemma-4-26b-a4b-it` (tools, vision, reasoning)
- `@cf/openai/gpt-oss-120b` (tools, reasoning)

## Setup

1. Install the extension.
2. Open VS Code command palette (`Ctrl+Shift+P`).
3. Run **Cloudflare AI: Manage Account** → **Add / Update Account**.
4. Enter your Cloudflare Account ID, API Token, and a label.
5. Models will appear in the Copilot model picker.

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

## License

MIT
