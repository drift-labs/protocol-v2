import {
	VELOCITY_PROGRAM_ID,
	VELOCITY_VAULTS_PROGRAM_ID,
	getKnownIdls,
} from '../../src/squads/known-idls';

type IdlWithMetadata = { metadata?: { name?: string } };

describe('known-idls', () => {
	it('loads the Velocity program IDL from @velocity-exchange/sdk', async () => {
		const idls = await getKnownIdls();
		const velocity = idls.get(VELOCITY_PROGRAM_ID);
		expect(velocity).toBeDefined();
		expect((velocity as IdlWithMetadata).metadata?.name).toBe('velocity');
		// Sanity-check that instructions are populated. The exact count tracks
		// the SDK version, so we just assert non-trivial.
		expect(velocity!.instructions.length).toBeGreaterThan(50);
	});

	it('loads the Velocity Vaults IDL from @velocity-exchange/vaults-sdk', async () => {
		const idls = await getKnownIdls();
		const vaults = idls.get(VELOCITY_VAULTS_PROGRAM_ID);
		expect(vaults).toBeDefined();
		expect((vaults as IdlWithMetadata).metadata?.name).toBe('vaults');
		expect(vaults!.instructions.length).toBeGreaterThan(10);
	});

	it('exposes the Velocity Vaults program id (vAuLT...)', () => {
		expect(VELOCITY_VAULTS_PROGRAM_ID).toBe('vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR');
	});

	it('returns the same map across calls', async () => {
		const a = await getKnownIdls();
		const b = await getKnownIdls();
		expect(b).toBe(a);
	});
});
