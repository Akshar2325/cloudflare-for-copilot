/**
 * Cloudflare Workers AI Model Catalog
 *
 * Centralized model definitions for all supported Cloudflare Workers AI models.
 * Cloudflare Workers AI exposes an OpenAI-compatible API at:
 *   https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions
 *
 * Models support reasoning via:
 *   - reasoning_effort: "low" | "medium" | "high"
 *   - chat_template_kwargs: { enable_thinking: boolean }  (Kimi models)
 */

export interface CloudflareModelDefinition {
	/** Unique identifier for VS Code */
	id: string;
	/** Cloudflare model ID (e.g., @cf/moonshotai/kimi-k2.7-code) */
	cfModelId: string;
	/** Display name in VS Code model picker */
	displayName: string;
	/** Maximum context window in tokens */
	contextWindow: number;
	/** Maximum output tokens */
	maxOutputTokens: number;
	/** Supports tool/function calling */
	supportsTools: boolean;
	/** Supports vision/image input */
	supportsVision: boolean;
	/** Supports reasoning/thinking */
	supportsReasoning: boolean;
	/** Supports reasoning_effort parameter (low/medium/high) */
	supportsReasoningEffort: boolean;
	/** Supports chat_template_kwargs with enable_thinking (Kimi models) */
	supportsChatTemplateKwargs: boolean;
	/** Description for tooltip */
	description: string;
}

/**
 * Curated list of Cloudflare Workers AI models.
 * Add new models here to make them available in VS Code.
 */
export const CLOUDFLARE_MODELS: CloudflareModelDefinition[] = [
	{
		id: "cf-kimi-k2.7-code",
		cfModelId: "@cf/moonshotai/kimi-k2.7-code",
		displayName: "Cloudflare: Kimi K2.7 Code",
		contextWindow: 262144,
		maxOutputTokens: 32768,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		supportsReasoningEffort: true,
		supportsChatTemplateKwargs: true,
		description: "262K context, tools + reasoning + vision",
	},
	{
		id: "cf-kimi-k2.6",
		cfModelId: "@cf/moonshotai/kimi-k2.6",
		displayName: "Cloudflare: Kimi K2.6",
		contextWindow: 262144,
		maxOutputTokens: 65536,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		supportsReasoningEffort: true,
		supportsChatTemplateKwargs: true,
		description: "262K context, tools + reasoning + vision",
	},
	{
		id: "cf-glm-5.2",
		cfModelId: "@cf/zai-org/glm-5.2",
		displayName: "Cloudflare: GLM 5.2",
		contextWindow: 262144,
		maxOutputTokens: 16384,
		supportsTools: true,
		supportsVision: false,
		supportsReasoning: true,
		supportsReasoningEffort: true,
		supportsChatTemplateKwargs: false,
		description: "262K context, tools + reasoning",
	},
	{
		id: "cf-gemma-4-26b",
		cfModelId: "@cf/google/gemma-4-26b-a4b-it",
		displayName: "Cloudflare: Gemma 4 26B",
		contextWindow: 256000,
		maxOutputTokens: 16384,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		supportsReasoningEffort: true,
		supportsChatTemplateKwargs: false,
		description: "256K context, tools + reasoning + vision",
	},
	{
		id: "cf-gpt-oss-120b",
		cfModelId: "@cf/openai/gpt-oss-120b",
		displayName: "Cloudflare: GPT-OSS 120B",
		contextWindow: 131072,
		maxOutputTokens: 16384,
		supportsTools: true,
		supportsVision: false,
		supportsReasoning: true,
		supportsReasoningEffort: false,
		supportsChatTemplateKwargs: false,
		description: "128K context, tools + reasoning",
	},
];

/**
 * Get all available Cloudflare models (deduplicated).
 */
export function getCloudflareModels(): CloudflareModelDefinition[] {
	const seenIds = new Set<string>();
	const seenCfModelIds = new Set<string>();
	const deduped: CloudflareModelDefinition[] = [];

	for (const model of CLOUDFLARE_MODELS) {
		if (seenIds.has(model.id) || seenCfModelIds.has(model.cfModelId)) {
			continue;
		}
		seenIds.add(model.id);
		seenCfModelIds.add(model.cfModelId);
		deduped.push(model);
	}

	return deduped;
}

/**
 * Find a model by its VS Code ID.
 */
export function getModelById(id: string): CloudflareModelDefinition | undefined {
	return getCloudflareModels().find((model) => model.id === id);
}
