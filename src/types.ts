export interface CloudflareAccount {
	id: string;
	accountId: string;
	apiToken: string;
	label: string;
	isExhausted: boolean;
	exhaustedAt?: number;
}

export type ReasoningEffortLevel = "off" | "low" | "medium" | "high";
