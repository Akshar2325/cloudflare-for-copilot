import * as vscode from "vscode";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import { CloudflareAccountManager } from "./accountManager";
import { CURATED_CLOUDFLARE_MODELS, getConfiguredModelCatalog } from "./models";
import { CloudflareLanguageModelChatProvider } from "./provider";
import type { CloudflareAccount } from "./types";

function statusLabel(account: { isExhausted: boolean; exhaustedAt?: number }): string {
    if (!account.isExhausted || account.exhaustedAt === undefined) {
        return "Active";
    }
    const remainingMs = Math.max(0, (account.exhaustedAt + 3_600_000) - Date.now());
    const remainingMinutes = Math.ceil(remainingMs / 60_000);
    return `Exhausted (${remainingMinutes}m until reset)`;
}

function sourceLabel(source: "managed" | "settings" | "providerConfig" | undefined): string {
    if (source === "settings") {
        return "settings-sync";
    }
    if (source === "providerConfig") {
        return "provider-config";
    }
    return "managed";
}

async function addAccount(manager: CloudflareAccountManager, provider: CloudflareLanguageModelChatProvider): Promise<void> {
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
        prompt: "Friendly name used in account rotation/status",
        value: "Cloudflare Account",
        ignoreFocusOut: true,
    });
    if (!label?.trim()) {
        return;
    }

    await manager.addAccount(accountId.trim(), apiToken.trim(), label.trim());
    provider.refreshModels();
}

