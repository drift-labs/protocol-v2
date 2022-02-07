import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
// import minheap from 'minheap';
import { assert } from 'chai';
import {
	Arbitrager,
	ClearingHouse,
	Liquidator,
	PositionDirection,
	ClearingHouseUser,
	BN,
} from '../sdk/src';
import { mockOracle, mockUSDCMint } from './mockAccounts';
import { getFeedData } from './mockPythUtils';
import { initUserAccounts } from './stressUtils';

// var maxHeap = new minheap.Heap(function(a,b) {
//  return b - a;
// });

const marketLast = [0, 0, 0, 0]; // todo: only for first four markets

const myArgs = process.argv.slice(2);
console.log('myArgs: ', myArgs);

async function arbTrade(clearingHouse, marketIndex) {
	// arb user
	const state: any = await clearingHouse.program.state.fetch();
	const marketsAccount: any =
		await clearingHouse.program.account.marketsAccount.fetch(
			state.marketsAccount
		);

	const marketData = marketsAccount.markets[marketIndex.toNumber()];
	const ammData = marketData.amm;
	const oracleData = await getFeedData(anchor.workspace.Pyth, ammData.oracle);
	const ast_px =
		ammData.quoteAssetAmount.toNumber() / ammData.baseAssetAmount.toNumber();

	// const user: any = await clearingHouse.program.account.userAccount.fetch(
	// 	user_e
	// );

	// const upnl = await user_act_info_e.getUnrealizedPNL();
	const xeq_scaled = ammData.xeq; //.div(MARK_PRICE_PRECISION);
	const _ast_px2 = ast_px * xeq_scaled;

	const limitPrice = new BN(oracleData.price * xeq_scaled);

	const [direction, amount] = clearingHouse.calculateTargetPriceTrade(
		marketIndex,
		limitPrice,
		0.5 //todo: only go 50% toward oracle? anticipates priceImpact
	);

	return [direction, amount, limitPrice];
}

async function _liquidate(userAccountInfos, liqCH, liqUSDCKey, liqPubKey) {
	const liqRatio = new BN(500); // 5%

	for (let i = 0; i < userAccountInfos.length; i++) {
		// Loop through and check open positions
		const _openPositions = userAccountInfos[i].userPositionsAccount;

		// Calculate Margin Ratio of an account
		const marginRatio = await userAccountInfos[i].getMarginRatio();
		console.log('user', i, marginRatio);

		// If Margin Ratio under 5%
		if (marginRatio.lte(liqRatio)) {
			console.log('liquidating user ', i, 'marginRatio:', marginRatio);
			const userPubKey = await userAccountInfos[i].getPublicKey();

			//todo: shouldnt await in live?
			//todo: user is liquidating and rewarding themselves
			const tx = await liqCH.liquidate(liqUSDCKey, liqPubKey, userPubKey);

			console.log(tx);
		}
	}
}

async function _arbMarkets(allOracles, liqCH, liqPubKey) {
	for (let i = 0; i < allOracles.length; i++) {
		const marketIndex = new BN(i);
		const [direction, amount, limitPrice] = await arbTrade(liqCH, marketIndex);
		if (amount.gt(new BN(0))) {
			console.log(
				'arbing market:',
				marketIndex,
				'trade:',
				direction,
				amount,
				'limit:',
				limitPrice
			);
			const tx = await liqCH.openPosition(
				liqPubKey,
				direction,
				amount,
				marketIndex,
				limitPrice
			);
			console.log(tx);
		}
	}
}

async function fundingRateCalcMarkets(allOracles, liqCH) {
	for (let i = 0; i < allOracles.length; i++) {
		const marketIndex = new BN(i);
		// if(amount.gt(new BN(0))){
		const tx = await liqCH.updateFundingRate(
			marketIndex,
			allOracles[i].publicKey
		);
		console.log(tx);
		// }
	}
}

