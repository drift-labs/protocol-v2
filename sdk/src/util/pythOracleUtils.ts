export function trimFeedId(feedId: string): string {
	if (feedId.startsWith('0x')) {
		return feedId.slice(2);
	}
	return feedId;
}

export function getFeedIdUint8Array(feedId: string): Uint8Array {
	const trimmedFeedId = trimFeedId(feedId);
	return Uint8Array.from(Buffer.from(trimmedFeedId, 'hex'));
}
