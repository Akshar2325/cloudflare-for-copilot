import * as vscode from "vscode";
import type { CloudflareAccount } from "./types";

const ACCOUNTS_KEY = "cf.accounts";
const ACTIVE_ACCOUNT_KEY = "cf.activeAccountId";
const ROUTING_CURSOR_KEY = "cf.routingCursor";
const EXHAUSTION_RESET_MS = 3_600_000; // 1 hour

function dedupeByAccountId(accounts: CloudflareAccount[], activeId?: string): CloudflareAccount[] {
	const byAccountId = new Map<string, CloudflareAccount>();
	for (const account of accounts) {
		const key = account.accountId.trim();
		const existing = byAccountId.get(key);
		if (!existing) {
			byAccountId.set(key, account);
			continue;
		}
		// Prefer the active account, or the one that is not exhausted
		if (existing.id === activeId) {
			continue;
		}
		if (account.id === activeId || (!existing.isExhausted && account.isExhausted)) {
			byAccountId.set(key, existing);
		} else {
			byAccountId.set(key, account);
		}
	}
	return [...byAccountId.values()];
}

/**
 * CloudflareAccountManager handles multi-account management.
 *
 * Accounts are stored in VS Code globalState (not secure storage).
 * API tokens are stored in plain text in user settings under `cloudflareAI.accounts`.
 * This avoids the complexity of secure storage and makes settings sync work naturally.
 */
export class CloudflareAccountManager {
	constructor(private readonly context: vscode.ExtensionContext) {}

	/**
	 * Add a new account. Stores in both globalState and user settings.
	 */
	async addAccount(accountId: string, apiToken: string, label: string): Promise<void> {
		const id = crypto.randomUUID();
		const accounts = this.loadAccounts();
		accounts.push({ id, accountId, apiToken, label, isExhausted: false });
		await this.saveAccounts(accounts);
		await this.syncToSettings(accounts);
		if (accounts.length === 1) {
			await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, id);
		}
		vscode.window.showInformationMessage(`Cloudflare account "${label}" added.`);
	}

	/**
	 * Remove an account by ID. Cleans up from globalState, settings, and resets active if needed.
	 */
	async removeAccount(id: string): Promise<void> {
		const accounts = this.loadAccounts();
		const target = accounts.find((account) => account.id === id);
		if (!target) {
			return;
		}

		const nextAccounts = accounts.filter((account) => account.id !== id);
		await this.saveAccounts(nextAccounts);
		await this.syncToSettings(nextAccounts);

		// Reset active account if the removed one was active
		const activeId = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
		if (activeId === id) {
			await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, nextAccounts[0]?.id);
		}
	}

	/**
	 * Get all unique accounts for routing (with rotation).
	 */
	async getRoutableAccounts(): Promise<Array<{ account: CloudflareAccount; token: string }>> {
		await this.resetExhausted();
		const accounts = this.loadAccounts();
		const available = accounts.filter((account) => !account.isExhausted);
		if (available.length === 0) {
			return [];
		}

		const preferredId = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
		const cursorRaw = this.context.globalState.get<number>(ROUTING_CURSOR_KEY, 0);
		const cursor = Number.isFinite(cursorRaw) ? cursorRaw : 0;

		// Put preferred account first, then rotate
		const withPreferredOrder = preferredId
			? [
					...available.filter((account) => account.id === preferredId),
					...available.filter((account) => account.id !== preferredId),
				]
			: available;

		const startIndex = withPreferredOrder.length === 0 ? 0 : cursor % withPreferredOrder.length;
		const rotated = [...withPreferredOrder.slice(startIndex), ...withPreferredOrder.slice(0, startIndex)];

		const routable: Array<{ account: CloudflareAccount; token: string }> = [];
		const seenAccountIds = new Set<string>();
		for (const account of rotated) {
			const accountId = account.accountId.trim();
			if (seenAccountIds.has(accountId)) {
				continue;
			}
			routable.push({ account, token: account.apiToken });
			seenAccountIds.add(accountId);
		}

		if (rotated.length > 0) {
			await this.context.globalState.update(ROUTING_CURSOR_KEY, (startIndex + 1) % rotated.length);
		}

		return routable;
	}

	async setActiveAccount(id: string): Promise<void> {
		const exists = this.loadAccounts().some((account) => account.id === id);
		if (!exists) {
			throw new Error("Account not found.");
		}
		await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, id);
	}

	getActiveAccountId(): string | undefined {
		return this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
	}

	async markExhausted(accountId: string): Promise<void> {
		const accounts = this.loadAccounts();
		const account = accounts.find((entry) => entry.id === accountId);
		if (!account) {
			return;
		}
		account.isExhausted = true;
		account.exhaustedAt = Date.now();
		await this.saveAccounts(accounts);
	}

	async clearExhaustion(accountId: string): Promise<void> {
		const accounts = this.loadAccounts();
		const account = accounts.find((entry) => entry.id === accountId);
		if (!account) {
			return;
		}
		account.isExhausted = false;
		delete account.exhaustedAt;
		await this.saveAccounts(accounts);
	}

	/**
	 * Reset exhausted accounts after 1 hour.
	 * Cloudflare daily credits reset at midnight UTC, but we use 1-hour windows for rotation.
	 */
	async resetExhausted(): Promise<void> {
		const accounts = this.loadAccounts();
		let changed = false;
		for (const account of accounts) {
			if (
				account.isExhausted &&
				account.exhaustedAt !== undefined &&
				Date.now() - account.exhaustedAt > EXHAUSTION_RESET_MS
			) {
				account.isExhausted = false;
				delete account.exhaustedAt;
				changed = true;
			}
		}
		if (changed) {
			await this.saveAccounts(accounts);
		}
	}

	/**
	 * Get all accounts (deduplicated by accountId).
	 */
	getAccounts(): CloudflareAccount[] {
		const activeId = this.getActiveAccountId();
		return dedupeByAccountId(this.loadAccounts(), activeId);
	}

	/**
	 * Clear all exhaustion states.
	 */
	async clearAllExhaustion(): Promise<void> {
		const accounts = this.loadAccounts();
		let changed = false;
		for (const account of accounts) {
			if (account.isExhausted) {
				account.isExhausted = false;
				delete account.exhaustedAt;
				changed = true;
			}
		}
		if (changed) {
			await this.saveAccounts(accounts);
		}
	}

	private loadAccounts(): CloudflareAccount[] {
		return this.context.globalState.get<CloudflareAccount[]>(ACCOUNTS_KEY) ?? [];
	}

	private async saveAccounts(accounts: CloudflareAccount[]): Promise<void> {
		await this.context.globalState.update(ACCOUNTS_KEY, accounts);
	}

	/**
	 * Sync accounts to VS Code user settings (plain text) for visibility and Settings Sync.
	 */
	private async syncToSettings(accounts: CloudflareAccount[]): Promise<void> {
		const config = vscode.workspace.getConfiguration("cloudflareAI");
		const settingAccounts = accounts.map((a) => ({
			accountId: a.accountId,
			apiToken: a.apiToken,
			label: a.label,
		}));
		await config.update("accounts", settingAccounts, vscode.ConfigurationTarget.Global);
	}
}
