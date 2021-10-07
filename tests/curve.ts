import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { stripBaseAssetPrecision } from '../sdk/lib';
import {
	AMM_MANTISSA,
	PEG_SCALAR,
	USDC_PRECISION,
	ClearingHouse,
	PositionDirection,
	stripMantissa,
} from '../sdk/src';
import { assert } from '../sdk/src/assert/assert';
import { UserAccount } from '../sdk/src/userAccount';
import { mockUSDCMint, mockUserUSDCAccount } from '../utils/mockAccounts';
import { createPriceFeed, setFeedPrice } from '../utils/mockPythUtils';

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

	const ammInitialQuoteAssetAmount = (new anchor.BN(10 ** 8)).mul(new BN(10 ** 10));
	const ammInitialBaseAssetAmount = (new anchor.BN(10 ** 8)).mul(new BN(10 ** 10));

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = new BN(0);
	const initialSOLPrice = 150;

	const usdcAmount = new BN(1e9 * 10 ** 6);
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

	const showCurve = (marketIndex) => {
		const marketsAccount = clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammAccountState = marketData.amm;

		ammAccountState.pegMultiplier;
		
		console.log('baseAssetAmountShort', stripBaseAssetPrecision(marketData.baseAssetAmountShort),
					'baseAssetAmountLong', stripBaseAssetPrecision(marketData.baseAssetAmountLong)
		);

		console.log('pegMultiplier', stripMantissa(ammAccountState.pegMultiplier, PEG_SCALAR));
		console.log('cumulativeRepegRebateShort', stripMantissa(ammAccountState.cumulativeRepegRebateShort, USDC_PRECISION));
		console.log('cumulativeRepegRebateLong', stripMantissa(ammAccountState.cumulativeRepegRebateLong, USDC_PRECISION));

		console.log('cumFee', stripMantissa(ammAccountState.cumulativeFee, USDC_PRECISION));
		console.log('cumFeeReal', stripMantissa(ammAccountState.cumulativeFeeRealized, USDC_PRECISION));
	};

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
		// const _priceIncreaseFactor = new BN(2);
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

	it('Repeg Curve LONG', async () => {
		let marketsAccount = clearingHouse.getMarketsAccount();
		let marketData = marketsAccount.markets[marketIndex.toNumber()];
		let ammAccountState = marketData.amm;
		const feeDist1 = 
		marketData.amm.cumulativeFeeRealized.add(userAccount.getTotalCollateral());
		console.log(stripMantissa(usdcAmount, USDC_PRECISION),
		
		stripMantissa(feeDist1, USDC_PRECISION));

		await setFeedPrice(
			anchor.workspace.Pyth,
			155,
			solUsdOracle
		);
		showCurve(marketIndex);

		await clearingHouse.openPosition(
			await userAccount.getPublicKey(),
			PositionDirection.LONG,
			USDC_PRECISION.mul(new BN(10)),
			marketIndex
		);

		marketsAccount = clearingHouse.getMarketsAccount();
		marketData = marketsAccount.markets[marketIndex.toNumber()];
		ammAccountState = marketData.amm;
		assert(ammAccountState.cumulativeFee.eq(ammAccountState.cumulativeFeeRealized));
		
		const feeDist11h= marketData.amm.cumulativeFeeRealized.add(userAccount.getTotalCollateral());
		console.log(stripMantissa(usdcAmount, USDC_PRECISION),
		
		stripMantissa(feeDist11h, USDC_PRECISION));
		showBook(marketIndex);

		await clearingHouse.repegAmmCurve(
			new BN(0),
			marketIndex,
		);

		console.log('\n post repeg: \n --------');
		showCurve(marketIndex);
		showBook(marketIndex);

		marketsAccount = clearingHouse.getMarketsAccount();
		marketData = marketsAccount.markets[marketIndex.toNumber()];
		ammAccountState = marketData.amm;
		assert(ammAccountState.cumulativeFee.gt(ammAccountState.cumulativeFeeRealized));

		marketsAccount = clearingHouse.getMarketsAccount();
		marketData = marketsAccount.markets[marketIndex.toNumber()];
		ammAccountState = marketData.amm;
		const feeDist1h= marketData.amm.cumulativeFeeRealized.add(userAccount.getTotalCollateral());
		console.log(stripMantissa(usdcAmount, USDC_PRECISION),
		
		stripMantissa(feeDist1h, USDC_PRECISION));

		await clearingHouse.closePosition(
			await userAccount.getPublicKey(),
			marketIndex,
		);

		showCurve(marketIndex);
		marketsAccount = clearingHouse.getMarketsAccount();
		marketData = marketsAccount.markets[marketIndex.toNumber()];
		ammAccountState = marketData.amm;



		const feeDist2 = marketData.amm.cumulativeFeeRealized.add(userAccount.getTotalCollateral());
		console.log(stripMantissa(usdcAmount, USDC_PRECISION),
		
		stripMantissa(feeDist2, USDC_PRECISION));
		// assert(usdcAmount.eq(feeDist2));
	});	

	it('Repeg Curve SHORT', async () => {
		await setFeedPrice(
			anchor.workspace.Pyth,
			145,
			solUsdOracle
		);
		showCurve(marketIndex);

		await clearingHouse.openPosition(
			await userAccount.getPublicKey(),
			PositionDirection.SHORT,
			USDC_PRECISION,
			marketIndex
		);

		// const marketsAccount = clearingHouse.getMarketsAccount();
		// const marketData = marketsAccount.markets[marketIndex.toNumber()];
		await clearingHouse.repegAmmCurve(
			new BN(0),
			marketIndex,
		);

		console.log('\n post repeg: \n --------');
		showCurve(marketIndex);

		await clearingHouse.closePosition(
			await userAccount.getPublicKey(),
			marketIndex,
		);
	});	
});
