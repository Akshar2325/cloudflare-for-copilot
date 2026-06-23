import * as vscode from "vscode";
import type { CloudflareAccount, CloudflareSyncedAccount } from "./types";

const ACCOUNTS_KEY = "cf.accounts";
const ACTIVE_ACCOUNT_KEY = "cf.activeAccountId";
const ROUTING_CURSOR_KEY = "cf.routingCursor";
const EXHAUSTION_RESET_MS = 3_600_000; // 1 hour in ms

function tokenKey(id: string): string {
    return `cf.token.${id}`;
}

function providerConfigId(accountId: string): string {
    return `provider-config:${accountId}`;
}

function settingsAccountId(accountId: string): string {
    return `settings:${accountId}`;
}

function normalizeSource(account: CloudflareAccount): CloudflareAccount {
    if (account.source) {
        return account;
    }
    return { ...account, source: "managed" };
}

function normalizeSyncedEntries(value: unknown): CloudflareSyncedAccount[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is CloudflareSyncedAccount => {
        if (!entry || typeof entry !== "object") {
            return false;
        }
        const e = entry as CloudflareSyncedAccount;
        return typeof e.accountId === "string" && typeof e.apiToken === "string";
    });
}

function sourcePriority(source: CloudflareAccount["source"]): number {
    if (source === "managed") {
        return 3;
    }
    if (source === "providerConfig") {
        return 2;
    }
    if (source === "settings") {
        return 1;
    }
    return 0;
}

function preferredAccount(current: CloudflareAccount, next: CloudflareAccount, activeId?: string): CloudflareAccount {
    if (current.id === activeId) {
        return current;
    }
    if (next.id === activeId) {
        return next;
    }

    const currentPriority = sourcePriority(current.source);
    const nextPriority = sourcePriority(next.source);
    if (nextPriority > currentPriority) {
        return next;
    }
    if (currentPriority > nextPriority) {
        return current;
    }

    if (!next.isExhausted && current.isExhausted) {
        return next;
    }
    return current;
}

function dedupeAccountsByAccountId(accounts: CloudflareAccount[], activeId?: string): CloudflareAccount[] {
    const byAccountId = new Map<string, CloudflareAccount>();
    for (const account of accounts) {
        const key = account.accountId.trim();
        const existing = byAccountId.get(key);
        if (!existing) {
            byAccountId.set(key, account);
            continue;
        }
        byAccountId.set(key, preferredAccount(existing, account, activeId));
    }
    return [...byAccountId.values()];
}

export class CloudflareAccountManager {
    constructor(private readonly context: vscode.ExtensionContext) { }

