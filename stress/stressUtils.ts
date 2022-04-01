import * as anchor from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import csv from 'csvtojson';
import fs from 'fs';
import {
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
} from '../sdk/src';
import { mockUserUSDCAccount } from './mockAccounts';

export async function initUserAccounts(
	NUM_USERS,
	usdcMint,
	usdcAmount,
	provider: anchor.Provider
) {
	const user_keys = [];
	const userUSDCAccounts = [];
	const clearingHouses = [];
	const userAccountInfos = [];

	let userAccountPublicKey: PublicKey;

	for (let i = 0; i < NUM_USERS; i++) {
		console.log('user', i, 'initialize');

		const owner = anchor.web3.Keypair.generate();
		const ownerWallet = new anchor.Wallet(owner);
		await provider.connection.requestAirdrop(ownerWallet.publicKey, 100000000);

		const newUserAcct = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			ownerWallet.publicKey
		);

		const chProgram = anchor.workspace.ClearingHouse as anchor.Program; // this.program-ify

		const clearingHouse1 = ClearingHouse.from(
			provider.connection,
			//@ts-ignore
			ownerWallet,
			chProgram.programId
		);

		// await clearingHouse1.initialize(usdcMint.publicKey, false);
		await clearingHouse1.subscribe();

		userUSDCAccounts.push(newUserAcct);
		clearingHouses.push(clearingHouse1);
		// var last_idx = userUSDCAccounts.length - 1;

		// try {
		[, userAccountPublicKey] =
			await clearingHouse1.initializeUserAccountAndDepositCollateral(
				// marketPublicKey,
				usdcAmount,
				newUserAcct.publicKey
			);

		// const userAccount = 0;
		const userAccount = ClearingHouseUser.from(
			clearingHouse1,
			ownerWallet.publicKey
		);
		await userAccount.subscribe();

		userAccountInfos.push(userAccount);

		// } catch (e) {
		// 	assert(true);
		// }

		user_keys.push(userAccountPublicKey);
	}
	return [userUSDCAccounts, user_keys, clearingHouses, userAccountInfos];
}

export async function simEvent(
	clearingHouse,
	user_i,
	user_e,
	userUSDCAccount,
	market_i,
	rand_e,
	rand_amt
) {
	let succeeded = true;

	try {
		switch (rand_e) {
			case 'noop':
				break;
			case 'deposit':
				await clearingHouse.depositCollateral(
					rand_amt,
					userUSDCAccount.publicKey
				);
				break;
			case 'withdraw':
				await clearingHouse.withdrawCollateral(
					rand_amt,
					userUSDCAccount.publicKey
				);
				break;
			case 'buy':
				await clearingHouse.openPosition(
					PositionDirection.LONG,
					rand_amt,
					market_i
				);
				break;
			case 'sell':
				await clearingHouse.openPosition(
					PositionDirection.SHORT,
					rand_amt,
					market_i
				);
				break;

			case 'move':
				await clearingHouse.moveAmmToPrice(market_i, rand_amt);
				break;

			case 'repeg':
				await clearingHouse.repegAmmCurve(rand_amt, market_i);
				break;

			case 'close':
				await clearingHouse.closePosition(market_i);
				break;

			case 'liquidate':
				await clearingHouse.liquidate(user_e);
				break;

			default:
			//default statement or expression;
		}
	} catch (e) {
		succeeded = false;
		console.log('failed tx');
		console.log(e);
		// assert(true);
	}

	//todo: better way?
	const event_i = JSON.parse(
		JSON.stringify({
			user_i: user_i,
			event: rand_e,
			amt: rand_amt.toNumber(),
			market_i: market_i.toNumber(),
			succeeded: succeeded,
		})
	);

	return event_i;
}

export async function readStressCSV(ff, _maxLines = 100) {
	// let count = 0;
	// let fsStream = fs.createReadStream(ff);
	// let csvStream = csv();
	// let jsonArrayObj = [];

	// fsStream.pipe(csvStream)
	// 	.on('headers', (headers) => {
	// 		console.log(headers)
	// 	})
	// 	.on('data', (data) => {
	// 		if (count >= maxLines) {
	// 			fsStream.unpipe(csvStream);
	// 			csvStream.end();
	// 			fsStream.destroy();
	// 		} else {
	// 			console.log(data);
	// 			count++;
	// 		}
	// 	});
	if (!fs.existsSync(ff)) {
		console.log('cannot find', ff);
		return [];
	}

	return await csv()
		.fromFile(ff)
		.then(function (jsonArrayObj) {
			//when parse finished, result will be emitted here.
			return jsonArrayObj;
		});
}

export function writeStressCSV(timeline, output_ff) {
	const csvContent =
		Object.keys(timeline[0]).join(',') +
		'\n' +
		timeline
			.map((e) =>
				Object.values(e)
					.map((o) => o.toString())
					.join(',')
			)
			.join('\n');

	// var encodedUri = encodeURI(csvContent);
	try {
		if (!fs.existsSync('output')) {
			fs.mkdirSync('output');
		}
		output_ff;
		fs.writeFileSync(output_ff, csvContent);

		//file written successfully
	} catch (err) {
		console.log('write failure');
		console.error(err);
	}
}
