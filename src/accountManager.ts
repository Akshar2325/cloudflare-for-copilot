import * as vscode from "vscode";

const EXHAUSTED_KEY = "cf.exhausted";
const EXHAUSTED_AT_KEY = "cf.exhaustedAt";

export interface AccountConfig {
	accountId: string;
	apiToken: string;
	label: string;
}

/**
 * Simple single-account manager.
 * Reads credentials from `cloudflareAI.accounts[0]` in settings.
 * Tracks exhaustion state in globalState.
 */
export class CloudflareAccountManager {
	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Get the configured account, or null if not configured. */
	getAccount(): AccountConfig | null {
		const accounts = vscode.workspace
			.getConfiguration("cloudflareAI")
			.get<{ accountId: string; apiToken: string; label?: string }[]>("accounts", []);
		const first = accounts[0];
		if (!first?.accountId || !first?.apiToken) {
			return null;
		}
		return {
			accountId: first.accountId.trim(),
			apiToken: first.apiToken.trim(),
			label: first.label?.trim() || "Cloudflare Account",
		};
	}

	/** Save credentials to settings. */
	async saveAccount(accountId: string, apiToken: string, label: string): Promise<void> {
		const config = vscode.workspace.getConfiguration("cloudflareAI");
		await config.update(
			"accounts",
			[{ accountId: accountId.trim(), apiToken: apiToken.trim(), label: label.trim() }],
			vscode.ConfigurationTarget.Global
		);
	}

	/** Remove account from settings. */
	async removeAccount(): Promise<void> {
		const config = vscode.workspace.getConfiguration("cloudflareAI");
		await config.update("accounts", [], vscode.ConfigurationTarget.Global);
		await this.clearExhaustion();
	}

	/** Check if account is exhausted. */
	isExhausted(): boolean {
		return this.context.globalState.get<boolean>(EXHAUSTED_KEY, false);
	}

	/** Mark account exhausted (e.g. on 429). */
	async markExhausted(): Promise<void> {
		await this.context.globalState.update(EXHAUSTED_KEY, true);
		await this.context.globalState.update(EXHAUSTED_AT_KEY, Date.now());
	}

	/** Clear exhaustion. */
	async clearExhaustion(): Promise<void> {
		await this.context.globalState.update(EXHAUSTED_KEY, false);
		await this.context.globalState.update(EXHAUSTED_AT_KEY, undefined);
	}

	/** Reset if a new UTC day has started (quota resets at 00:00 UTC). */
	async resetExhausted(): Promise<void> {
		if (!this.isExhausted()) {
			return;
		}
		const exhaustedAt = this.context.globalState.get<number>(EXHAUSTED_AT_KEY);
		if (!exhaustedAt) {
			return;
		}
		const todayUtc = new Date().toISOString().slice(0, 10);
		const exhaustedDay = new Date(exhaustedAt).toISOString().slice(0, 10);
		if (exhaustedDay < todayUtc) {
			await this.clearExhaustion();
		}
	}
}
