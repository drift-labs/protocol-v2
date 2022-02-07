import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import { BN } from '../sdk';
import { Admin, PEG_PRECISION } from '../sdk/src';
// import { getTokenAccount } from '@project-serum/common';
import { mockUSDCMint } from '../stress/mockAccounts';
import { stress_test } from '../stress/stress';

describe('stress-test', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);

	const chProgram = anchor.workspace.ClearingHouse as Program; // this.program-ify
	let usdcMint: Keypair;

	const clearingHouse = Admin.from(
		connection,
		//@ts-ignore
		provider.wallet,
		chProgram.programId
	);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		// await userAccount.unsubscribe();
	});

	// it('test-pegmult-peg=1', async () => {
	// 	await stress_test(
	// 		clearingHouse,
	// 		usdcMint,
	// 		provider,
	// 		1,
	// 		1337,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 20,
	// 		'stress/configs/clearingHouse.spec.pegmult.csv',
	// 		undefined,
	// 		undefined,
	// 		undefined,
	// 		'simp-peg-1'
	// 	);
	// });

	it('test-repeg-peg=150', async () => {
		const pegM = new BN(150).mul(PEG_PRECISION);
		await stress_test(
			clearingHouse,
			usdcMint,
			provider,
			1,
			100,
			10000 * 10 ** 11,
			10 ** 13,
			// 'stress/configs/slipfee.test.csv',
			undefined,
			[pegM, pegM],
			undefined,
			undefined,
			'sim-slipfee-rand1-test'
		);
	});

	// it('test-pegmult-peg=2', async () => {
	// 	const pegM = new BN(46000).mul(PEG_PRECISION);
	// 	await stress_test(
	// 		clearingHouse,
	// 		usdcMint,
	// 		provider,
	// 		1,
	// 		1337,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 30,
	// 		'stress/configs/clearingHouse.spec.pegmult.csv',
	// 		[pegM, pegM],
	// 		5,
	// 		undefined,
	// 		'simp-peg-2'
	// 	);
	// 	clearingHouse.uninitializeMarket(new BN(0));
	// 	clearingHouse.uninitializeMarket(new BN(1));
	// });

	// it('test-pegmult-peg=40000', async () => {
	// 	const pegM = new BN(40000).mul(MARK_PRICE_PRECISION);

	// 	await stress_test(
	// 		clearingHouse,
	// 		usdcMint,
	// 		provider,
	// 		1,
	// 		1337,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 20,
	// 		'stress/configs/clearingHouse.spec.pegmult.csv',
	// 		[pegM, pegM]
	// 	);
	// });

	// it('test-pegmult-peg=40000', async () => {
	// 	const pegM = new BN(20).mul(MARK_PRICE_PRECISION);

	// 	await stress_test(
	// 		clearingHouse,
	// 		usdcMint,
	// 		provider,
	// 		1,
	// 		10,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 20,
	// 		'stress/configs/clearingHouse.spec.pegmult.csv',
	// 		[pegM, pegM],
	// 		10,
	// 		undefined,
	// 		'simp-peg-40000'
	// 	);
	// });
});
