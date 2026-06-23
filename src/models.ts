import type { CloudflareModelDefinition } from "./types";

export const CURATED_CLOUDFLARE_MODELS: CloudflareModelDefinition[] = [
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
        description: "128K context, tools + reasoning",
    },
];

export function getConfiguredModelCatalog(): CloudflareModelDefinition[] {
    const seenIds = new Set<string>();
    const seenCfModelIds = new Set<string>();
    const deduped: CloudflareModelDefinition[] = [];

    for (const model of CURATED_CLOUDFLARE_MODELS) {
        if (seenIds.has(model.id) || seenCfModelIds.has(model.cfModelId)) {
            continue;
        }
        seenIds.add(model.id);
        seenCfModelIds.add(model.cfModelId);
        deduped.push(model);
    }

    return deduped;
}

export function getModelById(id: string, catalog: CloudflareModelDefinition[]): CloudflareModelDefinition | undefined {
    return catalog.find((model) => model.id === id);
}