    async addAccount(accountId: string, apiToken: string, label: string): Promise<void> {
        const id = crypto.randomUUID();
        const accounts = this.loadAccounts();
        accounts.push({ id, accountId, label, isExhausted: false, source: "managed" });
        await this.saveAccounts(accounts);
        await this.context.secrets.store(tokenKey(id), apiToken);
        await this.upsertSyncedSettingsAccount({ accountId, apiToken, label });
        if (accounts.length === 1) {
            await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, id);
        }
        vscode.window.showInformationMessage(`Cloudflare account "${label}" added.`);
    }

    async upsertProviderConfigurationAccount(accountId: string, apiToken: string, label = "Language Models Config"): Promise<void> {
        const id = providerConfigId(accountId);
        const accounts = this.loadAccounts();
        const existing = accounts.find((account) => account.id === id);
        if (existing) {
            existing.accountId = accountId;
            existing.label = label;
            existing.source = "providerConfig";
        } else {
            accounts.push({
                id,
                accountId,
                label,
                isExhausted: false,
                source: "providerConfig",
            });
        }
        await this.saveAccounts(accounts);
        await this.context.secrets.store(tokenKey(id), apiToken);
        await this.upsertSyncedSettingsAccount({ accountId, apiToken, label });
    }

    async syncAccountsFromSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration("cloudflareAI");
        const synced = config.get<CloudflareSyncedAccount[]>("syncedAccounts", []);
        const valid = (Array.isArray(synced) ? synced : []).filter((entry) => {
            return !!entry
                && typeof entry.accountId === "string"
                && entry.accountId.trim().length > 0
                && typeof entry.apiToken === "string"
                && entry.apiToken.trim().length > 0;
        });

        const accounts = this.loadAccounts();
        const keepSettingsIds = new Set<string>();
        for (const entry of valid) {
            const accountId = entry.accountId.trim();
            const apiToken = entry.apiToken.trim();
            const id = settingsAccountId(accountId);
            keepSettingsIds.add(id);
            const label = entry.label?.trim() || `Synced ${accountId.slice(0, 8)}`;

            const existing = accounts.find((account) => account.id === id);
            if (existing) {
                existing.accountId = accountId;
                existing.label = label;
                existing.source = "settings";
            } else {
                accounts.push({
                    id,
                    accountId,
                    label,
                    isExhausted: false,
                    source: "settings",
                });
            }
            await this.context.secrets.store(tokenKey(id), apiToken);
        }

        const removedSettings = accounts.filter((account) => account.source === "settings" && !keepSettingsIds.has(account.id));
        const retained = accounts.filter((account) => account.source !== "settings" || keepSettingsIds.has(account.id));
        for (const account of removedSettings) {
            await this.context.secrets.delete(tokenKey(account.id));
        }

        await this.saveAccounts(retained);
    }

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

        const withPreferredOrder = preferredId
            ? [
                ...available.filter((account) => account.id === preferredId),
                ...available.filter((account) => account.id !== preferredId),
            ]
            : available;

        const startIndex = withPreferredOrder.length === 0 ? 0 : cursor % withPreferredOrder.length;
        const rotated = [
            ...withPreferredOrder.slice(startIndex),
            ...withPreferredOrder.slice(0, startIndex),
        ];

        const routable: Array<{ account: CloudflareAccount; token: string }> = [];
        const seenAccountIds = new Set<string>();
        for (const account of rotated) {
            const accountId = account.accountId.trim();
            if (seenAccountIds.has(accountId)) {
                continue;
            }
            const token = await this.context.secrets.get(tokenKey(account.id));
            if (token?.trim()) {
                routable.push({ account, token });
                seenAccountIds.add(accountId);
            }
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

    async resetExhausted(): Promise<void> {
        const accounts = this.loadAccounts();
        let changed = false;
        for (const account of accounts) {
            if (
                account.isExhausted
                && account.exhaustedAt !== undefined
                && Date.now() - account.exhaustedAt > EXHAUSTION_RESET_MS
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

    getAccounts(): CloudflareAccount[] {
        const activeId = this.getActiveAccountId();
        return dedupeAccountsByAccountId(this.loadAccounts(), activeId);
    }

    getAccountsForRouting(includeProviderConfig = true): CloudflareAccount[] {
        const activeId = this.getActiveAccountId();
        const accounts = this.loadAccounts().filter((account) => includeProviderConfig || account.source !== "providerConfig");
        return dedupeAccountsByAccountId(accounts, activeId);
    }

    hasProviderConfigurationShadows(): boolean {
        return this.loadAccounts().some((account) => account.source === "providerConfig");
    }

    async removeAccount(id: string): Promise<void> {
        const accounts = this.loadAccounts();
        const target = accounts.find((account) => account.id === id);
        if (!target) {
            return;
        }

        const nextAccounts = accounts.filter((account) => account.id !== id);
        await this.saveAccounts(nextAccounts);
        await this.context.secrets.delete(tokenKey(id));
        await this.removeSyncedSettingsAccount(target.accountId);

        const activeAccount = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
        if (activeAccount === id) {
            await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, nextAccounts[0]?.id);
        }
    }

    async getToken(id: string): Promise<string | undefined> {
        return this.context.secrets.get(tokenKey(id));
    }

    async clearLocalAccountCache(): Promise<{ removedProviderShadows: number; resetExhausted: number }> {
        const accounts = this.loadAccounts();
        const providerShadows = accounts.filter((account) => account.source === "providerConfig");
        const retained = accounts.filter((account) => account.source !== "providerConfig");

        const activeId = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
        const deduped = dedupeAccountsByAccountId(retained, activeId);

        let resetExhausted = 0;
        for (const account of deduped) {
            if (account.isExhausted) {
                resetExhausted += 1;
            }
            account.isExhausted = false;
            delete account.exhaustedAt;
        }

        for (const account of providerShadows) {
            await this.context.secrets.delete(tokenKey(account.id));
        }

        await this.saveAccounts(deduped);
        await this.context.globalState.update(ROUTING_CURSOR_KEY, 0);

        const nextActive = deduped.find((account) => account.id === activeId)?.id ?? deduped[0]?.id;
        await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, nextActive);

        return {
            removedProviderShadows: providerShadows.length,
            resetExhausted,
        };
    }

    async clearProviderConfigurationShadows(): Promise<number> {
        const accounts = this.loadAccounts();
        const providerShadows = accounts.filter((account) => account.source === "providerConfig");
        if (providerShadows.length === 0) {
            return 0;
        }

        const retained = accounts.filter((account) => account.source !== "providerConfig");
        for (const account of providerShadows) {
            await this.context.secrets.delete(tokenKey(account.id));
        }

        await this.saveAccounts(retained);

        const activeId = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
        if (activeId && providerShadows.some((account) => account.id === activeId)) {
            await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, retained[0]?.id);
        }

        return providerShadows.length;
    }

    private loadAccounts(): CloudflareAccount[] {
        const raw = this.context.globalState.get<CloudflareAccount[]>(ACCOUNTS_KEY) ?? [];
        return raw.map(normalizeSource);
    }

    private async saveAccounts(accounts: CloudflareAccount[]): Promise<void> {
        await this.context.globalState.update(ACCOUNTS_KEY, accounts);
    }

    private async upsertSyncedSettingsAccount(entry: CloudflareSyncedAccount): Promise<void> {
        const config = vscode.workspace.getConfiguration("cloudflareAI");
        const current = normalizeSyncedEntries(config.get<unknown>("syncedAccounts"));
        const normalizedAccountId = entry.accountId.trim();
        const normalizedToken = entry.apiToken.trim();
        if (!normalizedAccountId || !normalizedToken) {
            return;
        }

        const updated = [...current];
        const index = updated.findIndex((account) => account.accountId.trim() === normalizedAccountId);
        const nextEntry: CloudflareSyncedAccount = {
            accountId: normalizedAccountId,
            apiToken: normalizedToken,
            label: entry.label?.trim() || `Cloudflare ${normalizedAccountId.slice(0, 8)}`,
        };

        if (index >= 0) {
            updated[index] = nextEntry;
        } else {
            updated.push(nextEntry);
        }

        await config.update("syncedAccounts", updated, vscode.ConfigurationTarget.Global);
    }

    private async removeSyncedSettingsAccount(accountId: string): Promise<void> {
        const config = vscode.workspace.getConfiguration("cloudflareAI");
        const current = normalizeSyncedEntries(config.get<unknown>("syncedAccounts"));
        const normalizedAccountId = accountId.trim();
        const updated = current.filter((account) => account.accountId.trim() !== normalizedAccountId);
        if (updated.length !== current.length) {
            await config.update("syncedAccounts", updated, vscode.ConfigurationTarget.Global);
        }
    }
}