async function crank(mock = true, actions = ['liq'], chProgram?) {
	// Loop through all user accounts, has user liquidate itself

	// todo: periodically check if new user accounts are created
	// todo: hook up marketPriceCallback to marketEvents (luke's change)

	const numIters = 10;

	let provider;
	let clearingHouse;

	let userAccountInfos;
	let clearingHouses;
	let _userUSDCAccounts;
	let _userAccountKeys;

	let liqUSDCAccounts;
	let liqClearingHouses;
	let _liqAccountInfos;
	let _liqAccountKeys;

	let allUsers;
	let allOracles;

	if (mock) {
		provider = anchor.Provider.local();
		const connection = provider.connection;
		const chProgramMock = anchor.workspace.ClearingHouse as Program;
		clearingHouse = ClearingHouse.from(
			connection,
			provider.wallet,
			chProgramMock.programId
		);
		const usdcMint = await mockUSDCMint(provider);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		const user_capital = 10000;
		const usdcAmount = new BN(user_capital); // $10k? maybe way less...

		// const solUsd = anchor.web3.Keypair.generate();
		const dogMoney = await mockOracle(0.99, -6);
		const periodicity = new BN(1); // 1 SECOND

		// todo: should be equal at init, with xeq for scale as oracle px
		const k = 10e10;
		const numUsers = 2;

		const pairAmt = Math.sqrt(k);
		const ammInitialQuoteAssetAmount = new anchor.BN(pairAmt);
		const ammInitialBaseAssetAmount = new anchor.BN(pairAmt);

		// ammInvariant == k == x * y
		// const ammInvariant = ammInitialQuoteAssetAmount.mul(
		// 	ammInitialBaseAssetAmount
		// );

		const [, _marketPublicKey] = await clearingHouse.initializeMarket(
			new BN(0),
			dogMoney,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		const solUsd = await mockOracle(22, -6);
		const [, _marketPublicKey2] = await clearingHouse.initializeMarket(
			new BN(1),
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		allOracles = [dogMoney, solUsd];

		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		[_userUSDCAccounts, _userAccountKeys, clearingHouses, userAccountInfos] =
			await initUserAccounts(numUsers, usdcMint, usdcAmount, provider);

		[liqUSDCAccounts, _liqAccountKeys, liqClearingHouses, _liqAccountInfos] =
			await initUserAccounts(1, usdcMint, usdcAmount.mul(new BN(10)), provider);

		// add a mock user position to be liquidated
		const marketIndex = new BN(0);
		const userAccount = userAccountInfos[0];
		console.log(userAccount.getFreeCollateral());
		await clearingHouses[0].openPosition(
			await userAccount.getPublicKey(),
			PositionDirection.SHORT,
			new BN(10),
			marketIndex
		);
		console.log('openPos Success');

		const marketPosition = userAccount.userPositionsAccount.positions[0];
		console.log(marketPosition, marketIndex);
		assert(marketIndex.eq(marketPosition.marketIndex));
		const liqPrice = userAccount.liquidationPrice(marketPosition, 'mid');

		if (liqPrice.gt(new BN(0))) {
			await clearingHouse.moveAmmToPrice(marketPosition.marketIndex, liqPrice);
			console.log('movePos Success');
		}

		allUsers = await clearingHouse.program.account.userAccount.all();
	} else {
		provider = anchor.Provider.local(); //todo
		const connection = provider.connection;

		const clearingHouse = ClearingHouse.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
		allUsers = await clearingHouse.program.account.user.all();
		assert(allUsers.length > 0, 'No Users Found');

		for (let i = 0; i < allUsers.length, i++; ) {
			const ownerWallet = allUsers[i];

			const clearingHouse1 = ClearingHouse.from(
				provider.connection,
				//@ts-ignore
				ownerWallet,
				chProgram.programId
			);
			await clearingHouse1.subscribe();
			clearingHouses.push(clearingHouse1);
			const userAccount = ClearingHouseUser.from(
				clearingHouse1,
				ownerWallet.publicKey
			);
			await userAccount.subscribe();
			userAccountInfos.push(userAccount);
		}
	}

	const liqUSDCKey = liqUSDCAccounts[0].publicKey;
	const liqCH = liqClearingHouses[0];

	const liquidator = new Liquidator(liqCH, liqUSDCKey);
	const arbitrager = new Arbitrager(liqCH);

	//todo forever
	let count = 0;
	while (count < numIters) {
		console.log(count);

		if (actions.includes('liq')) {
			console.log('running liq');
			await liquidator.liquidate(userAccountInfos); //todo
		}
		if (actions.includes('arb')) {
			console.log('running arb');
			const tradesToExecute = await arbitrager.findTradesToExecute();
			for (const tradeToExecute of tradesToExecute) {
				await arbitrager.executeTrade(tradeToExecute);
			}
		}
		if (actions.includes('funding')) {
			console.log('running funding');
			await fundingRateCalcMarkets(allOracles, liqCH);
		}

		count = count + 1;
		delay(100);
	}
}

function _onMarketChange(clearingHouse, marketIndex) {
	marketLast[marketIndex] =
		clearingHouse.calculateBaseAssetPricePoint(marketIndex);
	console.log(marketLast);
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms, ms));
}

describe('liquidate-test', () => {
	it('liquidate-test1', async () => {
		await crank();
		console.log('success!');
	});
});
