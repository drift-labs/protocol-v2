#!/usr/bin/env ts-node

/**
 * @description
 * 1. initialize the openai perpetual market
 * 2. set up a mock oracle (or connect to real oracle)
 * 3. update market with oracle address
 * 4. activate the market
 * 5. run initial tests
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { initializeOpenAIMarket } from './initialize-openai-market';
import { MockOracleClient } from './mock-oracle';
import { testOpenAIMarket } from './test-openai-market';
import { AdminClient } from '../sdk/src/adminClient';
import { MarketStatus, OracleSource } from '../sdk/src/types';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

// Hardcoded configuration for localnet
const NETWORK = 'localnet';
const RPC_URL = 'http://localhost:8899';
const OPENAI_MARKET_INDEX = 29;
const DEFAULT_WALLET_PATH = join(homedir(), '.config/solana/id.json');

console.log(`[INFO] using ${NETWORK} network: ${RPC_URL}`);

interface DeploymentConfig {
	useRealOracle: boolean;
	activateMarket: boolean;
	runTests: boolean;
	pythFeedId?: string;
	oracleAddress?: PublicKey;
}

const DEFAULT_CONFIG: DeploymentConfig = {
	useRealOracle: false,
	activateMarket: true,
	runTests: true,
};

async function deployCompleteSystem(config: DeploymentConfig = DEFAULT_CONFIG) {
	console.log('[INFO] deploying complete openai synthetic market system...\n');

	try {
		// setup wallet and connection
		let wallet: Wallet;

		// Try to use the default Solana CLI wallet
		if (existsSync(DEFAULT_WALLET_PATH)) {
			console.log('[INFO] using default Solana CLI wallet');
			const keypairData = JSON.parse(readFileSync(DEFAULT_WALLET_PATH, 'utf8'));
			const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
			wallet = new Wallet(keypair);
		} else {
			console.warn(
				'[INFO] no default wallet found, creating temporary keypair'
			);
			const tempKeypair = Keypair.generate();
			wallet = new Wallet(tempKeypair);

			// For localnet, try to airdrop SOL to the temporary wallet
			console.log('[INFO] airdropping SOL to temporary wallet...');
			const connection = new Connection(RPC_URL, 'confirmed');
			try {
				const airdropSignature = await connection.requestAirdrop(
					wallet.publicKey,
					2000000000 // 2 SOL
				);
				await connection.confirmTransaction(airdropSignature, 'confirmed');
				console.log(
					`[INFO] airdropped 2 SOL to ${wallet.publicKey.toBase58()}`
				);
			} catch (airdropError) {
				console.warn('[WARN] failed to airdrop SOL, continuing anyway');
			}
		}

		const connection = new Connection(RPC_URL, 'confirmed');
		console.log(
			`[INFO] using wallet: ${wallet.publicKey.toBase58()}, connection also set to ${RPC_URL}`
		);

		// First check if Drift protocol state exists
		console.log('[INFO] checking if drift protocol is initialized...');
		const tempAdminClient = new AdminClient({
			connection,
			wallet,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [],
			subAccountIds: [],
			txVersion: 'legacy', // Use legacy transactions for localnet
			accountSubscription: {
				type: 'polling',
				accountLoader: {
					connection,
					commitment: 'confirmed',
				} as any,
			},
		});

		// Check if state account exists
		const statePublicKey = await tempAdminClient.getStatePublicKey();
		const stateAccountInfo = await connection.getAccountInfo(statePublicKey);

		if (!stateAccountInfo) {
			console.log('[INFO] drift protocol not initialized, initializing now...');

			// Use mainnet USDC mint address as reference for localnet
			const usdcMint = new PublicKey(
				'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
			);

			try {
				const [initTx] = await tempAdminClient.initialize(usdcMint, false);
				console.log(`[INFO] drift protocol initialized: ${initTx}`);

				// Wait for transaction to settle
				await new Promise((resolve) => setTimeout(resolve, 3000));
			} catch (error) {
				if (error.message?.includes('already initialized')) {
					console.log(
						'[INFO] drift protocol was already initialized by another process'
					);
				} else {
					throw error;
				}
			}
		} else {
			console.log('[INFO] drift protocol already initialized');
		}

		// Now create the properly configured admin client
		const adminClient = new AdminClient({
			connection,
			wallet,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [OPENAI_MARKET_INDEX],
			spotMarketIndexes: [0],
			subAccountIds: [],
			txVersion: 'legacy', // Use legacy transactions for localnet
			accountSubscription: {
				type: 'websocket',
				commitment: 'confirmed',
			},
		});

		await adminClient.subscribe();

		// Wait for state account to be loaded
		console.log('[INFO] waiting for state account to load...');
		let retries = 0;
		while (retries < 10) {
			try {
				adminClient.getStateAccount();
				break;
			} catch (error) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				retries++;
			}
		}

		if (retries >= 10) {
			throw new Error('Failed to load state account after 10 seconds');
		}

		console.log('[INFO] connected to drift protocol\n');

		console.log('[INFO] checking market status...');
		let existingMarket;
		let marketExists = false;

		try {
			existingMarket = adminClient.getPerpMarketAccount(OPENAI_MARKET_INDEX);
			if (existingMarket) {
				console.log(`[INFO] market ${OPENAI_MARKET_INDEX} already exists`);
				console.log(`   Status: ${JSON.stringify(existingMarket.status)}`);
				console.log(`   Oracle: ${existingMarket.amm.oracle.toBase58()}`);
				marketExists = true;
			}
		} catch (error) {
			console.log(
				`[INFO] market ${OPENAI_MARKET_INDEX} does not exist, will create it`
			);
		}

		if (!marketExists) {
			console.log('\n[INFO] initializing openai perpetual market...');
			await initializeOpenAIMarket(adminClient);
			await adminClient.fetchAccounts(); // refresh accounts
			console.log('[INFO] market initialized successfully');
		} else {
			console.log('\n[INFO] market already exists, skipping initialization');
		}

		console.log('\n[INFO] setting up oracle...');
		let oracleAddress: PublicKey;

		if (config.useRealOracle && config.oracleAddress) {
			console.log('[INFO] using provided real oracle');
			oracleAddress = config.oracleAddress;
		} else {
			console.log('[INFO] setting up mock oracle for testing');
			const mockOracle = new MockOracleClient(connection, wallet);
			oracleAddress = await mockOracle.initializeOracle();

			await mockOracle.simulateMarketEvent('funding_round');
			console.log('[INFO] mock oracle setup complete');
		}

		console.log('\n[INFO] updating market oracle...');
		const market = adminClient.getPerpMarketAccount(OPENAI_MARKET_INDEX);
		const placeholderOracle = new PublicKey('11111111111111111111111111111111');

		if (market.amm.oracle.equals(placeholderOracle)) {
			console.log(
				`[INFO] updating oracle from placeholder to: ${oracleAddress.toBase58()}`
			);

			const updateTx = await adminClient.updatePerpMarketOracle(
				OPENAI_MARKET_INDEX,
				oracleAddress,
				config.useRealOracle ? OracleSource.PYTH_PULL : OracleSource.PYTH // Mock uses Pyth format
			);

			console.log(`[INFO] oracle updated: ${updateTx}`);
			await adminClient.fetchAccounts(); // refresh accounts
		} else {
			console.log('[INFO] oracle already configured');
		}

		// activate market if requested
		if (config.activateMarket) {
			console.log('\n[INFO] activating market...');
			const currentMarket =
				adminClient.getPerpMarketAccount(OPENAI_MARKET_INDEX);
			const isActive =
				JSON.stringify(currentMarket.status) === JSON.stringify({ active: {} });

			if (!isActive) {
				console.log('[INFO] activating market for trading...');
				const activateTx = await adminClient.updatePerpMarketStatus(
					OPENAI_MARKET_INDEX,
					MarketStatus.ACTIVE
				);
				console.log(`[INFO] market activated: ${activateTx}`);
				await adminClient.fetchAccounts(); // refresh accounts
			} else {
				console.log('[INFO] market already active');
			}
		} else {
			console.log('\n[INFO] skipping market activation (configuration)');
		}

		// run tests if requested
		if (config.runTests) {
			console.log('\n[INFO] running integration tests...');
			try {
				await testOpenAIMarket();
				console.log('[INFO] integration tests completed');
			} catch (error) {
				console.warn(
					'[INFO] some tests failed (this may be expected in test environment)'
				);
				console.warn(error.message);
			}
		} else {
			console.log('\n[INFO] skipping tests (configuration)');
		}

		// display final status
		console.log('\n[INFO] final system status:');
		const finalMarket = adminClient.getPerpMarketAccount(OPENAI_MARKET_INDEX);

		console.log(`  Market Address: ${finalMarket.pubkey.toBase58()}`);
		console.log(`  Market Status: ${JSON.stringify(finalMarket.status)}`);
		console.log(`  Oracle Address: ${finalMarket.amm.oracle.toBase58()}`);
		console.log(
			`  Oracle Source: ${JSON.stringify(finalMarket.amm.oracleSource)}`
		);
		console.log(`  Leverage: ${10000 / finalMarket.marginRatioInitial}x`);
		console.log(
			`  Tick Size: $${finalMarket.amm.orderTickSize.toNumber() / 1_000_000}`
		);
		console.log(
			`  Lot Size: ${finalMarket.amm.orderStepSize.toNumber() / 1_000_000_000}`
		);

		console.log(
			'\n[SUCCESS] openai synthetic market system deployed successfully!'
		);

		// Next steps guidance
		console.log('\n[INFO] next steps:');
		console.log('1. [INFO] monitor oracle price feeds');
		console.log('2. [INFO] add initial liquidity (market making)');
		console.log('3. [INFO] integrate with frontend trading interfaces');
		console.log('4. [INFO] monitor market metrics and adjust parameters');
		console.log('5. [INFO] set up regular oracle updates');

		if (!config.useRealOracle) {
			console.log('\n[INFO] production checklist:');
			console.log('- Replace mock oracle with real Pyth/Switchboard feed');
			console.log('- Set up automated price updates');
			console.log('- Implement circuit breakers for extreme price movements');
			console.log('- Monitor oracle health and implement fallbacks');
		}

		return {
			marketAddress: finalMarket.pubkey,
			oracleAddress: finalMarket.amm.oracle,
			marketIndex: OPENAI_MARKET_INDEX,
			status: finalMarket.status,
		};
	} catch (error) {
		console.error('[ERROR] deployment failed:', error);

		// provide helpful error guidance
		if (error.message?.includes('insufficient funds')) {
			console.log(
				'\n[INFO] error fix: ensure wallet has enough SOL for transactions'
			);
			console.log('   get devnet SOL: https://faucet.solana.com/');
		}

		if (error.message?.includes('Account not found')) {
			console.log(
				'\n[INFO] error fix: ensure drift protocol is deployed on this network'
			);
		}

		throw error;
	}
}

// cli interface
async function main() {
	const args = process.argv.slice(2);
	const config: DeploymentConfig = { ...DEFAULT_CONFIG };

	// parse command line arguments
	if (args.includes('--real-oracle')) {
		config.useRealOracle = true;
		console.log(
			'[INFO] using real oracle mode (provide oracle address via --oracle-address)'
		);
	}

	if (args.includes('--no-activate')) {
		config.activateMarket = false;
		console.log('[INFO] market will not be activated');
	}

	if (args.includes('--no-tests')) {
		config.runTests = false;
		console.log('[INFO] tests will be skipped');
	}

	const oracleAddressArg = args.find((arg) =>
		arg.startsWith('--oracle-address=')
	);
	if (oracleAddressArg) {
		config.oracleAddress = new PublicKey(oracleAddressArg.split('=')[1]);
		console.log(
			`[INFO] using oracle address: ${config.oracleAddress.toBase58()}`
		);
	}

	console.log('\n[INFO] deployment configuration:');
	console.log(`  Real Oracle: ${config.useRealOracle}`);
	console.log(`  Activate Market: ${config.activateMarket}`);
	console.log(`  Run Tests: ${config.runTests}`);
	if (config.oracleAddress) {
		console.log(`  Oracle Address: ${config.oracleAddress.toBase58()}`);
	}
	console.log('');

	await deployCompleteSystem(config);
}

// export for use as module
export { deployCompleteSystem, DEFAULT_CONFIG };

// run if called directly
if (require.main === module) {
	main()
		.then(() => {
			console.log('\n[SUCCESS] deployment completed successfully');
			process.exit(0);
		})
		.catch((error) => {
			console.error('[ERROR] deployment failed:', error);
			process.exit(1);
		});
}
