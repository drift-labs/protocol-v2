import {
	getDiscriminatorMap,
	matchDiscriminator,
	ANCHOR_NAMES,
} from '../../src/squads/discriminator';

describe('discriminator', () => {
	it('returns the same promise for concurrent callers', () => {
		const first = getDiscriminatorMap();
		const second = getDiscriminatorMap();

		expect(second).toBe(first);
	});

	it('resolves concurrent callers to the same map instance', async () => {
		const maps = await Promise.all(Array.from({ length: 8 }, () => getDiscriminatorMap()));

		for (const map of maps) {
			expect(map).toBe(maps[0]);
		}
	});

	it('produces unique discriminators for all 32 instructions', async () => {
		const map = await getDiscriminatorMap();
		expect(map.size).toBe(Object.keys(ANCHOR_NAMES).length);
	});

	it('matches a known discriminator', async () => {
		const map = await getDiscriminatorMap();
		// Find the discriminator for proposal_approve
		let approveDisc: string | undefined;
		for (const [hex, kind] of map) {
			if (kind === 'proposal_approve') {
				approveDisc = hex;
				break;
			}
		}
		expect(approveDisc).toBeDefined();

		// Build fake instruction data with that discriminator
		const bytes = new Uint8Array(16);
		for (let i = 0; i < 8; i++) {
			bytes[i] = parseInt(approveDisc!.slice(i * 2, i * 2 + 2), 16);
		}

		expect(matchDiscriminator(bytes, map)).toBe('proposal_approve');
	});

	it('returns null for unknown discriminator', async () => {
		const map = await getDiscriminatorMap();
		expect(matchDiscriminator(new Uint8Array(8), map)).toBeNull();
	});

	it('returns null for short data', async () => {
		const map = await getDiscriminatorMap();
		expect(matchDiscriminator(new Uint8Array(4), map)).toBeNull();
	});
});
