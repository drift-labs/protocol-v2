import * as anchor from '@project-serum/anchor';
import { BN } from '../sdk';
import {
	QUOTE_PRECISION,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	convertToNumber,
	calculateMarkPrice,
	calculateTargetPriceTrade,
} from '../sdk/src';

import { assert } from '../sdk/src/assert/assert';
import { mockOracle } from './mockAccounts';
import { getFeedData, setFeedPrice } from './mockPythUtils';
import {
	initUserAccounts,
	readStressCSV,
	simEvent,
	writeStressCSV,
} from './stressUtils';

const myArgs = process.argv.slice(2);
console.log('myArgs: ', myArgs);

export async function stress_test(
	clearingHouse,
	usdcMint,
	provider,
	NUM_USERS = 1,
	NUM_EVENTS = 10,
	user_capital = 100000,
	sqrtk = 1e8,
	inputEventFile = '',
	pegs = [PEG_PRECISION, PEG_PRECISION],
	marketOffset = 0,
	outputFolder = 'output',
	outputName = ''
) {
	console.log('starting stress test');
	console.log(marketOffset, outputFolder, outputName);

	const usdcAmount = new BN(user_capital); // $10k

	// const solUsd = anchor.web3.Keypair.generate();
	const dogMoney = await mockOracle(pegs[0].div(PEG_PRECISION).toNumber(), -6);
	const solUsd = await mockOracle(22, -6);
	const oracles = [dogMoney, solUsd];

	// todo: should be equal at init, with xeq for scale as oracle px
	const periodicity = new BN(1); // 1 SECOND
	const PAIR_AMT = sqrtk;
	console.log('sqrtK:', sqrtk);
	const ammInitialQuoteAssetAmount = new BN(PAIR_AMT).mul(MARK_PRICE_PRECISION);
	const ammInitialBaseAssetAmount = new BN(PAIR_AMT).mul(MARK_PRICE_PRECISION);

	for (let i = 0; i < oracles.length; i++) {
		const amtScale = pegs[i].div(PEG_PRECISION); // same slippage pct for regardless of peg levels

		const [, _marketPublicKey] = await clearingHouse.initializeMarket(
			new BN(i + marketOffset),
			oracles[i],
			ammInitialBaseAssetAmount.div(amtScale),
			ammInitialQuoteAssetAmount.div(amtScale),
			periodicity,
			pegs[i]
		);
	}

	// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
	const [userUSDCAccounts, user_keys, clearingHouses, userAccountInfos] =
		await initUserAccounts(NUM_USERS, usdcMint, usdcAmount, provider);

	// const eventTimeline = [];
	const stateTimeline = [];
	// console.log(cnt, NUM_EVENTS);
	// require csvtojson

	async function getEventTimeline(ff): Promise<[]> {
		// Convert a csv file with csvtojson
		// csv()
		let eventTimeline;
		if (ff) {
			eventTimeline = readStressCSV(ff);
		} else {
			eventTimeline = [];
		}

		return eventTimeline;
	}

	async function getEventParams(i) {
		// console.log('getting event param', i)
		if (inputEventFile == '') {
			console.log('gen random event param', i);
			const event_kinds = [
				'deposit',
				// 'withdraw',
				'buy',
				'sell',
				'close',
				'repeg',
				// 'liquidate',
				'update_funding',
			];

			let rand_amt = new BN(Math.floor(Math.random() * 1e6));
			const user_i = Math.floor(Math.random() * user_keys.length);

			const rand_i = Math.floor(Math.random() * event_kinds.length);
			let rand_e = event_kinds[rand_i];
			let randEType;

			if (i == 0) {
				rand_e = 'noop';
			}
			//todo: expand from 2
			// const market_i = new BN(
			// 	Math.floor(Math.random() * oracles.length + marketOffset)
			// );
			const market_i = new BN(0);
			if (user_i % 2 == 0 && ['buy', 'sell'].includes(rand_e)) {
				// arb user
				// const state: any = await clearingHouse.getStateAccount();
				const marketsAccount: any = await clearingHouse.getMarketsAccount();

				const marketData = marketsAccount.markets[market_i.toNumber()];
				const ammData = marketData.amm;
				const oracleData = await getFeedData(
					anchor.workspace.Pyth,
					ammData.oracle
				);

				let _entry_px; //todo
				const oraclePriceMantissa = new BN(
					oracleData.price * PEG_PRECISION.toNumber()
				).mul(MARK_PRICE_PRECISION.div(PEG_PRECISION));
				const markPriceMantissa = calculateMarkPrice(marketData);

				[randEType, rand_amt, _entry_px] = calculateTargetPriceTrade(
					marketData,
					oraclePriceMantissa
				);

				rand_amt = BN.min(
					rand_amt.abs(),
					userAccountInfos[user_i].getFreeCollateral()
				);

				if (rand_amt.abs().lt(new BN(10000))) {
					rand_e = 'move';
					rand_amt = oraclePriceMantissa;
				} else if (
					randEType == { long: {} } ||
					oraclePriceMantissa.gt(markPriceMantissa)
				) {
					rand_e = 'buy';
				} else {
					console.log(randEType);
					// throw Error('hi');
					rand_e = 'sell';
				}
			} else {
				// dir user
			}

			// const market_i = new BN(0); //todo
			const _succeeded = true;

			return [user_i, market_i, rand_e, rand_amt];
		} else {
			let [, , rand_amt, market_i] = Object.values(eventTimeline[i]);
			const [user_i, rand_e, , ,] = Object.values(eventTimeline[i]);

			// const rand_e, user_i, succeeded = rand_e, user_i, succeeded;
			console.log('got event param', i);
			console.log(user_i, rand_e, rand_amt, market_i);

			// user_i = user_i;
			// console.log(user_i);
			market_i = new BN(market_i + marketOffset);
			console.log(market_i);
			assert(market_i.gte(new BN(marketOffset)));
			rand_amt = new BN(rand_amt);
			console.log(rand_amt);

			return [user_i, market_i, rand_e, rand_amt];
		}
	}

	let eventTimeline: Array<JSON>;

	if (inputEventFile == '') {
		eventTimeline = [];
	} else {
		// eventTimeline = await getEventTimeline(
		// 	'stress/configs/stress_event_timeline_test0.csv'
		// );
		eventTimeline = await getEventTimeline(inputEventFile);
	}

	const solUsdTimeline = await readStressCSV('../vAMM/solusd.csv');

	// console.log(event_timeline);
	const eventTimeline2 = [];

	if (inputEventFile) {
		NUM_EVENTS = eventTimeline.length;
	}

	for (let i = 0; i < NUM_EVENTS; i++) {
		const [user_i, market_i, rand_e, rand_amt] = await getEventParams(i);
		console.log([user_i, market_i, rand_e, rand_amt]);
		const user_e = user_keys[user_i];
		const userUSDCAccount = userUSDCAccounts[user_i];
		// const user_act_info_e = userAccountInfos[user_i];

		let clearingHouse_e = clearingHouses[user_i];
		if (['move'].includes(rand_e)) {
			clearingHouse_e = clearingHouse;
		}

		const event_i = await simEvent(
			clearingHouse_e,
			user_i,
			user_e,
			userUSDCAccount,
			market_i,
			rand_e,
			rand_amt
		);

		console.log('event', i, ':', event_i);
		eventTimeline2.push(event_i);

		// const state: any = clearingHouse.getStateAccount();
		const marketsAccount: any = await clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[market_i.toNumber()];
		// assert.ok(marketData.initialized);
		// assert.ok(marketData.baseAssetAmount.eq(new BN(0)));
		// assert.ok(marketData.openInterest.eq(new BN(0)));
		// assert.ok(marketData.volume.eq(new BN(0)));
		// assert.ok(marketData.volumeArb.eq(new BN(0)));

		const ammData = marketData.amm;
		// assert.ok(ammData.oracle.equals(solUsd.publicKey));
		// assert.ok(ammData.baseAssetAmount.eq(ammInitialBaseAssetAmount));
		// assert.ok(ammData.quoteAssetAmount.eq(ammInitialQuoteAssetAmount));
		// assert.ok(ammData.cumFundingRate.eq(new BN(0)));
		// assert.ok(ammData.periodicity.eq(periodicity));
		// assert.ok(ammData.fundingRate.eq(new BN(0)));
		// assert.ok(ammData.fundingRateTs.eq(new BN(0)));
		// assert.ok(ammData.markTwap.eq(new BN(0)));
		// assert.ok(ammData.markTwapTs.eq(new BN(0)));
		// assert.ok(ammData.spreadThreshold.eq(new BN(100000)));
		// assert.ok(ammData.volume1.eq(new BN(0)));
		// assert.ok(ammData.volume2.eq(new BN(0)));
		let ast_px = 0;

		try {
			ast_px = convertToNumber(
				ammData.quoteAssetReserve
					.mul(MARK_PRICE_PRECISION)
					.div(ammData.baseAssetReserve)
			);
		} catch {
			ast_px = -1;
		}

		const oracleData = await getFeedData(anchor.workspace.Pyth, ammData.oracle);

		const user: any = await clearingHouse.program.account.user.fetch(user_e);

		// const userSummary = await user_act_info_e.summary('liq');
		// const userSummary2 = await user_act_info_e.summary('avg');
		// const userSummary3 = await user_act_info_e.summary('last');

		const xeq_scaled =
			ammData.pegMultiplier.toNumber() / PEG_PRECISION.toNumber();
		const state_i = {
			market_index: market_i,

			base_ast_amt: ammData.baseAssetReserve,
			quote_ast_amt: ammData.quoteAssetReserve,

			market_oi: marketData.openInterest,

			user_i: user_i,
			user_i_collateral: user.collateral,
			user_i_cumfee: user.totalFeePaid.toNumber() / 10 ** 6,

			oracle_px: oracleData.price,

			mark_1: ast_px,
			mark_peg: xeq_scaled,
			mark_px: ast_px * xeq_scaled,
			mark_twap: convertToNumber(ammData.lastMarkPriceTwap),
			mark_twap_ts: ammData.lastMarkPriceTwapTs,
			funding_rate: convertToNumber(ammData.lastFundingRate),
			funding_rate_ts: ammData.lastFundingRateTs,

			cumSlippage: convertToNumber(ammData.cumulativeFee, QUOTE_PRECISION),
			cumSlippageProfit: convertToNumber(
				ammData.cumulativeFeeRealized,
				QUOTE_PRECISION
			),

			// repeg_pnl_pct: (
			// 	ammData.xcpr.div(ammData.xcp.div(new BN(1000))).toNumber() * 1000
			// ).toFixed(3),
		};

		const stateI2 = Object.assign(
			{},
			state_i
			// userSummary2,
			// userSummary3
			// userSummary
		);

		console.log(event_i);
		stateTimeline.push(stateI2);

		const dogMoneyData = await getFeedData(anchor.workspace.Pyth, dogMoney);

		setFeedPrice(anchor.workspace.Pyth, dogMoneyData.price * 1.01, dogMoney);
		if (solUsdTimeline.length) {
			setFeedPrice(anchor.workspace.Pyth, solUsdTimeline[i + 1].close, solUsd);
		}
	}

	writeStressCSV(
		eventTimeline2,
		outputFolder + '/' + outputName + '_stress_event_timeline.csv'
	);
	writeStressCSV(
		stateTimeline,
		outputFolder + '/' + outputName + '_stress_state_timeline.csv'
	);

	for (const clearingHouse1 of clearingHouses) {
		clearingHouse1.unsubscribe();
	}
	for (const userActInfo1 of userAccountInfos) {
		userActInfo1.unsubscribe();
	}
}

