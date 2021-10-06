import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import {
	AMM_MANTISSA,
	PEG_SCALAR,
	ClearingHouse,
	PositionDirection,
	stripMantissa,
} from '../sdk/src';
import { UserAccount } from '../sdk/src/userAccount';
import { mockUSDCMint, mockUserUSDCAccount } from '../utils/mockAccounts';
import { createPriceFeed } from '../utils/mockPythUtils';

describe('AMM Curve', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	const clearingHouse = new ClearingHouse(
		connection,
		provider.wallet,
		chProgram.programId
	);

	const ammInitialQuoteAssetAmount = new anchor.BN(10 ** 13);
	const ammInitialBaseAssetAmount = new anchor.BN(10 ** 13);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = new BN(0);
	const initialSOLPrice = 150;

	const usdcAmount = new BN(100 * 10 ** 6);
	const solPositionInitialValue = usdcAmount.div(new BN(10));

	let userAccount: UserAccount;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsdOracle,
			ammInitialBaseAssetAmount.mul(PEG_SCALAR),
			ammInitialQuoteAssetAmount.mul(PEG_SCALAR),
			periodicity,
			PEG_SCALAR.mul(new BN(initialSOLPrice))
		);

		await clearingHouse.initializeUserAccount();
		userAccount = new UserAccount(clearingHouse, provider.wallet.publicKey);
		await userAccount.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	const showBook = (marketIndex) => {
		const market =
			clearingHouse.getMarketsAccount().markets[marketIndex.toNumber()];
		const currentMark =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		const [bidsPrice, bidsCumSize, asksPrice, asksCumSize] =
			clearingHouse.liquidityBook(marketIndex, 3, 0.1);

		for (let i = asksCumSize.length - 1; i >= 0; i--) {
			console.log(stripMantissa(asksPrice[i]), stripMantissa(asksCumSize[i]));
		}

		console.log('------------');
		console.log(currentMark.toNumber() / AMM_MANTISSA.toNumber());
		console.log(
			'peg:',
			stripMantissa(market.amm.pegMultiplier, PEG_SCALAR),
			'k (M*M):',
			stripMantissa(market.amm.sqrtK)
		);
		console.log('------------');
		for (let i = 0; i < bidsCumSize.length; i++) {
			console.log(stripMantissa(bidsPrice[i]), stripMantissa(bidsCumSize[i]));
		}
	};

	it('After Deposit', async () => {
		await clearingHouse.depositCollateral(
			await userAccount.getPublicKey(),
			usdcAmount,
			userUSDCAccount.publicKey
		);

		showBook(marketIndex);
	});

	it('After Position Taken', async () => {
		await clearingHouse.openPosition(
			await userAccount.getPublicKey(),
			PositionDirection.LONG,
			solPositionInitialValue,
			marketIndex
		);

		showBook(marketIndex);
	});

	it('After Position Price Moves', async () => {
		const _priceIncreaseFactor = new BN(2);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(initialSOLPrice * AMM_MANTISSA.toNumber() * 1.0001)
		);

		showBook(marketIndex);
	});
	it('Arb back to Oracle Price Moves', async () => {
		const [direction, quoteSize] = clearingHouse.calculateTargetPriceTrade(
			marketIndex,
			new BN(initialSOLPrice).mul(AMM_MANTISSA)
		);

		console.log('arbing', direction, quoteSize.toNumber());
		await clearingHouse.openPosition(
			await userAccount.getPublicKey(),
			direction,
			quoteSize,
			marketIndex
		);

		showBook(marketIndex);
	});
});
