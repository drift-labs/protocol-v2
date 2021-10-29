import * as anchor from '@project-serum/anchor';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	AMM_MANTISSA,
	ClearingHouse,
	PositionDirection,
	USDC_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from '../utils/mockAccounts';
import { setFeedPrice } from '../utils/mockPythUtils';

describe('max reserves', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));

	// MAX SQRT K WITHOUT MATH ERRORS
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13)
		.mul(mantissaSqrtScale)
		.mul(AMM_MANTISSA);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13)
		.mul(mantissaSqrtScale)
		.mul(AMM_MANTISSA);

	const usdcAmount = new BN(USDC_PRECISION)
		.mul(mantissaSqrtScale)
		.mul(new BN(1));

	const maxPositions = 5;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = ClearingHouse.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		for (let i = 0; i < maxPositions; i++) {
			const oracle = await mockOracle(1);
			const periodicity = new BN(0);

			await clearingHouse.initializeMarket(
				new BN(i),
				oracle,
				ammInitialBaseAssetReserve,
				ammInitialQuoteAssetReserve,
				periodicity
			);
		}

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('open max positions', async () => {
		const usdcPerPosition = usdcAmount
			.mul(new BN(5))
			.div(new BN(maxPositions))
			.mul(new BN(99))
			.div(new BN(100));
		for (let i = 0; i < maxPositions; i++) {
			await clearingHouse.openPosition(
				userAccountPublicKey,
				PositionDirection.LONG,
				usdcPerPosition,
				new BN(i),
				new BN(0)
			);
		}
	});

	it('partial liquidate', async () => {
		const markets = clearingHouse.getMarketsAccount();
		for (let i = 0; i < maxPositions; i++) {
			const oracle = markets.markets[i].amm.oracle;
			await setFeedPrice(anchor.workspace.Pyth, 0.8, oracle);
			await clearingHouse.updateFundingRate(oracle, new BN(i));
			await clearingHouse.moveAmmToPrice(
				new BN(i),
				new BN((1 / 1.18) * AMM_MANTISSA.toNumber())
			);
		}
		console.log('liquidate');
		await clearingHouse.liquidate(userAccountPublicKey, userAccountPublicKey);
	});

	it('liquidate', async () => {
		const markets = clearingHouse.getMarketsAccount();
		for (let i = 0; i < maxPositions; i++) {
			const oracle = markets.markets[i].amm.oracle;
			await setFeedPrice(anchor.workspace.Pyth, 0.1, oracle);
			await clearingHouse.moveAmmToPrice(
				new BN(i),
				new BN(0.1 * AMM_MANTISSA.toNumber())
			);
		}

		await clearingHouse.liquidate(userAccountPublicKey, userAccountPublicKey);
	});
});
