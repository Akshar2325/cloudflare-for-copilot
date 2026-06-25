import * as vscode from "vscode";
import { CloudflareAccountManager } from "./accountManager";
import { getCloudflareModels } from "./models";
import { CloudflareProxyServer } from "./CloudflareProxyServer";
import { writeCloudflareModelsToChatLanguageModels, removeCloudflareModelsFromChatLanguageModels } from "./utils";

function syncModels(proxyPort: number, manager: CloudflareAccountManager): void {
	const account = manager.getAccount();
	if (account && !manager.isExhausted()) {
		writeCloudflareModelsToChatLanguageModels(proxyPort);
	} else {
		removeCloudflareModelsFromChatLanguageModels();
	}
}

async function configureAccount(manager: CloudflareAccountManager, proxyPort: number): Promise<void> {
	const action = await vscode.window.showQuickPick(["Add / Update Account", "Remove Account", "Show Status"], {
		title: "Cloudflare AI: Manage Account",
	});
	if (!action) {
		return;
	}

	if (action === "Add / Update Account") {
		const accountId = await vscode.window.showInputBox({
			title: "Cloudflare Account ID",
			prompt: "Enter your Cloudflare account ID",
			ignoreFocusOut: true,
			value: manager.getAccount()?.accountId ?? "",
		});
		if (!accountId?.trim()) {
			return;
		}

		const apiToken = await vscode.window.showInputBox({
			title: "Cloudflare API Token",
			prompt: "Enter a token with Workers AI permissions",
			password: true,
			ignoreFocusOut: true,
			value: manager.getAccount()?.apiToken ?? "",
		});
		if (!apiToken?.trim()) {
			return;
		}

		const label = await vscode.window.showInputBox({
			title: "Account Label",
			prompt: "Friendly name for this account",
			value: manager.getAccount()?.label || "Cloudflare Account",
			ignoreFocusOut: true,
		});
		if (!label?.trim()) {
			return;
		}

		await manager.saveAccount(accountId.trim(), apiToken.trim(), label.trim());
		syncModels(proxyPort, manager);
		vscode.window.showInformationMessage(`Cloudflare account "${label.trim()}" saved.`);
	} else if (action === "Remove Account") {
		if (!manager.getAccount()) {
			vscode.window.showInformationMessage("No account configured.");
			return;
		}
		await manager.removeAccount();
		removeCloudflareModelsFromChatLanguageModels();
		vscode.window.showInformationMessage("Cloudflare account removed.");
	} else if (action === "Show Status") {
		showStatus(manager);
	}
}

function showStatus(manager: CloudflareAccountManager): void {
	const account = manager.getAccount();
	if (!account) {
		vscode.window.showInformationMessage("Cloudflare AI: No account configured.");
		return;
	}

	const exhausted = manager.isExhausted();
	const models = getCloudflareModels();
	if (exhausted) {
		const nextMidnight = new Date();
		nextMidnight.setUTCHours(24, 0, 0, 0);
		const mins = Math.ceil((nextMidnight.getTime() - Date.now()) / 60_000);
		vscode.window.showInformationMessage(
			`Cloudflare AI: "${account.label}" — Today's credits ended (resets in ~${mins}m), ${models.length} models available.`
		);
	} else {
		vscode.window.showInformationMessage(
			`Cloudflare AI: "${account.label}" — Active, ${models.length} models available.`
		);
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel("Cloudflare AI");
	context.subscriptions.push(outputChannel);

	const accountManager = new CloudflareAccountManager(context);
	const proxy = new CloudflareProxyServer(accountManager, outputChannel);
	context.subscriptions.push(proxy);

	// Start the proxy server
	let proxyPort: number;
	try {
		proxyPort = await proxy.start();
		outputChannel.appendLine(`[proxy] Started on port ${proxyPort}`);
	} catch (error) {
		outputChannel.appendLine(`[proxy] Failed to start: ${error}`);
		void vscode.window.showErrorMessage(
			`Cloudflare AI proxy failed to start: ${error instanceof Error ? error.message : error}`
		);
		return;
	}

	// Write models if account is configured
	syncModels(proxyPort, accountManager);

	// ── Commands ─────────────────────────────────────────────────────────────

	context.subscriptions.push(
		vscode.commands.registerCommand("cloudflareAI.manage", () => {
			void configureAccount(accountManager, proxyPort);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("cloudflareAI.status", () => {
			showStatus(accountManager);
		})
	);

	// ── Exhaustion auto-reset timer ──────────────────────────────────────────
	// Checks every 15 minutes if a new UTC day has started.

	const timer = setInterval(
		() => {
			void accountManager.resetExhausted().then(() => syncModels(proxyPort, accountManager));
		},
		15 * 60 * 1000
	);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	outputChannel.appendLine(
		`Cloudflare AI activated. ${getCloudflareModels().length} models available. Proxy on port ${proxyPort}.`
	);
}

export function deactivate(): void {}
