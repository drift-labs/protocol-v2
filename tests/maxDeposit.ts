import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Admin, QUOTE_PRECISION, BN, OracleSource } from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('max deposit', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const solUsd = await mockOracle(1);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			userStats: true,
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('update max deposit', async () => {
		await clearingHouse.updateSpotMarketMaxTokenDeposits(0, QUOTE_PRECISION);
		const market = clearingHouse.getSpotMarketAccount(0);
		console.assert(market.maxTokenDeposits.eq(QUOTE_PRECISION));
	});

	it('block deposit', async () => {
		try {
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
		} catch (e) {
			return;
		}
		assert(false);
	});
});
