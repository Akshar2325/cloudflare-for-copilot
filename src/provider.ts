import * as vscode from "vscode";
import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelResponsePart,
	Progress,
} from "vscode";

import type { ReasoningEffortLevel } from "./types";
import { type CloudflareModelDefinition, getCloudflareModels, getModelById } from "./models";
import type { CloudflareAccountManager } from "./accountManager";

// ─── Minimal OpenAI types (just what we need for proxy) ──────────────────────

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
	tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

interface OpenAITool {
	type: "function";
	function: { name: string; description: string; parameters: object };
}

// ─── Model Configuration Schema for reasoning effort ─────────────────────────

interface ModelConfigurationSchema {
	type: "object";
	properties: {
		reasoningEffort: {
			type: "string";
			title: string;
			enum: string[];
			enumItemLabels: string[];
			enumDescriptions: string[];
			default: string;
			group: "navigation";
		};
	};
}

interface ModelInfoWithSchema extends LanguageModelChatInformation {
	configurationSchema?: ModelConfigurationSchema;
	isUserSelectable?: boolean;
}

// ─── Minimal message conversion ──────────────────────────────────────────────
// VS Code sends LanguageModelChatRequestMessage[], we convert to OpenAI format.
// No heavy sanitization — just basic conversion. VS Code handles the rest.

function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];

	for (const message of messages) {
		const role =
			message.role === vscode.LanguageModelChatMessageRole.User
				? "user"
				: message.role === vscode.LanguageModelChatMessageRole.Assistant
					? "assistant"
					: "system";

		const textParts: string[] = [];
		const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
		const toolResults: Array<{ callId: string; content: string }> = [];

		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				let args = "{}";
				try {
					args = JSON.stringify(part.input ?? {});
				} catch {
					/* keep default */
				}
				toolCalls.push({
					id: part.callId,
					type: "function",
					function: { name: part.name, arguments: args },
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let text = "";
				for (const contentPart of part.content ?? []) {
					if (contentPart instanceof vscode.LanguageModelTextPart) {
						text += contentPart.value;
					} else if (typeof contentPart === "string") {
						text += contentPart;
					}
				}
				toolResults.push({ callId: part.callId, content: text });
			}
		}

		// Emit assistant tool calls
		if (toolCalls.length > 0) {
			out.push({ role: "assistant", content: textParts.join("") || undefined, tool_calls: toolCalls });
		}

		// Emit tool results
		for (const result of toolResults) {
			out.push({ role: "tool", tool_call_id: result.callId, content: result.content || "" });
		}

		// Emit text-only messages
		if (toolCalls.length === 0 && toolResults.length === 0) {
			const text = textParts.join("");
			if (text) {
				out.push({ role, content: text });
			}
		}
	}

	return out;
}

/**
 * Convert VS Code tools to OpenAI function tools. Minimal — no schema sanitization.
 */
function convertTools(options: vscode.LanguageModelChatRequestHandleOptions): OpenAITool[] | undefined {
	const tools = options.tools ?? [];
	if (tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : "",
			parameters: (tool.inputSchema as object) ?? { type: "object", properties: {} },
		},
	}));
}

function buildReasoningSchema(model: CloudflareModelDefinition): ModelConfigurationSchema | undefined {
	if (!model.supportsReasoningEffort) {
		return undefined;
	}
	return {
		type: "object",
		properties: {
			reasoningEffort: {
				type: "string",
				title: "Thinking Effort",
				enum: ["off", "low", "medium", "high"],
				enumItemLabels: ["Off", "Low", "Medium", "High"],
				enumDescriptions: [
					"Fastest responses",
					"Lighter reasoning",
					"Balanced reasoning and speed",
					"Deep reasoning, slower",
				],
				default: "off",
				group: "navigation",
			},
		},
	};
}

