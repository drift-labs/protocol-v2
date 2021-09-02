export function assert(condition: boolean, error?: string): void {
	if (!condition) {
		throw new Error(error || 'Unspecified AssertionError');
	}
}
