/**
 * Cloudflare AI Utilities
 *
 * Minimal utilities — most heavy sanitization has been removed since
 * VS Code now handles OpenAI-compatible format natively.
 */

/**
 * Try to parse a JSON object from a string.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}
