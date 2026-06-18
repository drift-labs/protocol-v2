import { describe, expect, test } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import { VelocityCore } from '../../src/core/VelocityCore';

describe('VelocityCore settlement/liquidation builders', () => {
	test('buildSettlePnlInstruction wires args', async () => {
		const called: any[] = [];
		const fakeIx = {
			keys: [],
			programId: Keypair.generate().publicKey,
			data: Buffer.alloc(0),
		};
		const program = {
			instruction: {
				settlePnl: async (...args: any[]) => {
					called.push(args);
					return fakeIx;
				},
			},
		};
		const pk = () => Keypair.generate().publicKey;

		const ix = await VelocityCore.buildSettlePnlInstruction({
			program,
			marketIndex: 1,
			state: pk(),
			authority: pk(),
			user: pk(),
			spotMarketVault: pk(),
			remainingAccounts: [],
		});
		expect(ix).toBe(fakeIx as any);
		expect(called[0][0]).toBe(1);
	});

	test('buildLiquidatePerpInstruction wires args', async () => {
		const called: any[] = [];
		const fakeIx = {
			keys: [],
			programId: Keypair.generate().publicKey,
			data: Buffer.alloc(0),
		};
		const program = {
			instruction: {
				liquidatePerp: async (...args: any[]) => {
					called.push(args);
					return fakeIx;
				},
			},
		};
		const pk = () => Keypair.generate().publicKey;

		const ix = await VelocityCore.buildLiquidatePerpInstruction({
			program,
			marketIndex: 2,
			maxBaseAssetAmount: 123,
			limitPrice: null,
			state: pk(),
			authority: pk(),
			user: pk(),
			userStats: pk(),
			liquidator: pk(),
			liquidatorStats: pk(),
			remainingAccounts: [],
		});
		expect(ix).toBe(fakeIx as any);
		expect(called[0][0]).toBe(2);
	});
});
