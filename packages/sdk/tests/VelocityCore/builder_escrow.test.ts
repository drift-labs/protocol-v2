import { describe, expect, test } from 'bun:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { VelocityClient } from '../../src/velocityClient';
import { getRevenueShareEscrowAccountPublicKey } from '../../src/addresses/pda';
import { RevenueShareEscrowAccount } from '../../src/types';

// `getTakerEscrowAccountMeta` decides whether a perp fill must carry the taker's
// RevenueShareEscrow account. It only reads `this.program.programId`, so we can
// exercise the decision with a minimal `this` instead of a full client.
// Regression guard for: referred takers (escrow initialized with a referrer)
// whose order carries no builder code must still get the escrow attached, else
// the program rejects the fill with UnableToLoadRevenueShareAccount.
const getTakerEscrowAccountMeta = (VelocityClient.prototype as any)
	.getTakerEscrowAccountMeta as (
	takerAuthority: PublicKey,
	orderHasBuilder: boolean,
	takerEscrow?: RevenueShareEscrowAccount
) => { pubkey: PublicKey; isWritable: boolean; isSigner: boolean } | undefined;

const programId = Keypair.generate().publicKey;
const ctx = { program: { programId } };
const escrow = (
	authority: PublicKey,
	referrer: PublicKey
): RevenueShareEscrowAccount =>
	({ authority, referrer }) as unknown as RevenueShareEscrowAccount;

describe('getTakerEscrowAccountMeta (fill escrow attachment)', () => {
	test('referred taker, order without builder -> escrow attached', () => {
		const authority = Keypair.generate().publicKey;
		const meta = getTakerEscrowAccountMeta.call(
			ctx,
			authority,
			false,
			escrow(authority, Keypair.generate().publicKey)
		);
		expect(meta).toBeDefined();
		expect(
			meta!.pubkey.equals(
				getRevenueShareEscrowAccountPublicKey(programId, authority)
			)
		).toBe(true);
		expect(meta!.isWritable).toBe(true);
	});

	test('non-referred taker, order without builder -> no escrow', () => {
		const authority = Keypair.generate().publicKey;
		const meta = getTakerEscrowAccountMeta.call(
			ctx,
			authority,
			false,
			escrow(authority, PublicKey.default)
		);
		expect(meta).toBeUndefined();
	});

	test('builder-code order attaches escrow (no decoded escrow needed)', () => {
		const authority = Keypair.generate().publicKey;
		const meta = getTakerEscrowAccountMeta.call(
			ctx,
			authority,
			true,
			undefined
		);
		expect(meta).toBeDefined();
		expect(
			meta!.pubkey.equals(
				getRevenueShareEscrowAccountPublicKey(programId, authority)
			)
		).toBe(true);
	});

	test('escrow belonging to a different authority is rejected', () => {
		const authority = Keypair.generate().publicKey;
		const wrong = escrow(
			Keypair.generate().publicKey,
			Keypair.generate().publicKey
		);
		expect(() =>
			getTakerEscrowAccountMeta.call(ctx, authority, false, wrong)
		).toThrow();
	});
});
