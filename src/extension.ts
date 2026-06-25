import * as vscode from "vscode";
import { CloudflareAccountManager } from "./accountManager";
import { getCloudflareModels } from "./models";
import { CloudflareLanguageModelChatProvider } from "./provider";
import type { CloudflareAccount } from "./types";

function statusLabel(account: { isExhausted: boolean; exhaustedAt?: number }): string {
	if (!account.isExhausted || account.exhaustedAt === undefined) {
		return "Active";
	}
	const remainingMs = Math.max(0, account.exhaustedAt + 3_600_000 - Date.now());
	const remainingMinutes = Math.ceil(remainingMs / 60_000);
	return `Today's credits ended (resets in ~${remainingMinutes}m)`;
}

async function addAccount(
	manager: CloudflareAccountManager,
	provider: CloudflareLanguageModelChatProvider
): Promise<void> {
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
	provider.refreshModels();
}

async function removeAccount(
	manager: CloudflareAccountManager,
	provider: CloudflareLanguageModelChatProvider
): Promise<void> {
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
		provider.refreshModels();
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

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel("Cloudflare AI");
	context.subscriptions.push(outputChannel);

	const accountManager = new CloudflareAccountManager(context);
	const provider = new CloudflareLanguageModelChatProvider(accountManager, outputChannel);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("customendpoint", provider));

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
					await addAccount(accountManager, provider);
					break;
				case "Remove Account":
					await removeAccount(accountManager, provider);
					break;
				case "Set Primary Account":
					await setPrimaryAccount(accountManager);
					break;
				case "Show Accounts":
					showAccounts(outputChannel, accountManager);
					break;
				case "Clear Exhaustion":
					await accountManager.clearAllExhaustion();
					provider.refreshModels();
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

	outputChannel.appendLine(`Cloudflare AI activated. ${getCloudflareModels().length} models available.`);
}

export function deactivate(): void {}