// describe('stress-test', () => {
// 	const provider = anchor.Provider.local();
// 	const connection = provider.connection;
// 	anchor.setProvider(provider);

// 	const chProgram = anchor.workspace.ClearingHouse as Program; // this.program-ify
// 	let usdcMint: Keypair;

// 	const clearingHouse = ClearingHouse.from(
// 		connection,
// 		Network.LOCAL,
// 		//@ts-ignore
// 		provider.wallet,
// 		chProgram.programId
// 	);

// 	before(async () => {
// 		usdcMint = await mockUSDCMint(provider);

// 		await clearingHouse.initialize(usdcMint.publicKey, true);
// 		await clearingHouse.subscribe();

// 		// const [ammAccountAuthority, ammAccountNonce] =
// 		// 	await anchor.web3.PublicKey.findProgramAddress(
// 		// 		[
// 		// 			anchor.stress.bytes.utf8.encode('amm'),
// 		// 			ammAccount.publicKey.toBuffer(),
// 		// 		],
// 		// 		clearingHouse.program.programId
// 		// 	);
// 	});

// 	after(async () => {
// 		await clearingHouse.unsubscribe();
// 		// await userAccount.unsubscribe();
// 	});

// 	// it('test0', async () => {
// 	// 	// await stress_test(1, 15, 1000, 1e10, true);

// 	// 	await stress_test(
// 	// 		1,
// 	// 		1337,
// 	// 		10 * 10 ** 6,
// 	// 		25 * 10 ** 20,
// 	// 		'stress/configs/clearingHouse.spec.timeline.csv'
// 	// 	);

// 	// 	// await stress_test(
// 	// 	// 	1,
// 	// 	// 	13,
// 	// 	// 	1000,
// 	// 	// 	1e8,
// 	// 	// 	'stress/configs/stress_event_timeline.csv'
// 	// 	// 	// 'stress/configs/clearinghouse.spec.1.events.csv'
// 	// 	// 	// 'stress/configs/stress_event_timeline_bad1.csv'
// 	// 	// 	// 'output/stress_event_timeline.csv',
// 	// 	// );

// 	// 	console.log('success!');
// 	// });

// 	it('test-pegmult2', async () => {
// 		// await stress_test(1, 15, 1000, 1e10, true);

// 		await stress_test(
// 			clearingHouse,
// 			usdcMint,
// 			provider,
// 			1,
// 			1337,
// 			10 * 10 ** 6,
// 			25 * 10 ** 20,
// 			'stress/configs/clearingHouse.spec.pegmult.csv'
// 		);

// 		console.log('success!');
// 	});
// });
