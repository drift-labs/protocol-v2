import * as anchor from '@project-serum/anchor';
import { Admin } from '../sdk/src';
import { Keypair } from '@solana/web3.js';
import { mockUSDCMint } from './../tests/testHelpers';
import { stress_test } from './stress';

describe('stress-test', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);

	const chProgram = anchor.workspace.ClearingHouse as Program; // this.program-ify
	let usdcMint: Keypair;
	let clearingHouse: Admin;

	// const clearingHouse = ClearingHouse.from(
	// 	connection,
	// 	// Network.LOCAL,
	// 	//@ts-ignore
	// 	provider.wallet,
	// 	chProgram.programId
	// );

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		// const [ammAccountAuthority, ammAccountNonce] =
		// 	await anchor.web3.PublicKey.findProgramAddress(
		// 		[
		// 			anchor.stress.bytes.utf8.encode('amm'),
		// 			ammAccount.publicKey.toBuffer(),
		// 		],
		// 		clearingHouse.program.programId
		// 	);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		// await userAccount.unsubscribe();
	});

	// it('test0', async () => {
	// 	// await stress_test(1, 15, 1000, 1e10, true);

	// 	await stress_test(
	// 		1,
	// 		1337,
	// 		10 * 10 ** 6,
	// 		25 * 10 ** 20,
	// 		'stress/configs/clearingHouse.spec.timeline.csv'
	// 	);

	// 	// await stress_test(
	// 	// 	1,
	// 	// 	13,
	// 	// 	1000,
	// 	// 	1e8,
	// 	// 	'stress/configs/stress_event_timeline.csv'
	// 	// 	// 'stress/configs/clearinghouse.spec.1.events.csv'
	// 	// 	// 'stress/configs/stress_event_timeline_bad1.csv'
	// 	// 	// 'output/stress_event_timeline.csv',
	// 	// );

	// 	console.log('success!');
	// });

	it('test-pegmult2', async () => {
		// await stress_test(1, 15, 1000, 1e10, true);

		await stress_test(
			clearingHouse,
			usdcMint,
			provider,
			1,
			100,
			10 * 10 ** 6
			// 25 * 10 ** 13,
			// 'stress/configs/clearingHouse.spec.pegmult.csv'
		);

		console.log('success!');
	});
});
