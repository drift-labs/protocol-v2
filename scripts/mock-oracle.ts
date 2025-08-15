#!/usr/bin/env ts-node

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { BN, Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';

export interface MockOracleAccount {
	price: BN;
	confidence: BN;
	slot: BN;
	timestamp: BN;
	authority: PublicKey;
}

export class MockOracleClient {
	private connection: Connection;
	private wallet: Wallet;
	private provider: AnchorProvider;
	private program: Program;
	private oracleKeypair: Keypair;

	private currentValuation: number = 80_000_000_000;
	private pricePerShare: number = 2000;
	private confidence: number = 0.05;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	constructor(connection: Connection, wallet: Wallet, programId?: PublicKey) {
		this.connection = connection;
		this.wallet = wallet;
		this.provider = new AnchorProvider(connection, wallet, {
			commitment: 'confirmed',
		});
		this.oracleKeypair = Keypair.generate();
		anchor.setProvider(this.provider);
	}

	async initializeOracle(): Promise<PublicKey> {
		console.log('initializing mock oracle for openai');

		try {
			console.log(`initial oracle data:`);
			console.log(`price: $${this.pricePerShare}`);
			console.log(
				`valuation: $${(this.currentValuation / 1_000_000_000).toFixed(1)}b`
			);
			console.log(`confidence: ±${(this.confidence * 100).toFixed(1)}%`);
			console.log(`oracle address: ${this.oracleKeypair.publicKey.toBase58()}`);

			return this.oracleKeypair.publicKey;
		} catch (error) {
			console.error('failed to initialize oracle:', error);
			throw error;
		}
	}

	async updatePrice(newPrice: number, confidence?: number): Promise<string> {
		this.pricePerShare = newPrice;
		if (confidence) this.confidence = confidence;

		console.log(
			`oracle price updated: $${newPrice} (±${(this.confidence * 100).toFixed(
				1
			)}%)`
		);

		return 'mock_transaction_signature';
	}

	getOracleData(): MockOracleAccount {
		return this.createOracleData();
	}

	getOraclePublicKey(): PublicKey {
		return this.oracleKeypair.publicKey;
	}

	async simulateMarketEvent(
		event: 'funding_round' | 'product_launch' | 'regulation' | 'competition'
	): Promise<void> {
		console.log(`simulating market event: ${event}`);

		let priceChange = 0;
		let confidenceChange = 0;

		switch (event) {
			case 'funding_round':
				priceChange = 0.15;
				confidenceChange = -0.01;
				console.log('new funding round announced');
				break;

			case 'product_launch':
				priceChange = 0.08;
				confidenceChange = -0.005;
				console.log('new product launched');
				break;

			case 'regulation':
				priceChange = -0.12;
				confidenceChange = 0.02;
				console.log('regulatory concerns arise');
				break;

			case 'competition':
				priceChange = -0.05;
				confidenceChange = 0.01;
				console.log('new competition enters market');
				break;
		}

		const newPrice = this.pricePerShare * (1 + priceChange);
		const newConfidence = Math.max(
			0.01,
			Math.min(0.15, this.confidence + confidenceChange)
		);

		await this.updatePrice(newPrice, newConfidence);

		console.log(`price impact: ${(priceChange * 100).toFixed(1)}%`);
		console.log(
			`new valuation: $${(
				((newPrice / this.pricePerShare) * this.currentValuation) /
				1_000_000_000
			).toFixed(1)}b`
		);
	}

	private createOracleData(): MockOracleAccount {
		const PRICE_PRECISION = new BN(1_000_000);

		return {
			price: new BN(this.pricePerShare).mul(PRICE_PRECISION),
			confidence: new BN(this.pricePerShare * this.confidence).mul(
				PRICE_PRECISION
			),
			slot: new BN(Date.now() / 400),
			timestamp: new BN(Math.floor(Date.now() / 1000)),
			authority: this.wallet.publicKey,
		};
	}
}

export const MARKET_EVENTS = [
	{
		name: 'gpt-5 release',
		type: 'product_launch' as const,
		description: 'openai releases gpt-5 with breakthrough capabilities',
		expectedImpact: '+8% to +15%',
	},
	{
		name: 'series d funding',
		type: 'funding_round' as const,
		description: 'openai raises $10b at $100b valuation',
		expectedImpact: '+15% to +25%',
	},
	{
		name: 'ai regulation',
		type: 'regulation' as const,
		description: 'new ai safety regulations proposed',
		expectedImpact: '-10% to -15%',
	},
	{
		name: 'google competition',
		type: 'competition' as const,
		description: 'google releases competing model',
		expectedImpact: '-3% to -8%',
	},
];

async function demonstrateMockOracle() {
	console.log('mock oracle demonstration');

	const NETWORK_URLS = {
		localnet: 'http://localhost:8899',
		devnet: 'https://api.devnet.solana.com',
		mainnet: 'https://api.mainnet-beta.solana.com',
	};

	const NETWORK =
		(process.env.SOLANA_CLUSTER as keyof typeof NETWORK_URLS) || 'localnet';
	const RPC_URL = NETWORK_URLS[NETWORK];
	console.log(`using ${NETWORK} network: ${RPC_URL}`);

	const connection = new Connection(RPC_URL, 'confirmed');
	const wallet = new Wallet(Keypair.generate());

	const oracle = new MockOracleClient(connection, wallet);

	const oracleAddress = await oracle.initializeOracle();
	console.log(`oracle initialized at: ${oracleAddress.toBase58()}`);

	console.log('simulating market events');

	for (const event of MARKET_EVENTS) {
		console.log(`--- ${event.name} ---`);
		console.log(`${event.description}`);
		console.log(`expected impact: ${event.expectedImpact}`);

		await oracle.simulateMarketEvent(event.type);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	console.log('final oracle state:');
	const finalData = oracle.getOracleData();
	console.log(`price: $${finalData.price.div(new BN(1_000_000)).toString()}`);
	console.log(
		`confidence: ±$${finalData.confidence.div(new BN(1_000_000)).toString()}`
	);
	console.log(
		`last update: ${new Date(
			finalData.timestamp.toNumber() * 1000
		).toISOString()}`
	);

	console.log('integration notes:');
	console.log('1. replace this mock with real pyth or switchboard oracle');
	console.log('2. use oracle address in market initialization');
	console.log('3. ensure oracle updates regularly for accurate pricing');
	console.log('4. monitor oracle health and fallback procedures');
}

if (require.main === module) {
	demonstrateMockOracle()
		.then(() => {
			console.log('mock oracle demonstration completed');
			process.exit(0);
		})
		.catch((error) => {
			console.error('demonstration failed:', error);
			process.exit(1);
		});
}
