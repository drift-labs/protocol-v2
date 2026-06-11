import { describe, expect, test } from 'bun:test';
import { VelocityCore } from '../../src/core/VelocityCore';
import { Keypair } from '@solana/web3.js';
import { BN } from '../../src/isomorphic/anchor';

describe('VelocityCore instruction builders', () => {
	test('buildDepositInstruction calls underlying program.deposit', async () => {
		const called: any[] = [];
		const fakeIx = {
			keys: [],
			programId: Keypair.generate().publicKey,
			data: Buffer.alloc(0),
		};

		const program = {
			instruction: {
				deposit: async (...args: any[]) => {
					called.push(args);
					return fakeIx;
				},
			},
		};

		const pk = () => Keypair.generate().publicKey;

		const ix = await VelocityCore.buildDepositInstruction({
			program,
			marketIndex: 1,
			amount: new BN(123),
			reduceOnly: false,
			state: pk(),
			spotMarket: pk(),
			spotMarketVault: pk(),
			user: pk(),
			userStats: pk(),
			userTokenAccount: pk(),
			authority: pk(),
			tokenProgram: pk(),
			remainingAccounts: [],
		});

		expect(ix).toBe(fakeIx as any);
		expect(called.length).toBe(1);
		expect(called[0][0]).toBe(1);
	});
});