async function removeAccount(manager: CloudflareAccountManager, provider: CloudflareLanguageModelChatProvider): Promise<void> {
    const accounts = manager.getAccounts();
    if (accounts.length === 0) {
        vscode.window.showInformationMessage("No accounts configured.");
        return;
    }

    type AccountPick = vscode.QuickPickItem & { id: string };

    const selected = await vscode.window.showQuickPick<AccountPick>(
        accounts.map((account: CloudflareAccount): AccountPick => ({
            label: account.label,
            description: `${account.accountId.slice(0, 8)}...`,
            detail: statusLabel(account),
            id: account.id,
        })),
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

async function clearAccountCache(
    manager: CloudflareAccountManager,
    outputChannel: vscode.OutputChannel,
    provider: CloudflareLanguageModelChatProvider,
): Promise<void> {
    const result = await manager.clearLocalAccountCache();
    outputChannel.appendLine(
        `Account cache cleaned: removed ${result.removedProviderShadows} provider-config shadow account(s), reset ${result.resetExhausted} exhausted account(s).`
    );
    outputChannel.show(true);
    provider.refreshModels();
    vscode.window.showInformationMessage("Cloudflare AI cache cleaned. Provider-config accounts will be re-discovered automatically.");
}

async function removeLanguageModelsProviderEntries(
    manager: CloudflareAccountManager,
    outputChannel: vscode.OutputChannel,
    provider: CloudflareLanguageModelChatProvider,
): Promise<void> {
    const appData = process.env.APPDATA;
    if (!appData) {
        vscode.window.showWarningMessage("APPDATA is not available. Open chatLanguageModels.json manually and remove Cloudflare entries.");
        return;
    }

    const candidates = [
        path.join(appData, "Code", "User", "chatLanguageModels.json"),
        path.join(appData, "Code - Insiders", "User", "chatLanguageModels.json"),
    ];

    let targetPath: string | undefined;
    for (const candidate of candidates) {
        try {
            await access(candidate);
            targetPath = candidate;
            break;
        } catch {
            // Keep probing candidate locations.
        }
    }

    if (!targetPath) {
        vscode.window.showInformationMessage("chatLanguageModels.json was not found. No provider entries removed.");
        return;
    }

    const original = await readFile(targetPath, "utf8");
    const parsed = parse(original) as unknown;
    if (!Array.isArray(parsed)) {
        vscode.window.showWarningMessage("chatLanguageModels.json format is unexpected. Remove Cloudflare entries manually.");
        return;
    }

    const filtered = parsed.filter((entry) => {
        if (!entry || typeof entry !== "object") {
            return true;
        }
        const vendor = (entry as { vendor?: unknown }).vendor;
        return !(typeof vendor === "string" && vendor.toLowerCase() === "cloudflare");
    });

    const removed = parsed.length - filtered.length;
    if (removed <= 0) {
        vscode.window.showInformationMessage("No Cloudflare entries found in chatLanguageModels.json.");
        return;
    }

    const edits = modify(original, [], filtered, {
        formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: "\n",
        },
    });

    const updated = applyEdits(original, edits);
    await writeFile(targetPath, updated, "utf8");
    const shadowCount = await manager.clearProviderConfigurationShadows();

    outputChannel.appendLine(`Removed ${removed} Cloudflare provider entr${removed === 1 ? "y" : "ies"} from ${targetPath}.`);
    outputChannel.appendLine(`Cleared ${shadowCount} provider-config shadow entr${shadowCount === 1 ? "y" : "ies"}.`);
    outputChannel.show(true);
    provider.refreshModels();
    vscode.window.showInformationMessage("Cloudflare Language Models provider entries removed. Reload window to refresh model groups.");
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
        accounts.map((account: CloudflareAccount): AccountPick => ({
            label: account.label,
            description: account.id === activeId ? "Primary" : "",
            detail: `${account.accountId.slice(0, 8)}... • ${statusLabel(account)}`,
            id: account.id,
        })),
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
    outputChannel.appendLine("Cloudflare accounts:");
    if (accounts.length === 0) {
        outputChannel.appendLine("- none configured");
    } else {
        for (const account of accounts) {
            const marker = account.id === activeId ? "(primary)" : "";
            outputChannel.appendLine(
                `- ${account.label} ${marker} | ${account.accountId} | ${statusLabel(account)} | ${sourceLabel(account.source)}`.trim()
            );
        }
    }
    outputChannel.show(true);
}

function showRequestDiagnostics(outputChannel: vscode.OutputChannel, provider: CloudflareLanguageModelChatProvider): void {
    outputChannel.appendLine("Cloudflare request diagnostics:");
    for (const line of provider.getRecentRequestDiagnostics()) {
        outputChannel.appendLine(`- ${line}`);
    }
    outputChannel.show(true);
}

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel("Cloudflare AI");
    context.subscriptions.push(outputChannel);

    const accountManager = new CloudflareAccountManager(context);
    const provider = new CloudflareLanguageModelChatProvider(accountManager, outputChannel);
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("cloudflare", provider));

    void accountManager.syncAccountsFromSettings();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("cloudflareAI.syncedAccounts")) {
                void accountManager.syncAccountsFromSettings();
                provider.refreshModels();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cloudflareAI.manage", async () => {
            const action = await vscode.window.showQuickPick(
                [
                    "Add Account",
                    "Remove Account",
                    "Set Primary Account",
                    "Show Accounts",
                    "Show Request Diagnostics",
                    "Clear Request Diagnostics",
                    "Clear Account Cache",
                    "Remove From Language Models JSON",
                ],
                { title: "Cloudflare AI: Manage Provider" }
            );
            if (!action) {
                return;
            }

            if (action === "Add Account") {
                await addAccount(accountManager, provider);
                return;
            }
            if (action === "Remove Account") {
                await removeAccount(accountManager, provider);
                return;
            }
            if (action === "Set Primary Account") {
                await setPrimaryAccount(accountManager);
                return;
            }
            if (action === "Show Accounts") {
                showAccounts(outputChannel, accountManager);
                return;
            }
            if (action === "Show Request Diagnostics") {
                showRequestDiagnostics(outputChannel, provider);
                return;
            }
            if (action === "Clear Request Diagnostics") {
                provider.clearRequestDiagnostics();
                vscode.window.showInformationMessage("Cloudflare request diagnostics cleared.");
                return;
            }
            if (action === "Clear Account Cache") {
                await clearAccountCache(accountManager, outputChannel, provider);
                return;
            }
            if (action === "Remove From Language Models JSON") {
                await removeLanguageModelsProviderEntries(accountManager, outputChannel, provider);
                return;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cloudflareAI.status", () => {
            const accounts = accountManager.getAccounts();
            const active = accounts.filter((account: CloudflareAccount) => !account.isExhausted).length;
            const catalog = getConfiguredModelCatalog();
            vscode.window.showInformationMessage(
                `Cloudflare AI: ${active}/${accounts.length} accounts active, ${catalog.length} models loaded.`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cloudflareAI.clearAccountCache", async () => {
            await clearAccountCache(accountManager, outputChannel, provider);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cloudflareAI.showRequestDiagnostics", () => {
            showRequestDiagnostics(outputChannel, provider);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cloudflareAI.clearRequestDiagnostics", () => {
            provider.clearRequestDiagnostics();
            vscode.window.showInformationMessage("Cloudflare request diagnostics cleared.");
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cloudflareAI.removeFromLanguageModelsJson", async () => {
            await removeLanguageModelsProviderEntries(accountManager, outputChannel, provider);
        })
    );

    const timer = setInterval(() => {
        void accountManager.resetExhausted();
    }, 15 * 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });

    outputChannel.appendLine(
        `Cloudflare AI activated. ${CURATED_CLOUDFLARE_MODELS.length} curated models available.`
    );
}

export function deactivate(): void { }
