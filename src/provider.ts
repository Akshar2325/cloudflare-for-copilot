import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatProvider,
    LanguageModelResponsePart,
    Progress,
} from "vscode";

import type {
    CloudflareModelDefinition,
    OpenAIFunctionTool,
    OpenAIImageContent,
    OpenAIMessage,
    OpenAIToolCall,
    OpenAITextContent,
} from "./types";
import { getConfiguredModelCatalog, getModelById } from "./models";
import type { CloudflareAccountManager } from "./accountManager";

interface ImageDataPart {
    data: unknown;
    mimeType: string;
}

interface StreamDelta {
    content?: string;
    toolCalls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface ProviderConfigShape {
    accountId?: unknown;
    apiToken?: unknown;
}

interface RequestOptionsWithConfiguration extends vscode.LanguageModelChatRequestHandleOptions {
    configuration?: ProviderConfigShape;
}

interface PrepareOptionsWithConfiguration extends vscode.PrepareLanguageModelChatModelOptions {
    configuration?: ProviderConfigShape;
}

type ReasoningEffortLevel = "off" | "low" | "medium" | "high";

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

interface RequestConfigurationCarrier {
    modelConfiguration?: { reasoningEffort?: unknown };
    request?: { modelConfiguration?: { reasoningEffort?: unknown } };
}

interface RequestDiagnosticEntry {
    at: number;
    modelId: string;
    configuredCredentials: boolean;
    candidates: string[];
    result: string;
}

function isImageDataPart(value: unknown): value is ImageDataPart {
    if (!value || typeof value !== "object") {
        return false;
    }
    const part = value as Record<string, unknown>;
    return part.data != null
        && typeof part.data === "object"
        && typeof part.mimeType === "string"
        && part.mimeType.startsWith("image/");
}

function toBase64DataUrl(data: unknown, mimeType: string): string {
    const bytes = data instanceof Uint8Array
        ? data
        : new Uint8Array(Object.values(data as Record<string, number>));
    const base64 = Buffer.from(bytes).toString("base64");
    return `data:${mimeType};base64,${base64}`;
}

function sanitizeToolName(name: string): string {
    const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
    if (/^[a-zA-Z]/.test(normalized)) {
        return normalized.slice(0, 64);
    }
    return `tool_${normalized.slice(0, 59)}`;
}

function convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    supportsVision: boolean
): OpenAIMessage[] {
    const out: OpenAIMessage[] = [];

    for (const message of messages) {
        const isUser = message.role === vscode.LanguageModelChatMessageRole.User;
        const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
        if (!isUser && !isAssistant) {
            continue;
        }
        const role: OpenAIMessage["role"] = isUser ? "user" : "assistant";

        const textParts: string[] = [];
        const imageParts: OpenAIImageContent[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const toolResults: { callId: string; content: string }[] = [];

        for (const part of message.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
                continue;
            }

            if (supportsVision && isImageDataPart(part)) {
                imageParts.push({
                    type: "image_url",
                    image_url: { url: toBase64DataUrl(part.data, part.mimeType) },
                });
                continue;
            }

            if (part instanceof vscode.LanguageModelToolCallPart) {
                let args = "{}";
                try {
                    args = JSON.stringify(part.input ?? {});
                } catch {
                    args = "{}";
                }
                toolCalls.push({
                    id: part.callId,
                    type: "function",
                    function: {
                        name: sanitizeToolName(part.name),
                        arguments: args,
                    },
                });
                continue;
            }

            if (part instanceof vscode.LanguageModelToolResultPart) {
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

        if (toolCalls.length > 0) {
            const text = textParts.join("");
            out.push({ role: "assistant", content: text || undefined, tool_calls: toolCalls });
        }

        for (const result of toolResults) {
            out.push({ role: "tool", tool_call_id: result.callId, content: result.content || "" });
        }

        if (toolCalls.length === 0 && toolResults.length === 0) {
            const text = textParts.join("");
            if (imageParts.length > 0) {
                const content: Array<OpenAITextContent | OpenAIImageContent> = [];
                if (text) {
                    content.push({ type: "text", text });
                }
                content.push(...imageParts);
                out.push({ role, content });
            } else if (text) {
                out.push({ role, content: text });
            }
        }
    }

    return out;
}

function convertTools(options: vscode.LanguageModelChatRequestHandleOptions): OpenAIFunctionTool[] | undefined {
    const tools = options.tools ?? [];
    if (tools.length === 0) {
        return undefined;
    }
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: sanitizeToolName(tool.name),
            description: typeof tool.description === "string" ? tool.description : "",
            parameters: (tool.inputSchema as object) ?? { type: "object", properties: {} },
        },
    }));
}

