import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, QUOTE_SPOT_MARKET_INDEX } from '../sdk';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	PRICE_PRECISION,
	PositionDirection,
	ExchangeStatus,
	OracleSource,
	isVariant,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
} from './testHelpers';

describe('admin withdraw', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const solOracle = await mockOracle(30);
		const periodicity = new BN(60 * 60); // 1 HOUR

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;
		const incrementalUSDCNotionalAmount = usdcAmount.mul(new BN(5));
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			incrementalUSDCNotionalAmount,
			marketIndex
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Pause exchange', async () => {
		await clearingHouse.updateExchangeStatus(ExchangeStatus.PAUSED);
		const state = clearingHouse.getStateAccount();
		assert(isVariant(state.exchangeStatus, 'paused'));
	});

	it('Block open position', async () => {
		try {
			await clearingHouse.openPosition(PositionDirection.LONG, usdcAmount, 0);
		} catch (e) {
			assert(e.message.includes('0x1788')); //Error Number: 6024. Error Message: Exchange is paused.
			return;
		}
		console.assert(false);
	});

	it('Block close position', async () => {
		try {
			await clearingHouse.closePosition(0);
		} catch (e) {
			console.log(e.msg);

			assert(e.message.includes('0x1788'));
			return;
		}
		console.assert(false);
	});

	it('Block withdrawal', async () => {
		try {
			await clearingHouse.withdraw(
				usdcAmount,
				QUOTE_SPOT_MARKET_INDEX,
				userUSDCAccount.publicKey
			);
		} catch (e) {
			console.log(e.message);
			assert(e.message.includes('0x1788'));
			return;
		}
		console.assert(false);
	});
});
