import { describe, expect, test } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import { VelocityCore } from '../../src/core/VelocityCore';
import { BN } from '../../src/isomorphic/anchor';
import type { UserAccount } from '../../src/types';

describe('VelocityCore.remainingAccounts', () => {
	test('includes spot/perp + oracle accounts based on user positions', () => {
		const spotMarket0 = {
			marketIndex: 0,
			pubkey: Keypair.generate().publicKey,
			oracle: Keypair.generate().publicKey,
		} as any;
		const quoteSpotMarket = {
			marketIndex: 0,
			pubkey: spotMarket0.pubkey,
			oracle: spotMarket0.oracle,
		} as any;
		const perpMarket0 = {
			pubkey: Keypair.generate().publicKey,
			quoteSpotMarketIndex: 0,
			amm: {
				oracle: Keypair.generate().publicKey,
				oracleSource: { prelaunch: {} },
			},
		} as any;

		const user: UserAccount = {
			authority: Keypair.generate().publicKey,
			subAccountId: 0,
			spotPositions: [
				{
					marketIndex: 0,
					scaledBalance: new BN(1),
					openBids: new BN(0),
					openAsks: new BN(0),
					cumulativeDeposits: new BN(0),
					balanceType: { deposit: {} },
					openOrders: 0,
				} as any,
			],
			perpPositions: [
				{
					marketIndex: 0,
					baseAssetAmount: new BN(1),
				} as any,
			],
		} as any;

		const ctx = {
			getPerpMarketAccount: () => perpMarket0,
			getSpotMarketAccount: () => quoteSpotMarket,
			getUserAccountAndSlot: () => ({ slot: 0 }),
			activeSubAccountId: 0,
			authority: user.authority,
			perpMarketLastSlotCache: new Map<number, number>(),
			spotMarketLastSlotCache: new Map<number, number>(),
			mustIncludePerpMarketIndexes: new Set<number>(),
			mustIncludeSpotMarketIndexes: new Set<number>(),
		};

		const metas = VelocityCore.remainingAccounts.getRemainingAccounts(
			ctx as any,
			{
				userAccounts: [user],
			}
		);

		const keys = new Set(metas.map((m) => m.pubkey.toBase58()));
		expect(keys.has(perpMarket0.pubkey.toBase58())).toBe(true);
		expect(keys.has(perpMarket0.amm.oracle.toBase58())).toBe(true);
	});
});
