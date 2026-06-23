export interface CloudflareAccount {
	id: string;
	accountId: string;
	label: string;
	isExhausted: boolean;
	exhaustedAt?: number;
	source?: "managed" | "settings" | "providerConfig";
}

export interface CloudflareSyncedAccount {
	accountId: string;
	apiToken: string;
	label?: string;
}

export type ReasoningMode = "off" | "auto" | "on";
export type ReasoningEffort = "low" | "medium" | "high";

export interface CloudflareModelDefinition {
	id: string;
	cfModelId: string;
	displayName: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsVision: boolean;
	supportsReasoning: boolean;
	supportsReasoningEffort?: boolean;
	description?: string;
}

export interface CloudflareCatalogModelInput {
	id?: string;
	cfModelId: string;
	displayName?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	supportsTools?: boolean;
	supportsVision?: boolean;
	supportsReasoning?: boolean;
	description?: string;
}

export interface OpenAITextContent {
	type: "text";
	text: string;
}

export interface OpenAIImageContent {
	type: "image_url";
	image_url: { url: string };
}

export type OpenAIContent = string | Array<OpenAITextContent | OpenAIImageContent>;

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: OpenAIContent;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

export interface OpenAIFunctionTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: object;
	};
}