function modelConfigurationSchema(model: CloudflareModelDefinition): ModelConfigurationSchema | undefined {
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

function requestReasoningEffort(options: vscode.LanguageModelChatRequestHandleOptions): ReasoningEffortLevel | undefined {
    const configCarrier = options as unknown as RequestConfigurationCarrier;
    const effort = configCarrier.modelConfiguration?.reasoningEffort
        ?? configCarrier.request?.modelConfiguration?.reasoningEffort;

    if (effort === "off" || effort === "low" || effort === "medium" || effort === "high") {
        return effort;
    }
    return undefined;
}

function requestConfiguredCredentials(options: vscode.LanguageModelChatRequestHandleOptions): { accountId: string; apiToken: string } | undefined {
    const config = (options as RequestOptionsWithConfiguration).configuration;
    if (!config || typeof config !== "object") {
        return undefined;
    }

    const accountId = typeof config.accountId === "string" ? config.accountId.trim() : "";
    const apiToken = typeof config.apiToken === "string" ? config.apiToken.trim() : "";

    if (!accountId || !apiToken) {
        return undefined;
    }
    return { accountId, apiToken };
}

function prepareConfiguredCredentials(options: vscode.PrepareLanguageModelChatModelOptions): { accountId: string; apiToken: string } | undefined {
    const config = (options as PrepareOptionsWithConfiguration).configuration;
    if (!config || typeof config !== "object") {
        return undefined;
    }

    const accountId = typeof config.accountId === "string" ? config.accountId.trim() : "";
    const apiToken = typeof config.apiToken === "string" ? config.apiToken.trim() : "";
    if (!accountId || !apiToken) {
        return undefined;
    }

    return { accountId, apiToken };
}

export class CloudflareLanguageModelChatProvider implements LanguageModelChatProvider {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    private preferredDiscoveryMethod?: "prepare" | "legacy";
    private readonly requestDiagnostics: RequestDiagnosticEntry[] = [];
    readonly onDidChangeLanguageModelInformation = this.onDidChangeEmitter.event;
    readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

    constructor(
        private readonly accountManager: CloudflareAccountManager,
        private readonly outputChannel: vscode.OutputChannel,
    ) { }

    refreshModels(): void {
        this.onDidChangeEmitter.fire();
    }

    getRecentRequestDiagnostics(): string[] {
        if (this.requestDiagnostics.length === 0) {
            return ["No request diagnostics recorded yet."];
        }

        return this.requestDiagnostics
            .slice()
            .reverse()
            .map((entry) => {
                const time = new Date(entry.at).toLocaleTimeString();
                const configured = entry.configuredCredentials ? "provider-config=yes" : "provider-config=no";
                const candidates = entry.candidates.length > 0 ? entry.candidates.join(" -> ") : "none";
                return `[${time}] model=${entry.modelId} ${configured} candidates=${candidates} result=${entry.result}`;
            });
    }

    clearRequestDiagnostics(): void {
        this.requestDiagnostics.length = 0;
    }

    private pushRequestDiagnostic(entry: RequestDiagnosticEntry): void {
        this.requestDiagnostics.push(entry);
        if (this.requestDiagnostics.length > 50) {
            this.requestDiagnostics.shift();
        }
    }

    private shouldSuppressDuplicateModelDiscovery(method: "prepare" | "legacy"): boolean {
        if (!this.preferredDiscoveryMethod) {
            this.preferredDiscoveryMethod = method;
            return false;
        }
        return this.preferredDiscoveryMethod !== method;
    }

    private async resolveModelInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: CancellationToken,
        method: "prepare" | "legacy"
    ): Promise<LanguageModelChatInformation[]> {
        if (this.shouldSuppressDuplicateModelDiscovery(method)) {
            return [];
        }

        await this.accountManager.syncAccountsFromSettings();
        const configuredCredentials = prepareConfiguredCredentials(options);
        if (configuredCredentials) {
            await this.accountManager.upsertProviderConfigurationAccount(
                configuredCredentials.accountId,
                configuredCredentials.apiToken
            );
        }

        // When a configured provider instance exists (Language Models JSON entry),
        // suppress generic vendor listing to avoid duplicate model groups.
        if (!configuredCredentials && this.accountManager.hasProviderConfigurationShadows()) {
            return [];
        }

        const routedAccounts = await this.accountManager.getRoutableAccounts();

        if (!configuredCredentials && routedAccounts.length === 0) {
            return [];
        }

        if (token.isCancellationRequested) {
            return [];
        }

        const models: CloudflareModelDefinition[] = getConfiguredModelCatalog();
        return models.map((model): LanguageModelChatInformation => {
            const info: ModelInfoWithSchema = {
                id: model.id,
                name: model.displayName,
                family: "cloudflare-workers-ai",
                version: "1.0.0",
                detail: model.description,
                tooltip: `${model.cfModelId}`,
                maxInputTokens: Math.max(1, model.contextWindow - model.maxOutputTokens),
                maxOutputTokens: model.maxOutputTokens,
                capabilities: {
                    toolCalling: model.supportsTools,
                    imageInput: model.supportsVision,
                },
                isUserSelectable: true,
            };

            const schema = modelConfigurationSchema(model);
            if (schema) {
                info.configurationSchema = schema;
            }

            return info;
        });
    }

    async prepareLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        return this.resolveModelInformation(options, token, "prepare");
    }

    // Compatibility shim for older VS Code builds that still call this method name.
    provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: CancellationToken
    ): vscode.ProviderResult<LanguageModelChatInformation[]> {
        return this.resolveModelInformation(options, token, "legacy");
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.LanguageModelChatRequestHandleOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        const catalog: CloudflareModelDefinition[] = getConfiguredModelCatalog();
        const selectedModel = getModelById(model.id, catalog);
        if (!selectedModel) {
            throw new Error(`Unknown Cloudflare model: ${model.id}`);
        }

        await this.accountManager.syncAccountsFromSettings();
        const configuredCredentials = requestConfiguredCredentials(options);
        if (configuredCredentials) {
            await this.accountManager.upsertProviderConfigurationAccount(
                configuredCredentials.accountId,
                configuredCredentials.apiToken
            );
        }
        const routedAccounts = await this.accountManager.getRoutableAccounts();

        const candidates: Array<{
            account: { id: string; label: string; accountId: string; isExhausted?: boolean };
            token: string;
            fromProviderConfig?: boolean;
        }> = [];
        const seenCandidateAccountIds = new Set<string>();

        const pushCandidate = (candidate: {
            account: { id: string; label: string; accountId: string; isExhausted?: boolean };
            token: string;
            fromProviderConfig?: boolean;
        }): void => {
            const accountId = candidate.account.accountId.trim();
            if (seenCandidateAccountIds.has(accountId)) {
                return;
            }
            seenCandidateAccountIds.add(accountId);
            candidates.push(candidate);
        };

        if (configuredCredentials) {
            pushCandidate({
                account: {
                    id: "provider-config",
                    label: "Language Models Config",
                    accountId: configuredCredentials.accountId,
                },
                token: configuredCredentials.apiToken,
                fromProviderConfig: true,
            });
        }

        for (const account of routedAccounts) {
            pushCandidate(account);
        }

        const candidateSummary = candidates.map((candidate) => {
            const source = candidate.fromProviderConfig ? "provider-config" : "managed/settings";
            return `${candidate.account.accountId}:${source}`;
        });

        if (candidates.length === 0) {
            this.pushRequestDiagnostic({
                at: Date.now(),
                modelId: model.id,
                configuredCredentials: !!configuredCredentials,
                candidates: candidateSummary,
                result: "failed:no-candidates",
            });
            throw new Error("No usable Cloudflare credentials found. Configure provider Account ID + API Token in Language Models or add managed accounts.");
        }

        const config = vscode.workspace.getConfiguration("cloudflareAI");
        const temperature = config.get<number>("temperature", 0.2);
        const requestTimeoutMs = Math.max(1, config.get<number>("requestTimeoutSeconds", 600)) * 1000;
        const streamIdleTimeoutMs = Math.max(1, config.get<number>("streamIdleTimeoutSeconds", 120)) * 1000;
        const debugLogging = config.get<boolean>("debugLogging", false);
        const requestedReasoningEffort = requestReasoningEffort(options);

        const payload = this.buildPayload(selectedModel, messages, options, temperature, requestedReasoningEffort);
        let lastError: Error | undefined;

        for (const candidate of candidates) {
            const endpoint = `https://api.cloudflare.com/client/v4/accounts/${candidate.account.accountId}/ai/v1/chat/completions`;
            const result = await this.callWithStreaming(
                endpoint,
                candidate.token,
                payload,
                requestTimeoutMs,
                streamIdleTimeoutMs,
                progress,
                token,
                debugLogging
            );

            if (result.ok) {
                this.pushRequestDiagnostic({
                    at: Date.now(),
                    modelId: model.id,
                    configuredCredentials: !!configuredCredentials,
                    candidates: candidateSummary,
                    result: `success:${candidate.account.accountId}`,
                });
                if (!candidate.fromProviderConfig && candidate.account.isExhausted) {
                    await this.accountManager.clearExhaustion(candidate.account.id);
                }
                return;
            }

            if (result.status === 429) {
                if (!candidate.fromProviderConfig) {
                    await this.accountManager.markExhausted(candidate.account.id);
                }
                lastError = new Error(`Quota exhausted for account "${candidate.account.label}".`);
                continue;
            }

            if (result.status === 401 || result.status === 403) {
                lastError = new Error(`Unauthorized token for account "${candidate.account.label}".`);
                continue;
            }

            if (result.status >= 500 && result.status < 600) {
                lastError = new Error(`Cloudflare server error ${result.status} on account "${candidate.account.label}".`);
                continue;
            }

            throw new Error(result.message);
        }

        this.pushRequestDiagnostic({
            at: Date.now(),
            modelId: model.id,
            configuredCredentials: !!configuredCredentials,
            candidates: candidateSummary,
            result: `failed:${lastError?.message ?? "all-candidates-failed"}`,
        });

        throw lastError ?? new Error("All Cloudflare accounts failed for this request.");
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

    private buildPayload(
        model: CloudflareModelDefinition,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.LanguageModelChatRequestHandleOptions,
        temperature: number,
        requestedReasoningEffort?: ReasoningEffortLevel
    ): Record<string, unknown> {
        const openAiMessages = convertMessages(messages, model.supportsVision);
        const payload: Record<string, unknown> = {
            model: model.cfModelId,
            messages: openAiMessages,
            stream: true,
            temperature,
            max_tokens: model.maxOutputTokens,
        };

        if (model.supportsTools) {
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

        if (model.supportsReasoningEffort && requestedReasoningEffort && requestedReasoningEffort !== "off") {
            payload.reasoning_effort = requestedReasoningEffort;
        }

        return payload;
    }

    private async callWithStreaming(
        endpoint: string,
        tokenValue: string,
        payload: Record<string, unknown>,
        requestTimeoutMs: number,
        streamIdleTimeoutMs: number,
        progress: Progress<LanguageModelResponsePart>,
        requestToken: CancellationToken,
        debugLogging: boolean
    ): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
        const abortController = new AbortController();
        const cancelSubscription = requestToken.onCancellationRequested(() => abortController.abort());
        const requestTimer = setTimeout(() => abortController.abort(), requestTimeoutMs);

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${tokenValue}`,
                    "Content-Type": "application/json",
                    "User-Agent": "cloudflare-copilot/1.0.0",
                },
                body: JSON.stringify(payload),
                signal: abortController.signal,
            });

            if (!response.ok) {
                const details = await response.text().catch(() => "");
                return {
                    ok: false,
                    status: response.status,
                    message: `Cloudflare API ${response.status}: ${details || response.statusText}`,
                };
            }

            if (!response.body) {
                return { ok: false, status: 520, message: "Cloudflare response body is empty." };
            }

            await this.streamResponse(response.body, progress, abortController, streamIdleTimeoutMs, debugLogging);
            return { ok: true };
        } catch (error) {
            if ((error as { name?: string }).name === "AbortError") {
                return { ok: false, status: 499, message: "Request was cancelled or timed out." };
            }
            return {
                ok: false,
                status: 520,
                message: error instanceof Error ? error.message : "Unknown request error.",
            };
        } finally {
            clearTimeout(requestTimer);
            cancelSubscription.dispose();
        }
    }

    private async streamResponse(
        body: ReadableStream<Uint8Array>,
        progress: Progress<LanguageModelResponsePart>,
        abortController: AbortController,
        streamIdleTimeoutMs: number,
        debugLogging: boolean,
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
                    parsedInput = {};
                }
                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedInput));
            }
        };

        try {
            resetIdleTimer();
            streamLoop: while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                resetIdleTimer();
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) {
                        continue;
                    }
                    if (line === "data: [DONE]") {
                        break streamLoop;
                    }

                    if (debugLogging) {
                        this.outputChannel.appendLine(line);
                    }

                    const delta = this.parseDelta(line);
                    if (!delta) {
                        continue;
                    }

                    if (delta.content) {
                        progress.report(new vscode.LanguageModelTextPart(delta.content));
                    }
                    for (const part of delta.toolCalls ?? []) {
                        const index = typeof part.index === "number" ? part.index : 0;
                        if (!toolCalls.has(index)) {
                            toolCalls.set(index, { id: "", name: "", arguments: "" });
                        }
                        const current = toolCalls.get(index)!;
                        if (part.id) {
                            current.id = part.id;
                        }
                        if (part.function?.name) {
                            current.name += part.function.name;
                        }
                        if (part.function?.arguments) {
                            current.arguments += part.function.arguments;
                        }
                    }
                }
            }

            flushToolCalls();
        } finally {
            if (idleTimer !== undefined) {
                clearTimeout(idleTimer);
            }
            reader.releaseLock();
        }
    }

    private parseDelta(line: string): StreamDelta | null {
        try {
            const payload = JSON.parse(line.slice(6)) as {
                choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string; tool_calls?: StreamDelta["toolCalls"] } }>;
            };
            const delta = payload?.choices?.[0]?.delta;
            if (!delta) {
                return null;
            }

            const out: StreamDelta = {};
            if (typeof delta.content === "string" && delta.content.length > 0) {
                out.content = delta.content;
            }
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                out.toolCalls = delta.tool_calls;
            }

            return out.content || out.toolCalls ? out : null;
        } catch {
            return null;
        }
    }
}
