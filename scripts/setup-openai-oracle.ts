#!/usr/bin/env ts-node

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { AdminClient } from '../sdk/src/adminClient';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';

const NETWORK_URLS = {
	localnet: 'http://localhost:8899',
	devnet: 'https://api.devnet.solana.com',
	mainnet: 'https://api.mainnet-beta.solana.com',
};

const NETWORK =
	(process.env.SOLANA_CLUSTER as keyof typeof NETWORK_URLS) || 'localnet';
const RPC_URL = NETWORK_URLS[NETWORK];
const OPENAI_MARKET_INDEX = NETWORK === 'mainnet' ? 76 : 29;

console.log(`Using ${NETWORK} network: ${RPC_URL}`);

/**
 * For now, this script demonstrates how to update the oracle for the OpenAI market.
 * In a real implementation, you would:
 * 1. Set up a Pyth Price Feed for OpenAI valuation
 * 2. Use Switchboard for custom data feeds
 * 3. Create a custom oracle program
 */

// const OPENAI_PYTH_FEED_ID =
// '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

const PLACEHOLDER_ORACLE = new PublicKey('11111111111111111111111111111111');

async function setupOpenAIOracle() {
	console.log('Setting up Oracle for OpenAI Synthetic Market...');

	try {
		let wallet: Wallet;
		if (process.env.ANCHOR_WALLET) {
			const keypairData = JSON.parse(
				require('fs').readFileSync(process.env.ANCHOR_WALLET, 'utf8')
			);
			const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
			wallet = new Wallet(keypair);
		} else {
			console.warn('No ANCHOR_WALLET found, creating temporary keypair');
			wallet = new Wallet(Keypair.generate());
		}

		const connection = new Connection(RPC_URL, 'confirmed');

		const adminClient = new AdminClient({
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

		await adminClient.subscribe();
		console.log('Connected to Drift Protocol');

		try {
			const market = adminClient.getPerpMarketAccount(OPENAI_MARKET_INDEX);
			console.log(
				`Current OpenAI Market Oracle: ${market.amm.oracle.toBase58()}`
			);
			console.log(`Oracle Source: ${JSON.stringify(market.amm.oracleSource)}`);

			if (market.amm.oracle.equals(PLACEHOLDER_ORACLE)) {
				console.log('Market is still using placeholder oracle');
			}
		} catch (error) {
			console.error(
				`OpenAI market (index ${OPENAI_MARKET_INDEX}) not found. Initialize it first.`
			);
			return;
		}
	} catch (error) {
		console.error('Error setting up oracle:', error);
		process.exit(1);
	}
}

interface MockOracleData {
	price: number;
	confidence: number;
	timestamp: number;
	source: string;
}

const MOCK_OPENAI_VALUATION: MockOracleData = {
	price: 80_000_000_000,
	confidence: 0.05,
	timestamp: Date.now(),
	source: 'Mock Oracle',
};

export { setupOpenAIOracle, MOCK_OPENAI_VALUATION };

if (require.main === module) {
	setupOpenAIOracle()
		.then(() => {
			console.log('\nOracle setup guide completed');
			process.exit(0);
		})
		.catch((error) => {
			console.error('Script failed:', error);
			process.exit(1);
		});
}
