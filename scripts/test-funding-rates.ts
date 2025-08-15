#!/usr/bin/env ts-node

/**
 * test funding rates for openai synthetic market
 *
 * this script tests and simulates funding rate mechanisms for the openai market
 */

import { Connection, Keypair } from '@solana/web3.js';
import { BN, Wallet } from '@coral-xyz/anchor';
import { TestClient } from '../sdk/src/testClient';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import {
	PRICE_PRECISION,
	BASE_PRECISION,
} from '../sdk/src/constants/numericConstants';

// configuration
const NETWORK_URLS = {
	localnet: 'http://localhost:8899',
	devnet: 'https://api.devnet.solana.com',
	mainnet: 'https://api.mainnet-beta.solana.com',
};

const NETWORK =
	(process.env.SOLANA_CLUSTER as keyof typeof NETWORK_URLS) || 'localnet';
const RPC_URL = NETWORK_URLS[NETWORK];
const OPENAI_MARKET_INDEX = NETWORK === 'mainnet' ? 76 : 29;

console.log(`using ${NETWORK} network: ${RPC_URL}`);

async function testFundingRates() {
	try {
		// setup client
		let wallet: Wallet;
		if (process.env.ANCHOR_WALLET) {
			const keypairData = JSON.parse(
				require('fs').readFileSync(process.env.ANCHOR_WALLET, 'utf8')
			);
			const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
			wallet = new Wallet(keypair);
		} else {
			wallet = new Wallet(Keypair.generate());
		}

		const connection = new Connection(RPC_URL, 'confirmed');
		const driftClient = new TestClient({
			connection,
			wallet,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [OPENAI_MARKET_INDEX],
			spotMarketIndexes: [0],
			subAccountIds: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: new TestBulkAccountLoader(connection, 'confirmed', 1),
			},
		});

		await driftClient.subscribe();

		// get market data
		const market = driftClient.getPerpMarketAccount(OPENAI_MARKET_INDEX);

		console.log('market funding configuration:');
		console.log(
			`  funding period: ${market.amm.fundingPeriod.toString()} seconds (${
				market.amm.fundingPeriod.toNumber() / 3600
			} hours)`
		);
		console.log(
			`  last funding rate: ${market.amm.lastFundingRate.toString()}`
		);
		console.log(
			`  last funding rate ts: ${new Date(
				market.amm.lastFundingRateTs.toNumber() * 1000
			).toISOString()}`
		);
		console.log(
			`  cumulative funding rate long: ${market.amm.cumulativeFundingRateLong.toString()}`
		);
		console.log(
			`  cumulative funding rate short: ${market.amm.cumulativeFundingRateShort.toString()}`
		);

		// calculate funding rate scenarios
		console.log('funding rate scenarios:');

		// scenario 1: balanced market (mark price = oracle price)
		const oraclePrice = new BN(2000).mul(PRICE_PRECISION); // $2000
		const markPrice = oraclePrice; // balanced

		console.log('1. balanced market:');
		console.log(
			`   oracle price: $${oraclePrice.div(PRICE_PRECISION).toString()}`
		);
		console.log(`   mark price: $${markPrice.div(PRICE_PRECISION).toString()}`);
		console.log(`   expected funding: ~0% (balanced)`);

		// scenario 2: long-heavy market (mark price > oracle price)
		const markPriceHigh = oraclePrice.mul(new BN(105)).div(new BN(100)); // 5% premium

		console.log('2. long-heavy market:');
		console.log(
			`   oracle price: $${oraclePrice.div(PRICE_PRECISION).toString()}`
		);
		console.log(
			`   mark price: $${markPriceHigh.div(PRICE_PRECISION).toString()}`
		);
		console.log(`   premium: 5%`);
		console.log(`   expected funding: positive (longs pay shorts)`);

		// scenario 3: short-heavy market (mark price < oracle price)
		const markPriceLow = oraclePrice.mul(new BN(95)).div(new BN(100)); // 5% discount

		console.log('3. short-heavy market:');
		console.log(
			`   oracle price: $${oraclePrice.div(PRICE_PRECISION).toString()}`
		);
		console.log(
			`   mark price: $${markPriceLow.div(PRICE_PRECISION).toString()}`
		);
		console.log(`   discount: 5%`);
		console.log(`   expected funding: negative (shorts pay longs)`);

		// simulate funding payments
		console.log('funding payment simulation:');

		const positionSize = new BN(10).mul(BASE_PRECISION); // 10 units
		const positionNotional = positionSize.mul(oraclePrice).div(BASE_PRECISION); // position value

		// typical funding rate calculation: (mark_price - oracle_price) / oracle_price / funding_periods_per_day
		const fundingRateHigh = markPriceHigh
			.sub(oraclePrice)
			.mul(PRICE_PRECISION)
			.div(oraclePrice)
			.div(new BN(24)); // 24 funding periods per day (hourly)

		const fundingRateLow = markPriceLow
			.sub(oraclePrice)
			.mul(PRICE_PRECISION)
			.div(oraclePrice)
			.div(new BN(24));

		console.log(
			`position size: ${positionSize.div(BASE_PRECISION).toString()} units`
		);
		console.log(
			`position notional: $${positionNotional.div(PRICE_PRECISION).toString()}`
		);

		console.log('long position funding (per hour):');
		console.log(`  in balanced market: $0 (no funding)`);
		console.log(
			`  in long-heavy market: -$${fundingRateHigh
				.mul(positionNotional)
				.div(PRICE_PRECISION)
				.div(PRICE_PRECISION)
				.toString()} (pays funding)`
		);
		console.log(
			`  in short-heavy market: +$${fundingRateLow
				.abs()
				.mul(positionNotional)
				.div(PRICE_PRECISION)
				.div(PRICE_PRECISION)
				.toString()} (receives funding)`
		);

		console.log('short position funding (per hour):');
		console.log(`  in balanced market: $0 (no funding)`);
		console.log(
			`  in long-heavy market: +$${fundingRateHigh
				.mul(positionNotional)
				.div(PRICE_PRECISION)
				.div(PRICE_PRECISION)
				.toString()} (receives funding)`
		);
		console.log(
			`  in short-heavy market: -$${fundingRateLow
				.abs()
				.mul(positionNotional)
				.div(PRICE_PRECISION)
				.div(PRICE_PRECISION)
				.toString()} (pays funding)`
		);
	} catch (error) {
		console.error('error testing funding rates:', error);
		process.exit(1);
	}
}

// export for use in other scripts
export { testFundingRates };

// run if called directly
if (require.main === module) {
	testFundingRates()
		.then(() => {
			process.exit(0);
		})
		.catch((error) => {
			console.error('testing failed:', error);
			process.exit(1);
		});
}
