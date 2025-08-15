#!/usr/bin/env ts-node

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { BN, Wallet } from '@coral-xyz/anchor';
import {
	ContractTier,
	OracleSource,
	BASE_PRECISION,
	ONE,
	PEG_PRECISION,
	PRICE_PRECISION,
	ZERO,
	encodeName,
	AdminClient,
} from '../sdk/src';

// Configuration
const NETWORK_URLS = {
	localnet: 'http://localhost:8899',
	devnet: 'https://api.devnet.solana.com',
	mainnet: 'https://api.mainnet-beta.solana.com',
};

const NETWORK =
	(process.env.SOLANA_CLUSTER as keyof typeof NETWORK_URLS) || 'localnet';
const RPC_URL = NETWORK_URLS[NETWORK];
const MARKET_INDEX = NETWORK === 'mainnet' ? 76 : 29;
const MARKET_NAME = 'OPENAI-PERP';

const MARKET_PARAMS = {
	oracle: new PublicKey('11111111111111111111111111111111'),
	oracleSource: OracleSource.PYTH_PULL,

	baseAssetReserve: new BN(100_000).mul(BASE_PRECISION), // 100k base asset reserve
	quoteAssetReserve: new BN(100_000_000).mul(PRICE_PRECISION), // 100M quote asset reserve ($100M)
	periodicity: new BN(60 * 60), // 1 hour funding period
	pegMultiplier: PEG_PRECISION, // 1.0 peg multiplier

	// risk parameters for 10x leverage
	marginRatioInitial: 1000, // 10% initial margin (10x leverage) - in basis points (10000 = 100%)
	marginRatioMaintenance: 500, // 5% maintenance margin
	liquidatorFee: 500, // 0.5% liquidator fee
	ifLiquidationFee: 500, // 0.5% insurance fund liquidation fee
	imfFactor: 0, // Initial margin fraction factor

	contractTier: ContractTier.SPECULATIVE,
	activeStatus: false,
	baseSpread: 500, // 0.05% base spread
	maxSpread: 5000, // 0.5% max spread
	maxOpenInterest: ZERO, // No limit initially
	maxRevenueWithdrawPerPeriod: ZERO,
	quoteMaxInsurance: ZERO,

	// Order parameters matching requirements
	orderStepSize: BASE_PRECISION, // Lot size = 1 (minimum order size)
	orderTickSize: PRICE_PRECISION.divn(100), // Tick size = 0.01 (1 cent)
	minOrderSize: BASE_PRECISION, // Minimum order = 1 unit

	// AMM parameters
	concentrationCoefScale: ONE,
	curveUpdateIntensity: 0,
	ammJitIntensity: 0,

	// Market name
	name: Array.from(encodeName(MARKET_NAME)),
};

