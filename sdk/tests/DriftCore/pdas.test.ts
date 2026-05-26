import { describe, expect, test } from 'bun:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { VelocityCore } from '../../src/core/VelocityCore';

describe('DriftCore.pdas', () => {
	test('derives deterministic user/state PDAs', async () => {
		const programId = Keypair.generate().publicKey;
		const authority = Keypair.generate().publicKey;

		const [state] =
			await VelocityCore.pdas.getDriftStateAccountPublicKeyAndNonce(programId);
		const user0 = await VelocityCore.pdas.getUserAccountPublicKey(
			programId,
			authority,
			0
		);
		const user1 = await VelocityCore.pdas.getUserAccountPublicKey(
			programId,
			authority,
			1
		);

		expect(state).toBeInstanceOf(PublicKey);
		expect(user0).toBeInstanceOf(PublicKey);
		expect(user1).toBeInstanceOf(PublicKey);
		expect(user0.toBase58()).not.toEqual(user1.toBase58());
	});
});
