import * as assert from "assert";
import { CloudflareProxyServer } from "../CloudflareProxyServer";
import { CloudflareAccountManager } from "../accountManager";
import { tryParseJSONObject, getChatLanguageModelsPath } from "../utils";

function makeMockAccountManager(): CloudflareAccountManager {
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
	} as unknown as import("vscode").ExtensionContext;
	return new CloudflareAccountManager(mockContext);
}

function makeMockOutputChannel(): import("vscode").OutputChannel {
	return {
		appendLine: () => {},
		append: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {},
		replace: () => {},
		clear: () => {},
		name: "test",
	} as unknown as import("vscode").OutputChannel;
}

suite("Cloudflare AI Extension", () => {
	suite("proxy server", () => {
		test("start and stop", async () => {
			const am = makeMockAccountManager();
			const oc = makeMockOutputChannel();
			const proxy = new CloudflareProxyServer(am, oc);

			assert.equal(proxy.running, false);

			const port = await proxy.start();
			assert.ok(typeof port === "number" && port > 0);
			assert.equal(proxy.running, true);
			assert.equal(proxy.port, port);

			await proxy.stop();
			assert.equal(proxy.running, false);
		});

		test("health endpoint", async () => {
			const am = makeMockAccountManager();
			const oc = makeMockOutputChannel();
			const proxy = new CloudflareProxyServer(am, oc);

			const port = await proxy.start();

			const res = await fetch(`http://127.0.0.1:${port}/health`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as { status: string };
			assert.equal(body.status, "ok");

			await proxy.stop();
		});

		test("GET /v1/models returns empty array with no accounts", async () => {
			const am = makeMockAccountManager();
			const oc = makeMockOutputChannel();
			const proxy = new CloudflareProxyServer(am, oc);

			const port = await proxy.start();

			const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as { object: string; data: unknown[] };
			assert.equal(body.object, "list");
			assert.ok(Array.isArray(body.data));
			assert.equal(body.data.length, 0);

			await proxy.stop();
		});

		test("chat completions returns 503 with no accounts", async () => {
			const am = makeMockAccountManager();
			const oc = makeMockOutputChannel();
			const proxy = new CloudflareProxyServer(am, oc);

			const port = await proxy.start();

			const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "cf-kimi-k2.7-code", messages: [{ role: "user", content: "hi" }] }),
			});
			assert.equal(res.status, 503);
			const body = (await res.json()) as { error: string };
			assert.ok(body.error.includes("No Cloudflare accounts"));

			await proxy.stop();
		});
	});

	suite("utils/json", () => {
		test("tryParseJSONObject handles valid and invalid JSON", () => {
			assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
			assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
			assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
		});
	});

	suite("utils/chatLanguageModels", () => {
		test("getChatLanguageModelsPath returns a string", () => {
			const p = getChatLanguageModelsPath();
			assert.ok(typeof p === "string");
			assert.ok(p!.endsWith("chatLanguageModels.json"));
		});
	});
});
