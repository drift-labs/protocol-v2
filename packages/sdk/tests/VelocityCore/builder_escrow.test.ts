import { describe, expect, test } from 'bun:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { VelocityClient } from '../../src/velocityClient';
import { ReferrerMap } from '../../src/userMap/referrerMap';
import { getRevenueShareEscrowAccountPublicKey } from '../../src/addresses/pda';
import { RevenueShareEscrowAccount } from '../../src/types';

// `getTakerEscrowAccountMeta` decides whether a perp fill must carry the taker's
// RevenueShareEscrow account. It only reads `this.program.programId`, so we can
// exercise the decision with a minimal `this` instead of a full client.
// Regression guard for: a referred taker (escrow initialized with a referrer)
// whose order carries no builder code must still get the escrow attached, else
// the program rejects the fill with UnableToLoadRevenueShareAccount.
const getTakerEscrowAccountMeta = (VelocityClient.prototype as any)
	.getTakerEscrowAccountMeta as (
	takerAuthority: PublicKey,
	orderHasBuilder: boolean,
	takerEscrow?: RevenueShareEscrowAccount,
	takerIsReferred?: boolean
) => { pubkey: PublicKey; isWritable: boolean; isSigner: boolean } | undefined;

const programId = Keypair.generate().publicKey;
const ctx = { program: { programId } };
const escrow = (
	authority: PublicKey,
	referrer: PublicKey
): RevenueShareEscrowAccount =>
	({ authority, referrer }) as unknown as RevenueShareEscrowAccount;

describe('getTakerEscrowAccountMeta (fill escrow attachment)', () => {
	test('takerIsReferred, order without builder -> escrow attached', () => {
		const authority = Keypair.generate().publicKey;
		const meta = getTakerEscrowAccountMeta.call(
			ctx,
			authority,
			false,
			undefined,
			true
		);
		expect(meta).toBeDefined();
		expect(
			meta!.pubkey.equals(
				getRevenueShareEscrowAccountPublicKey(programId, authority)
			)
		).toBe(true);
		expect(meta!.isWritable).toBe(true);
	});

	test('not referred, order without builder -> no escrow', () => {
		const authority = Keypair.generate().publicKey;
		expect(
			getTakerEscrowAccountMeta.call(ctx, authority, false, undefined, false)
		).toBeUndefined();
	});

	test('builder-code order attaches escrow (no referral signal needed)', () => {
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

	test('decoded escrow with a referrer still attaches (back-compat)', () => {
		const authority = Keypair.generate().publicKey;
		const meta = getTakerEscrowAccountMeta.call(
			ctx,
			authority,
			false,
			escrow(authority, Keypair.generate().publicKey)
		);
		expect(meta).toBeDefined();
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

// Guards the referral bit ReferrerMap reads out of the taker's UserStats — the
// signal the fillers pass to getFillPerpOrderIx. Locks the `referrer_status`
// byte offset (188) and the BuilderReferral bit (0b100).
describe('ReferrerMap.mustGetIsBuilderReferral', () => {
	const REFERRER_STATUS_OFFSET = 188;
	const statsBuffer = (referrerStatus: number): Buffer => {
		const buf = Buffer.alloc(REFERRER_STATUS_OFFSET + 8);
		buf[REFERRER_STATUS_OFFSET] = referrerStatus;
		return buf;
	};
	const fakeClient = (buf: Buffer | null) =>
		({
			program: { programId: Keypair.generate().publicKey },
			connection: { getAccountInfo: async () => (buf ? { data: buf } : null) },
		}) as any;
	const authority = () => Keypair.generate().publicKey.toBase58();

	test('BuilderReferral bit set -> true', async () => {
		const map = new ReferrerMap(fakeClient(statsBuffer(0b100)));
		expect(await map.mustGetIsBuilderReferral(authority())).toBe(true);
	});

	test('IsReferred without BuilderReferral -> false', async () => {
		const map = new ReferrerMap(fakeClient(statsBuffer(0b010)));
		expect(await map.mustGetIsBuilderReferral(authority())).toBe(false);
	});
});