async function initializeOpenAIMarket(providedAdminClient?: AdminClient) {
	try {
		let adminClient: AdminClient;

		if (providedAdminClient) {
			console.log('[INFO] using provided admin client');
			adminClient = providedAdminClient;
		} else {
			let wallet: Wallet;
			if (process.env.ANCHOR_WALLET) {
				const keypairData = JSON.parse(
					require('fs').readFileSync(process.env.ANCHOR_WALLET, 'utf8')
				);
				const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
				wallet = new Wallet(keypair);
			} else {
				console.warn(
					'[WARN] no ANCHOR_WALLET found, creating a temporary keypair for testing'
				);
				wallet = new Wallet(Keypair.generate());
			}

			console.log(`[INFO] using wallet: ${wallet.publicKey.toBase58()}`);

			const connection = new Connection(RPC_URL, 'confirmed');
			adminClient = new AdminClient({
				connection,
				wallet,
				opts: {
					commitment: 'confirmed',
				},
				activeSubAccountId: 0,
				perpMarketIndexes: [MARKET_INDEX],
				spotMarketIndexes: [0], // USDC spot market
				subAccountIds: [],
				accountSubscription: {
					type: 'websocket',
					commitment: 'confirmed',
				},
			});

			await adminClient.subscribe();
		}

		try {
			const existingMarket = adminClient.getPerpMarketAccount(MARKET_INDEX);
			console.log(`[INFO] market ${MARKET_INDEX} already exists:`, {
				name: existingMarket.name.toString(),
				status: existingMarket.status,
				oracle: existingMarket.amm.oracle.toBase58(),
			});
			return;
		} catch (error) {
			console.log(
				`✅ Market ${MARKET_INDEX} does not exist, proceeding with initialization`
			);
		}

		console.log('[INFO] initializing perpetual market with parameters:');
		console.log(`  Market Index: ${MARKET_INDEX}`);
		console.log(`  Market Name: ${MARKET_NAME}`);
		console.log(
			`  Leverage: 10x (Initial Margin: ${
				MARKET_PARAMS.marginRatioInitial / 100
			}%)`
		);
		console.log(
			`  Tick Size: $${
				MARKET_PARAMS.orderTickSize.toNumber() / PRICE_PRECISION.toNumber()
			}`
		);
		console.log(
			`  Lot Size: ${
				MARKET_PARAMS.orderStepSize.toNumber() / BASE_PRECISION.toNumber()
			}`
		);
		console.log(
			`  Oracle Source: ${JSON.stringify(MARKET_PARAMS.oracleSource)}`
		);
		console.log(
			`  Contract Tier: ${JSON.stringify(MARKET_PARAMS.contractTier)}`
		);

		const txSig = await adminClient.initializePerpMarket(
			MARKET_INDEX,
			MARKET_PARAMS.oracle,
			MARKET_PARAMS.baseAssetReserve,
			MARKET_PARAMS.quoteAssetReserve,
			MARKET_PARAMS.periodicity,
			MARKET_PARAMS.pegMultiplier,
			MARKET_PARAMS.oracleSource,
			MARKET_PARAMS.contractTier,
			MARKET_PARAMS.marginRatioInitial,
			MARKET_PARAMS.marginRatioMaintenance,
			MARKET_PARAMS.liquidatorFee,
			MARKET_PARAMS.ifLiquidationFee,
			MARKET_PARAMS.imfFactor,
			MARKET_PARAMS.activeStatus,
			MARKET_PARAMS.baseSpread,
			MARKET_PARAMS.maxSpread,
			MARKET_PARAMS.maxOpenInterest,
			MARKET_PARAMS.maxRevenueWithdrawPerPeriod,
			MARKET_PARAMS.quoteMaxInsurance,
			MARKET_PARAMS.orderStepSize,
			MARKET_PARAMS.orderTickSize,
			MARKET_PARAMS.minOrderSize,
			MARKET_PARAMS.concentrationCoefScale,
			MARKET_PARAMS.curveUpdateIntensity,
			MARKET_PARAMS.ammJitIntensity,
			MARKET_PARAMS.name as any
		);

		console.log(`[INFO] market initialized successfully!`);

		const explorerUrl =
			NETWORK === 'mainnet'
				? `https://explorer.solana.com/tx/${txSig}`
				: NETWORK === 'devnet'
				? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
				: `Transaction ID: ${txSig} (localnet - no explorer link)`;
		console.log(`Transaction: ${explorerUrl}`);

		await adminClient.fetchAccounts();
		const market = adminClient.getPerpMarketAccount(MARKET_INDEX);

		console.log('\n[INFO] market details:');
		console.log(`  Public Key: ${market.pubkey.toBase58()}`);
		console.log(`  Status: ${JSON.stringify(market.status)}`);
		console.log(`  Oracle: ${market.amm.oracle.toBase58()}`);
		console.log(`  Oracle Source: ${JSON.stringify(market.amm.oracleSource)}`);
		console.log(
			`  Base Asset Reserve: ${market.amm.baseAssetReserve.toString()}`
		);
		console.log(
			`  Quote Asset Reserve: ${market.amm.quoteAssetReserve.toString()}`
		);
		console.log(
			`  Margin Ratio Initial: ${market.marginRatioInitial} (${
				market.marginRatioInitial / 100
			}%)`
		);
		console.log(
			`  Margin Ratio Maintenance: ${market.marginRatioMaintenance} (${
				market.marginRatioMaintenance / 100
			}%)`
		);
		console.log(`  Tick Size: ${market.amm.orderTickSize.toString()}`);
		console.log(`  Step Size: ${market.amm.orderStepSize.toString()}`);

		console.log('\n[INFO] next steps:');
		console.log('1. Set up a Pyth oracle for OpenAI valuation data');
		console.log(
			'2. Update the market oracle address using updatePerpMarketOracle'
		);
		console.log('3. Activate the market using updatePerpMarketStatus');
		console.log('4. Test with small orders before full deployment');
	} catch (error) {
		console.error('[ERROR] error initializing market:', error);

		if (error.message?.includes('insufficient funds')) {
			console.log(
				'\n[INFO] error fix: make sure your wallet has enough SOL for transaction fees'
			);
		}

		if (error.message?.includes('Market already exists')) {
			console.log(
				'\n[ERROR] error fix: this market index is already taken. try a different market index.'
			);
		}

		process.exit(1);
	}
}

if (require.main === module) {
	initializeOpenAIMarket()
		.then(() => {
			console.log('\n[SUCCESS] script completed successfully');
			process.exit(0);
		})
		.catch((error) => {
			console.error('[ERROR] script failed:', error);
			process.exit(1);
		});
}

export { initializeOpenAIMarket, MARKET_PARAMS };
