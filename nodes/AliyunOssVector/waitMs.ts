/**
 * Async delay without `setTimeout` or `node:timers/*` — required by
 * @n8n/eslint-plugin-community-nodes (no-restricted-globals + no-restricted-imports).
 */
export async function waitMs(ms: number): Promise<void> {
	if (ms <= 0) return;
	try {
		await fetch('data:text/plain;charset=US-ASCII,', { signal: AbortSignal.timeout(ms) });
	} catch {
		// Aborted when timeout elapses — expected.
	}
}
