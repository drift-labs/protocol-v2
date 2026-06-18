import { describe, expect, test } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import { VelocityCore } from '../../src/core/VelocityCore';

describe('VelocityCore fill/trigger builders', () => {
	test('buildFillPerpOrderInstruction wires accounts + args', async () => {
		const called: any[] = [];
		const fakeIx = {
			keys: [],
			programId: Keypair.generate().publicKey,
			data: Buffer.alloc(0),
		};

		const program = {
			instruction: {
				fillPerpOrder: async (...args: any[]) => {
					called.push(args);
					return fakeIx;
				},
			},
		};
		const pk = () => Keypair.generate().publicKey;

		const ix = await VelocityCore.buildFillPerpOrderInstruction({
			program,
			orderId: 7,
			state: pk(),
			filler: pk(),
			fillerStats: pk(),
			user: pk(),
			userStats: pk(),
			authority: pk(),
			remainingAccounts: [],
		});

		expect(ix).toBe(fakeIx as any);
		expect(called.length).toBe(1);
		expect(called[0][0]).toBe(7);
	});

	test('buildTriggerOrderInstruction wires accounts + args', async () => {
		const called: any[] = [];
		const fakeIx = {
			keys: [],
			programId: Keypair.generate().publicKey,
			data: Buffer.alloc(0),
		};

		const program = {
			instruction: {
				triggerOrder: async (...args: any[]) => {
					called.push(args);
					return fakeIx;
				},
			},
		};
		const pk = () => Keypair.generate().publicKey;

		const ix = await VelocityCore.buildTriggerOrderInstruction({
			program,
			orderId: 9,
			state: pk(),
			filler: pk(),
			user: pk(),
			authority: pk(),
			remainingAccounts: [],
		});

		expect(ix).toBe(fakeIx as any);
		expect(called.length).toBe(1);
		expect(called[0][0]).toBe(9);
	});
});
