/**
 * Races `promise` against a timer, resolving to `null` instead of rejecting/hanging if `promise`
 * doesn't settle within `timeoutMs`. `promise` itself is not cancelled — it keeps running in the
 * background and its eventual result/rejection is discarded once the race is decided.
 * @param promise - The promise to await.
 * @param timeoutMs - Timeout in milliseconds.
 * @returns `promise`'s resolved value, or `null` if it didn't settle before `timeoutMs` elapsed.
 * Rejects if `promise` rejects before the timeout.
 */
export function promiseTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number
): Promise<T | null> {
	let timeoutId: ReturnType<typeof setTimeout>;
	const timeoutPromise: Promise<null> = new Promise((resolve) => {
		timeoutId = setTimeout(() => resolve(null), timeoutMs);
	});

	return Promise.race([promise, timeoutPromise]).then((result: T | null) => {
		clearTimeout(timeoutId);
		return result;
	});
}