function extractReasoningEffort(
	options: vscode.LanguageModelChatRequestHandleOptions
): ReasoningEffortLevel | undefined {
	const carrier = options as unknown as {
		modelConfiguration?: { reasoningEffort?: unknown };
		request?: { modelConfiguration?: { reasoningEffort?: unknown } };
	};
	const effort = carrier.modelConfiguration?.reasoningEffort ?? carrier.request?.modelConfiguration?.reasoningEffort;
	if (effort === "off" || effort === "low" || effort === "medium" || effort === "high") {
		return effort;
	}
	return undefined;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class CloudflareLanguageModelChatProvider implements LanguageModelChatProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelInformation = this.onDidChangeEmitter.event;
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	constructor(
		private readonly accountManager: CloudflareAccountManager,
		private readonly outputChannel: vscode.OutputChannel
	) {}

	refreshModels(): void {
		this.onDidChangeEmitter.fire();
	}

	// ── Model Discovery ──────────────────────────────────────────────────────

	async prepareLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		const accounts = await this.accountManager.getRoutableAccounts();
		if (accounts.length === 0) {
			return [];
		}
		if (token.isCancellationRequested) {
			return [];
		}

		const models = getCloudflareModels();
		return models.map((model): ModelInfoWithSchema => {
			const info: ModelInfoWithSchema = {
				id: model.id,
				name: model.displayName,
				family: "cloudflare-workers-ai",
				version: "1.0.0",
				detail: model.description,
				tooltip: model.cfModelId,
				maxInputTokens: Math.max(1, model.contextWindow - model.maxOutputTokens),
				maxOutputTokens: model.maxOutputTokens,
				capabilities: {
					toolCalling: model.supportsTools,
					imageInput: model.supportsVision,
				},
				isUserSelectable: true,
			};
			const schema = buildReasoningSchema(model);
			if (schema) {
				info.configurationSchema = schema;
			}
			return info;
		});
	}

	// Compatibility shim for older VS Code
	provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: CancellationToken
	): vscode.ProviderResult<LanguageModelChatInformation[]> {
		return this.prepareLanguageModelChatInformation(options, token);
	}

	// ── Response (Proxy) ─────────────────────────────────────────────────────

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.LanguageModelChatRequestHandleOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		const selectedModel = getModelById(model.id);
		if (!selectedModel) {
			throw new Error(`Unknown Cloudflare model: ${model.id}`);
		}

		const routableAccounts = await this.accountManager.getRoutableAccounts();
		if (routableAccounts.length === 0) {
			throw new Error("No Cloudflare accounts configured. Use Cloudflare AI: Manage Provider to add accounts.");
		}

		const config = vscode.workspace.getConfiguration("cloudflareAI");
		const temperature = config.get<number>("temperature", 0.2);
		const requestTimeoutMs = Math.max(1, config.get<number>("requestTimeoutSeconds", 600)) * 1000;
		const streamIdleTimeoutMs = Math.max(1, config.get<number>("streamIdleTimeoutSeconds", 120)) * 1000;
		const debugLogging = config.get<boolean>("debugLogging", false);
		const reasoningEffort = extractReasoningEffort(options);

		// Build minimal payload — VS Code already gives us well-formed data
		const payload: Record<string, unknown> = {
			model: selectedModel.cfModelId,
			messages: convertMessages(messages),
			stream: true,
			temperature,
			max_tokens: selectedModel.maxOutputTokens,
		};

		// Add tools if model supports them
		if (selectedModel.supportsTools) {
			const tools = convertTools(options);
			if (tools && tools.length > 0) {
				payload.tools = tools;
				if (options.toolMode === vscode.LanguageModelChatToolMode.Required && tools.length === 1) {
					payload.tool_choice = { type: "function", function: { name: tools[0].function.name } };
				} else {
					payload.tool_choice = "auto";
				}
			}
		}

		// Add reasoning effort
		if (selectedModel.supportsReasoningEffort && reasoningEffort && reasoningEffort !== "off") {
			payload.reasoning_effort = reasoningEffort;
		}

		// Add chat_template_kwargs for Kimi models
		if (selectedModel.supportsChatTemplateKwargs && reasoningEffort && reasoningEffort !== "off") {
			payload.chat_template_kwargs = { enable_thinking: true };
		}

		// Try each account in rotation
		let lastError: Error | undefined;
		const candidateSummaries: string[] = [];

		for (const { account, token: apiToken } of routableAccounts) {
			candidateSummaries.push(`${account.accountId.slice(0, 8)}... (${account.label})`);
			const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/v1/chat/completions`;

			const result = await this.proxyRequest(
				endpoint,
				apiToken,
				payload,
				requestTimeoutMs,
				streamIdleTimeoutMs,
				progress,
				token,
				debugLogging
			);

			if (result.ok) {
				// Clear exhaustion if this account was previously exhausted
				if (account.isExhausted) {
					await this.accountManager.clearExhaustion(account.id);
				}
				return;
			}

			if (result.status === 429) {
				await this.accountManager.markExhausted(account.id);
				lastError = new Error(`Today's credits ended for "${account.label}". Trying next account...`);
				continue;
			}

			if (result.status === 401 || result.status === 403) {
				lastError = new Error(`Invalid API token for account "${account.label}".`);
				continue;
			}

			if (result.status >= 500) {
				lastError = new Error(`Cloudflare server error ${result.status} on "${account.label}".`);
				continue;
			}

			throw new Error(result.message);
		}

		throw lastError ?? new Error(`All Cloudflare accounts failed. Candidates: ${candidateSummaries.join(", ")}`);
	}

	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		}
		let total = 0;
		for (const part of text.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += Math.ceil(part.value.length / 4);
			}
		}
		return total;
	}

	// ── Proxy Request ────────────────────────────────────────────────────────
	// Just forward the payload to Cloudflare and stream the response back.
	// No payload sanitization. No response transformation.

	private async proxyRequest(
		endpoint: string,
		apiToken: string,
		payload: Record<string, unknown>,
		requestTimeoutMs: number,
		streamIdleTimeoutMs: number,
		progress: Progress<LanguageModelResponsePart>,
		requestToken: CancellationToken,
		debugLogging: boolean
	): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
		const abortController = new AbortController();
		const cancelSub = requestToken.onCancellationRequested(() => abortController.abort());
		const requestTimer = setTimeout(() => abortController.abort(), requestTimeoutMs);

		try {
			if (debugLogging) {
				this.outputChannel.appendLine(`[proxy] POST ${endpoint}`);
				this.outputChannel.appendLine(`[proxy] payload: ${JSON.stringify(payload).slice(0, 2000)}`);
			}

			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: abortController.signal,
			});

			if (!response.ok) {
				const details = await response.text().catch(() => "");
				this.outputChannel.appendLine(`[proxy] ERROR ${response.status}: ${details.slice(0, 500)}`);
				return {
					ok: false,
					status: response.status,
					message: `Cloudflare API ${response.status}: ${details || response.statusText}`,
				};
			}

			if (!response.body) {
				return { ok: false, status: 520, message: "Cloudflare response body is empty." };
			}

			await this.streamSSE(response.body, progress, abortController, streamIdleTimeoutMs, debugLogging);
			return { ok: true };
		} catch (error) {
			if ((error as { name?: string }).name === "AbortError") {
				return { ok: false, status: 499, message: "Request was cancelled or timed out." };
			}
			return { ok: false, status: 520, message: error instanceof Error ? error.message : "Unknown error." };
		} finally {
			clearTimeout(requestTimer);
			cancelSub.dispose();
		}
	}

	/**
	 * Stream SSE response from Cloudflare and forward to VS Code progress.
	 * Minimal processing — just parse SSE lines and forward content deltas.
	 */
	private async streamSSE(
		body: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart>,
		abortController: AbortController,
		streamIdleTimeoutMs: number,
		debugLogging: boolean
	): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

		const resetIdleTimer = () => {
			if (idleTimer !== undefined) {
				clearTimeout(idleTimer);
			}
			idleTimer = setTimeout(() => abortController.abort(), streamIdleTimeoutMs);
		};

		const flushToolCalls = () => {
			for (const [, call] of toolCalls) {
				if (!call.id || !call.name) {
					continue;
				}
				let parsedInput: Record<string, unknown> = {};
				try {
					parsedInput = JSON.parse(call.arguments || "{}");
				} catch {
					/* keep empty */
				}
				progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedInput));
			}
		};

		try {
			resetIdleTimer();
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				resetIdleTimer();
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const rawLine of lines) {
					const line = rawLine.trim();
					if (!line || line.startsWith(":")) {
						continue;
					}
					if (line === "data: [DONE]") {
						flushToolCalls();
						return;
					}
					if (!line.startsWith("data: ")) {
						continue;
					}

					const jsonStr = line.slice(6);
					if (debugLogging) {
						this.outputChannel.appendLine(`[sse] ${jsonStr.slice(0, 500)}`);
					}

					try {
						const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
						const choices = parsed.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
						if (!choices || choices.length === 0) {
							continue;
						}

						const delta = choices[0].delta;
						if (!delta || typeof delta !== "object") {
							continue;
						}

						// Content delta
						if (typeof delta.content === "string" && delta.content) {
							progress.report(new vscode.LanguageModelTextPart(delta.content));
						}

						// Tool call delta
						if (Array.isArray(delta.tool_calls)) {
							for (const tc of delta.tool_calls as Array<{
								index?: number;
								id?: string;
								function?: { name?: string; arguments?: string };
							}>) {
								const idx = tc.index ?? 0;
								if (!toolCalls.has(idx)) {
									toolCalls.set(idx, { id: "", name: "", arguments: "" });
								}
								const existing = toolCalls.get(idx)!;
								if (tc.id) {
									existing.id = tc.id;
								}
								if (tc.function?.name) {
									existing.name += tc.function.name;
								}
								if (tc.function?.arguments) {
									existing.arguments += tc.function.arguments;
								}
							}
						}

						// Reasoning/thinking delta (some models stream thinking separately)
						if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
							// Some models stream thinking as a separate field — we ignore it for now
							// as VS Code doesn't have a native way to display it yet
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}

			// Flush any remaining tool calls
			flushToolCalls();
		} finally {
			if (idleTimer !== undefined) {
				clearTimeout(idleTimer);
			}
		}
	}
}
