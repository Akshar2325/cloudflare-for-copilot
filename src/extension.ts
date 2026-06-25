import * as vscode from "vscode";
import { CloudflareAccountManager } from "./accountManager";
import { getCloudflareModels } from "./models";
import { CloudflareProxyServer } from "./CloudflareProxyServer";
import { writeCloudflareModelsToChatLanguageModels, removeCloudflareModelsFromChatLanguageModels } from "./utils";
import type { CloudflareAccount } from "./types";

function statusLabel(account: { isExhausted: boolean; exhaustedAt?: number }): string {
	if (!account.isExhausted || account.exhaustedAt === undefined) {
		return "Active";
	}
	// Cloudflare daily neuron quota resets at 00:00 UTC
	const now = Date.now();
	const nextMidnight = new Date(now);
	nextMidnight.setUTCHours(24, 0, 0, 0);
	const remainingMs = Math.max(0, nextMidnight.getTime() - now);
	const remainingMinutes = Math.ceil(remainingMs / 60_000);
	if (remainingMinutes >= 60) {
		const hours = Math.floor(remainingMinutes / 60);
		const mins = remainingMinutes % 60;
		return `Today's credits ended (resets in ~${hours}h ${mins}m)`;
	}
	return `Today's credits ended (resets in ~${remainingMinutes}m)`;
}

function syncModels(proxyPort: number, manager: CloudflareAccountManager): void {
	const accounts = manager.getAccounts();
	if (accounts.length > 0) {
		writeCloudflareModelsToChatLanguageModels(proxyPort);
	} else {
		removeCloudflareModelsFromChatLanguageModels();
	}
}

async function addAccount(manager: CloudflareAccountManager, proxyPort: number): Promise<void> {
	const accountId = await vscode.window.showInputBox({
		title: "Cloudflare Account ID",
		prompt: "Enter your Cloudflare account ID",
		ignoreFocusOut: true,
	});
	if (!accountId?.trim()) {
		return;
	}

	const apiToken = await vscode.window.showInputBox({
		title: "Cloudflare API Token",
		prompt: "Enter a token with Workers AI permissions",
		password: true,
		ignoreFocusOut: true,
	});
	if (!apiToken?.trim()) {
		return;
	}

	const label = await vscode.window.showInputBox({
		title: "Account Label",
		prompt: "Friendly name for this account",
		value: "Cloudflare Account",
		ignoreFocusOut: true,
	});
	if (!label?.trim()) {
		return;
	}

	await manager.addAccount(accountId.trim(), apiToken.trim(), label.trim());
	syncModels(proxyPort, manager);
}

async function removeAccount(manager: CloudflareAccountManager, proxyPort: number): Promise<void> {
	const accounts = manager.getAccounts();
	if (accounts.length === 0) {
		vscode.window.showInformationMessage("No accounts configured.");
		return;
	}

	type AccountPick = vscode.QuickPickItem & { id: string };

	const selected = await vscode.window.showQuickPick<AccountPick>(
		accounts.map(
			(account: CloudflareAccount): AccountPick => ({
				label: account.label,
				description: `${account.accountId.slice(0, 8)}...`,
				detail: statusLabel(account),
				id: account.id,
			})
		),
		{ title: "Remove Cloudflare account" }
	);
	if (!selected) {
		return;
	}

	try {
		await manager.removeAccount(selected.id);
		syncModels(proxyPort, manager);
		vscode.window.showInformationMessage(`Removed account "${selected.label}".`);
	} catch (error) {
		vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
	}
}

async function setPrimaryAccount(manager: CloudflareAccountManager): Promise<void> {
	const accounts = manager.getAccounts();
	if (accounts.length === 0) {
		vscode.window.showInformationMessage("No accounts configured.");
		return;
	}

	const activeId = manager.getActiveAccountId();
	type AccountPick = vscode.QuickPickItem & { id: string };

	const selected = await vscode.window.showQuickPick<AccountPick>(
		accounts.map(
			(account: CloudflareAccount): AccountPick => ({
				label: account.label,
				description: account.id === activeId ? "Primary" : "",
				detail: `${account.accountId.slice(0, 8)}... • ${statusLabel(account)}`,
				id: account.id,
			})
		),
		{ title: "Select primary account (used first before rotation)" }
	);
	if (!selected) {
		return;
	}

	await manager.setActiveAccount(selected.id);
	vscode.window.showInformationMessage(`Primary account set to "${selected.label}".`);
}

function showAccounts(outputChannel: vscode.OutputChannel, manager: CloudflareAccountManager): void {
	const accounts = manager.getAccounts();
	const activeId = manager.getActiveAccountId();
	outputChannel.appendLine("═══ Cloudflare AI Accounts ═══");
	if (accounts.length === 0) {
		outputChannel.appendLine("  No accounts configured.");
	} else {
		for (const account of accounts) {
			const marker = account.id === activeId ? " ★" : "";
			outputChannel.appendLine(`  ${account.label}${marker} | ${account.accountId} | ${statusLabel(account)}`);
		}
	}
	outputChannel.show(true);
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

	// Write models if accounts exist
	syncModels(proxyPort, accountManager);

	// ── Commands ─────────────────────────────────────────────────────────────

	context.subscriptions.push(
		vscode.commands.registerCommand("cloudflareAI.manage", async () => {
			const action = await vscode.window.showQuickPick(
				["Add Account", "Remove Account", "Set Primary Account", "Show Accounts", "Clear Exhaustion"],
				{ title: "Cloudflare AI: Manage Provider" }
			);
			if (!action) {
				return;
			}

			switch (action) {
				case "Add Account":
					await addAccount(accountManager, proxyPort);
					break;
				case "Remove Account":
					await removeAccount(accountManager, proxyPort);
					break;
				case "Set Primary Account":
					await setPrimaryAccount(accountManager);
					break;
				case "Show Accounts":
					showAccounts(outputChannel, accountManager);
					break;
				case "Clear Exhaustion":
					await accountManager.clearAllExhaustion();
					syncModels(proxyPort, accountManager);
					vscode.window.showInformationMessage("Cloudflare AI: All account exhaustion states cleared.");
					break;
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("cloudflareAI.status", () => {
			const accounts = accountManager.getAccounts();
			const active = accounts.filter((a: CloudflareAccount) => !a.isExhausted).length;
			const models = getCloudflareModels();
			vscode.window.showInformationMessage(
				`Cloudflare AI: ${active}/${accounts.length} accounts active, ${models.length} models available.`
			);
		})
	);

	// ── Exhaustion auto-reset timer ──────────────────────────────────────────

	const timer = setInterval(
		() => {
			void accountManager.resetExhausted();
		},
		15 * 60 * 1000
	);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	outputChannel.appendLine(
		`Cloudflare AI activated. ${getCloudflareModels().length} models available. Proxy on port ${proxyPort}.`
	);
}

export function deactivate(): void {}
