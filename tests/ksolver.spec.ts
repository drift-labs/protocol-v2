import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import {
	AMM_MANTISSA,
	ClearingHouse,
	Network,
	PositionDirection,
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
		Network.LOCAL,
		provider.wallet,
		chProgram.programId
	);

	const ammInitialQuoteAssetAmount = new anchor.BN(2 * 10 ** 13);
	const ammInitialBaseAssetAmount = new anchor.BN(2 * 10 ** 13);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = new BN(0);
	const initialSOLPrice = 46000;
	function normAssetAmount(assetAmount: BN, pegMultiplier: number) : BN{
		// assetAmount is scaled to offer comparable slippage
		return assetAmount.mul(AMM_MANTISSA).div(new BN((pegMultiplier) * AMM_MANTISSA.toNumber()));
	}
	const usdcAmount = new BN(10000 * 10 ** 6);
	const solPositionInitialValue = usdcAmount;

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
			normAssetAmount(ammInitialBaseAssetAmount, initialSOLPrice),
			normAssetAmount(ammInitialQuoteAssetAmount, initialSOLPrice),
			periodicity,
			AMM_MANTISSA.mul(new BN(initialSOLPrice))
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
			clearingHouse.liquidityBook(marketIndex, 1, 0.5);

		for (let i = asksCumSize.length - 1; i >= 0; i--) {
			console.log(
				asksPrice[i].toNumber() / AMM_MANTISSA.toNumber(),
				asksCumSize[i].toNumber() / AMM_MANTISSA.toNumber()
			);
		}

		console.log('------------');
		console.log(currentMark.toNumber() / AMM_MANTISSA.toNumber());
		console.log(
			'peg:',
			market.amm.pegMultiplier.toNumber() / AMM_MANTISSA.toNumber(),
			'k (M*M):',
			market.amm.k.div(AMM_MANTISSA).div(AMM_MANTISSA).toNumber()
		);
		console.log('------------');
		for (let i = 0; i < bidsCumSize.length; i++) {
			console.log(
				bidsPrice[i].toNumber() / AMM_MANTISSA.toNumber(),
				bidsCumSize[i].toNumber() / AMM_MANTISSA.toNumber()
			);
		}
	};

	it('After Deposit', async () => {
		await clearingHouse.depositCollateral(
			await userAccount.getPublicKey(),
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	it('After Position Taken', async () => {
		await clearingHouse.openPosition(
			await userAccount.getPublicKey(),
			PositionDirection.LONG,
			solPositionInitialValue,
			marketIndex
		);

		const avgSlippageCenter = clearingHouse.calculatePriceImpact(
			PositionDirection.LONG,
			new BN(50000 * AMM_MANTISSA.toNumber()),
			new BN(0),
			'pctMax'
		);
		showBook(marketIndex);

		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(initialSOLPrice * AMM_MANTISSA.toNumber() * 1.33)
		);

		const avgSlippage25PctOut = clearingHouse.calculatePriceImpact(
			PositionDirection.LONG,
			new BN(50000 * AMM_MANTISSA.toNumber()),
			new BN(0),
			'pctMax'
		);

		showBook(marketIndex);

		console.log(
			'Center Slippage:',
			avgSlippageCenter.toNumber() / AMM_MANTISSA.toNumber(),
			'\n',
			'33% up out Slippage:',
			avgSlippage25PctOut.toNumber() / AMM_MANTISSA.toNumber()
		);
	});
});
