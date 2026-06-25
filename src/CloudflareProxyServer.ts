import * as http from "http";
import * as vscode from "vscode";
import { getModelById, getCloudflareModels } from "./models";
import type { CloudflareAccountManager } from "./accountManager";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProxyConfig {
	host: string;
	port: number;
}

// ─── Proxy Server ───────────────────────────────────────────────────────────
// Accepts OpenAI-compatible requests from VS Code's built-in customendpoint
// handler and routes them through Cloudflare accounts.

export class CloudflareProxyServer implements vscode.Disposable {
	private server: http.Server | undefined;
	private actualPort = 0;
	private readonly config: ProxyConfig;

	constructor(
		private readonly accountManager: CloudflareAccountManager,
		private readonly outputChannel: vscode.OutputChannel
	) {
		const cfg = vscode.workspace.getConfiguration("cloudflareAI");
		this.config = {
			host: cfg.get<string>("proxyHost", "127.0.0.1"),
			port: cfg.get<number>("proxyPort", 9300),
		};
	}

	get port(): number {
		return this.actualPort;
	}

	get running(): boolean {
		return !!this.server;
	}

	async start(): Promise<number> {
		if (this.server) {
			return this.actualPort;
		}

		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => {
				void this.handleRequest(req, res);
			});

			const maxAttempts = 10;
			let attempt = 0;
			const tryPort = () => {
				const port = this.config.port + attempt;
				this.server!.listen(port, this.config.host, () => {
					this.actualPort = port;
					this.outputChannel.appendLine(`[proxy] Listening on ${this.config.host}:${port}`);
					resolve(port);
				});
				this.server!.on("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE" && attempt < maxAttempts - 1) {
						attempt++;
						this.server!.close();
						this.server = http.createServer((req, res) => {
							void this.handleRequest(req, res);
						});
						tryPort();
					} else {
						this.server = undefined;
						reject(err);
					}
				});
			};
			tryPort();
		});
	}

	async stop(): Promise<void> {
		if (!this.server) {
			return;
		}
		return new Promise((resolve) => {
			this.server!.close(() => {
				this.server = undefined;
				this.actualPort = 0;
				resolve();
			});
		});
	}

	dispose(): void {
		void this.stop();
	}

	// ── Request Handler ─────────────────────────────────────────────────────

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			// CORS for local requests
			res.setHeader("Access-Control-Allow-Origin", "*");

			// Handle preflight
			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				});
				res.end();
				return;
			}

			const url = req.url ?? "/";

			// GET /v1/models — return model list for health checks
			if (req.method === "GET" && url === "/v1/models") {
				await this.handleModelsRequest(res);
				return;
			}

			// POST /v1/chat/completions — proxy to Cloudflare
			if (req.method === "POST" && url.endsWith("/chat/completions")) {
				await this.handleChatRequest(req, res);
				return;
			}

			// Health check
			if (req.method === "GET" && (url === "/" || url === "/health")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok", port: this.actualPort }));
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		} catch (error) {
			this.outputChannel.appendLine(`[proxy] Unhandled error: ${error}`);
			res.writeHead(500);
			res.end("Internal server error");
		}
	}

	// ── GET /v1/models ──────────────────────────────────────────────────────

	private async handleModelsRequest(res: http.ServerResponse): Promise<void> {
		const accounts = await this.accountManager.getRoutableAccounts();
		if (accounts.length === 0) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [] }));
			return;
		}

		const models = getCloudflareModels().map((m) => ({
			id: m.id,
			object: "model",
			created: Math.floor(Date.now() / 1000),
			owned_by: "cloudflare-workers-ai",
		}));

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: models }));
	}

	// ── POST /v1/chat/completions ────────────────────────────────────────────

	private async handleChatRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const debugLogging = vscode.workspace.getConfiguration("cloudflareAI").get<boolean>("debugLogging", false);

		// Read body
		const body = await this.readBody(req);
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(body);
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON body" }));
			return;
		}

		if (debugLogging) {
			this.outputChannel.appendLine(`[proxy] ← ${req.method} ${req.url}`);
			this.outputChannel.appendLine(`[proxy] ← payload: ${JSON.stringify(payload).slice(0, 2000)}`);
		}

		// Look up model
		const modelId = payload.model as string | undefined;
		if (!modelId) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing 'model' field" }));
			return;
		}

		const selectedModel = getModelById(modelId);
		if (!selectedModel) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Unknown model: ${modelId}` }));
			return;
		}

		// Get routable accounts
		const routableAccounts = await this.accountManager.getRoutableAccounts();
		if (routableAccounts.length === 0) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No Cloudflare accounts available" }));
			return;
		}

		// Build Cloudflare payload
		const config = vscode.workspace.getConfiguration("cloudflareAI");
		const requestTimeoutMs = Math.max(1, config.get<number>("requestTimeoutSeconds", 600)) * 1000;

		const cfPayload: Record<string, unknown> = {
			...payload,
			model: selectedModel.cfModelId,
			stream: true,
			max_tokens: payload.max_tokens ?? selectedModel.maxOutputTokens,
		};

		// Add chat_template_kwargs for Kimi models when reasoning is requested
		if (selectedModel.supportsChatTemplateKwargs) {
			const reasoningEffort = payload.reasoning_effort as string | undefined;
			if (reasoningEffort && reasoningEffort !== "off") {
				cfPayload.chat_template_kwargs = { enable_thinking: true };
			}
		}

		// Try each account in rotation
		let lastError: { message: string; status?: number } | undefined;
		const summaries: string[] = [];

		for (const { account, token: apiToken } of routableAccounts) {
			summaries.push(`${account.accountId.slice(0, 8)}... (${account.label})`);
			const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/v1/chat/completions`;

			const result = await this.proxyToCloudflare(endpoint, apiToken, cfPayload, requestTimeoutMs, debugLogging);

			if (result.ok) {
				// Stream response back to client
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"Access-Control-Allow-Origin": "*",
				});
				res.flushHeaders();

				// Forward SSE to client — write each chunk immediately
				const reader = result.stream.getReader();
				const decoder = new TextDecoder();

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							break;
						}
						const text = decoder.decode(value, { stream: true });
						res.write(text);
					}
				} catch {
					// Connection closed
				} finally {
					res.end();
					reader.releaseLock();
				}

				// Clear exhaustion on success
				if (account.isExhausted) {
					await this.accountManager.clearExhaustion(account.id);
				}
				return;
			}

			if (result.status === 429) {
				await this.accountManager.markExhausted(account.id);
				lastError = { message: `Today's credits ended for "${account.label}"`, status: 429 };
				continue;
			}

			if (result.status === 401 || result.status === 403) {
				lastError = { message: `Invalid API token for "${account.label}"`, status: result.status };
				continue;
			}

			if (result.status && result.status >= 500) {
				lastError = { message: `Cloudflare error ${result.status} on "${account.label}"`, status: result.status };
				continue;
			}

			lastError = { message: result.message, status: result.status };
		}

		// All accounts failed
		const errorMsg = lastError?.message ?? "All Cloudflare accounts failed";
		const statusCode = lastError?.status ?? 503;
		res.writeHead(statusCode, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: errorMsg, candidates: summaries }));
	}

	// ── Proxy to Cloudflare ─────────────────────────────────────────────────

	private async proxyToCloudflare(
		endpoint: string,
		apiToken: string,
		payload: Record<string, unknown>,
		requestTimeoutMs: number,
		debugLogging: boolean
	): Promise<{ ok: true; stream: ReadableStream<Uint8Array> } | { ok: false; status?: number; message: string }> {
		const abortController = new AbortController();
		const requestTimer = setTimeout(() => abortController.abort(), requestTimeoutMs);

		try {
			if (debugLogging) {
				this.outputChannel.appendLine(`[proxy] → POST ${endpoint}`);
				this.outputChannel.appendLine(`[proxy] → payload: ${JSON.stringify(payload).slice(0, 2000)}`);
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

			// Return the raw body stream directly — no intermediate transform stream
			// that could cause buffering or timeout issues.
			return { ok: true, stream: response.body };
		} catch (error) {
			if (debugLogging) {
				this.outputChannel.appendLine(`[proxy] FETCH ERROR: ${error}`);
			}
			if ((error as { name?: string }).name === "AbortError") {
				return { ok: false, status: 499, message: "Request timed out or was cancelled." };
			}
			return { ok: false, status: 520, message: error instanceof Error ? error.message : "Unknown error." };
		} finally {
			clearTimeout(requestTimer);
		}
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	private readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});
	}
}
