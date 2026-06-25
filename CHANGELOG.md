# Change Log

## [1.0.1] - 2026-06-26

### Changelog & Build Improvements
- Added CHANGELOG.md to track release history
- Migrated build system from `tsc` to `esbuild` for better performance and security
- Production builds are now minified with tree-shaking and no source maps
- Added `repository`, `homepage`, and `bugs` fields to package.json
- Updated VSIX packaging pipeline for cleaner production output

## [1.0.0] - 2026-06-25

### Initial Release
- First published release to VS Code Marketplace
- Direct Cloudflare Workers AI API integration (`/ai/v1/chat/completions`)
- Curated model list: Kimi K2.7, Kimi K2.6, GLM 5.2, Gemma 4, GPT-OSS
- Reasoning and thinking support via `reasoning_effort` parameter
- Tool calling and vision passthrough for supported models
- Automatic quota exhaustion tracking with midnight UTC reset
- Local proxy server for secure API communication
- Account management via VS Code command palette
