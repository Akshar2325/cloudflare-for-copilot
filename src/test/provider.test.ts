import * as assert from "assert";
import * as vscode from "vscode";
import { CloudflareLanguageModelChatProvider } from "../provider";
import { CloudflareAccountManager } from "../accountManager";
import { tryParseJSONObject } from "../utils";

function makeProvider(): CloudflareLanguageModelChatProvider {
	const mockContext = {
		globalState: {
			get: () => undefined,
			update: async () => {},
			setKeysForSync: () => {},
			keys: () => [],
		},
		secrets: {
			get: async () => undefined,
			store: async () => {},
			delete: async () => {},
			onDidChange: (_listener: unknown) => ({ dispose() {} }),
		},
	} as unknown as vscode.ExtensionContext;
	const accountManager = new CloudflareAccountManager(mockContext);
	const outputChannel = {
		appendLine: () => {},
		append: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {},
		replace: () => {},
		clear: () => {},
		name: "test",
	} as unknown as vscode.OutputChannel;
	return new CloudflareLanguageModelChatProvider(accountManager, outputChannel);
}

suite("Cloudflare Chat Provider Extension", () => {
	suite("provider", () => {
		test("prepareLanguageModelChatInformation returns array", async () => {
			const provider = makeProvider();

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			assert.ok(Array.isArray(infos));
		});

		test("provideTokenCount counts simple string", async () => {
			const provider = makeProvider();

			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "cloudflare",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				"hello world",
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideLanguageModelChatResponse throws without account", async () => {
			const provider = makeProvider();

			let threw = false;
			try {
				await provider.provideLanguageModelChatResponse(
					{
						id: "m",
						name: "m",
						family: "cloudflare",
						version: "1.0.0",
						maxInputTokens: 1000,
						maxOutputTokens: 1000,
						capabilities: {},
					} as unknown as vscode.LanguageModelChatInformation,
					[],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
			} catch {
				threw = true;
			}
			assert.ok(threw);
		});
	});

	suite("utils/json", () => {
		test("tryParseJSONObject handles valid and invalid JSON", () => {
			assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
			assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
			assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
		});
	});
});
