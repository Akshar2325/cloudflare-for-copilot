/**
 * Cloudflare AI Utilities
 *
 * Minimal utilities — most heavy sanitization has been removed since
 * VS Code now handles OpenAI-compatible format natively.
 */

import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { getCloudflareModels } from "./models";

/**
 * Try to parse a JSON object from a string.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Get the path to VS Code's chatLanguageModels.json file.
 */
export function getChatLanguageModelsPath(): string | undefined {
	const appDataPath = process.env.APPDATA || process.env.HOME;
	if (!appDataPath) {
		return undefined;
	}

	const isInsiders = vscode.env.appName.toLowerCase().includes("insider");
	const vscodeFolderName = isInsiders ? "Code - Insiders" : "Code";

	let userDataPath: string;
	if (process.platform === "win32") {
		userDataPath = path.join(appDataPath, vscodeFolderName, "User");
	} else if (process.platform === "darwin") {
		userDataPath = path.join(appDataPath, "Library", "Application Support", vscodeFolderName, "User");
	} else {
		const configPath = process.env.XDG_CONFIG_HOME || path.join(appDataPath, ".config");
		userDataPath = path.join(configPath, vscodeFolderName, "User");
	}

	return path.join(userDataPath, "chatLanguageModels.json");
}

/**
 * Write the Cloudflare provider group to chatLanguageModels.json.
 */
export function writeCloudflareModelsToChatLanguageModels(proxyPort: number): boolean {
	const filePath = getChatLanguageModelsPath();
	if (!filePath) {
		return false;
	}

	const groupName = "Cloudflare Workers AI";
	const baseUrl = `http://127.0.0.1:${proxyPort}/v1`;

	try {
		interface ProviderGroup {
			name: string;
			vendor: string;
			apiType?: string;
			models: Array<{
				id: string;
				name: string;
				url: string;
				toolCalling?: boolean;
				vision?: boolean;
				streaming?: boolean;
				thinking?: boolean;
				supportsReasoningEffort?: string[];
				maxInputTokens?: number;
				maxOutputTokens?: number;
			}>;
		}

		let providerGroups: ProviderGroup[] = [];

		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf8");
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				providerGroups = parsed;
			} else if (parsed && Array.isArray(parsed.value)) {
				providerGroups = parsed.value;
			}
		}

		const models = getCloudflareModels();
		const modelConfigs = models.map((m) => {
			const cfg: {
				id: string;
				name: string;
				url: string;
				toolCalling?: boolean;
				vision?: boolean;
				streaming?: boolean;
				thinking?: boolean;
				supportsReasoningEffort?: string[];
				maxInputTokens?: number;
				maxOutputTokens?: number;
			} = {
				id: m.id,
				name: m.displayName,
				url: baseUrl,
				toolCalling: m.supportsTools,
				vision: m.supportsVision,
				streaming: true,
				maxInputTokens: Math.max(1, m.contextWindow - m.maxOutputTokens),
				maxOutputTokens: m.maxOutputTokens,
			};
			if (m.supportsReasoning) {
				cfg.thinking = true;
			}
			if (m.supportsReasoningEffort) {
				cfg.supportsReasoningEffort = ["off", "low", "medium", "high"];
			}
			return cfg;
		});

		const existingIndex = providerGroups.findIndex((g) => g.name === groupName && g.vendor === "customendpoint");

		if (existingIndex >= 0) {
			providerGroups[existingIndex].models = modelConfigs;
			providerGroups[existingIndex].apiType = "chat-completions";
		} else {
			providerGroups.push({
				name: groupName,
				vendor: "customendpoint",
				apiType: "chat-completions",
				models: modelConfigs,
			});
		}

		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		fs.writeFileSync(filePath, JSON.stringify(providerGroups, null, 4), "utf8");
		return true;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[Cloudflare AI] Failed to write chatLanguageModels.json: ${msg}`);
		return false;
	}
}

/**
 * Remove the Cloudflare provider group from chatLanguageModels.json.
 */
export function removeCloudflareModelsFromChatLanguageModels(): boolean {
	const filePath = getChatLanguageModelsPath();
	if (!filePath || !fs.existsSync(filePath)) {
		return false;
	}

	const groupName = "Cloudflare Workers AI";

	try {
		const content = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(content);

		let providerGroups: Array<{ name?: string; vendor?: string }>;
		if (Array.isArray(parsed)) {
			providerGroups = parsed;
		} else if (parsed && Array.isArray(parsed.value)) {
			providerGroups = parsed.value;
		} else {
			return false;
		}

		const filtered = providerGroups.filter((g) => !(g.name === groupName && g.vendor === "customendpoint"));

		if (filtered.length === providerGroups.length) {
			return false;
		}

		fs.writeFileSync(filePath, JSON.stringify(filtered, null, 4), "utf8");
		return true;
	} catch {
		return false;
	}
}
