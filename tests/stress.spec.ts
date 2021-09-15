import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { AMM_MANTISSA, ClearingHouse, Network } from '../sdk/src';
// import { getTokenAccount } from '@project-serum/common';
import { mockUSDCMint } from '../utils/mockAccounts';
import { stress_test } from '../utils/stress';

describe('stress-test', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);

	const chProgram = anchor.workspace.ClearingHouse as Program; // this.program-ify
	let usdcMint: Keypair;

	const clearingHouse = new ClearingHouse(
		connection,
		Network.LOCAL,
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
	// 		'utils/configs/clearingHouse.spec.pegmult.csv',
	// 		undefined,
	// 		undefined,
	// 		undefined,
	// 		'simp-peg-1'
	// 	);
	// });

	it('test-repeg-peg=150', async () => {
		const pegM = new BN(3).mul(AMM_MANTISSA);
		await stress_test(
			clearingHouse,
			usdcMint,
			provider,
			1,
			50,
			10000 * 10 ** 11,
			10 ** (18 + 6),
			// 'utils/configs/slipfee.test.csv',
			undefined,
			[pegM, pegM],
			undefined,
			undefined,
			'sim-slipfee-rand-test'
		);
	});

	// it('test-pegmult-peg=2', async () => {
	// 	const pegM = new BN(2).mul(AMM_MANTISSA);
	// 	await stress_test(
	// 		clearingHouse,
	// 		usdcMint,
	// 		provider,
	// 		1,
	// 		1337,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 20,
	// 		'utils/configs/clearingHouse.spec.pegmult.csv',
	// 		[pegM, pegM],
	// 		5,
	// 		undefined,
	// 		'simp-peg-2'
	// 	);
	// 	clearingHouse.uninitializeMarket(new BN(0));
	// 	clearingHouse.uninitializeMarket(new BN(1));
	// });

	// it('test-pegmult-peg=40000', async () => {
	// 	const pegM = new BN(40000).mul(AMM_MANTISSA);

	// 	await stress_test(
	// 		clearingHouse,
	// 		usdcMint,
	// 		provider,
	// 		1,
	// 		1337,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 20,
	// 		'utils/configs/clearingHouse.spec.pegmult.csv',
	// 		[pegM, pegM]
	// 	);
	// });

	// it('test-pegmult-peg=40000', async () => {
	// 	const pegM = new BN(20).mul(AMM_MANTISSA);

	// 	await stress_test(
	// 		clearingHouse,
	// 		usdcMint,
	// 		provider,
	// 		1,
	// 		10,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 20,
	// 		'utils/configs/clearingHouse.spec.pegmult.csv',
	// 		[pegM, pegM],
	// 		10,
	// 		undefined,
	// 		'simp-peg-40000'
	// 	);
	// });
});
