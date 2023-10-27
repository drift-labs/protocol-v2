import { AnchorProvider } from '@coral-xyz/anchor';
import { DLOB, UserMap, Wallet } from '..';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	DriftClient,
	initialize,
	BulkAccountLoader,
	getMarketsAndOraclesForSubscription,
	EventSubscriber,
	isVariant,
} from '..';

import { sleep } from '../../../tests/testHelpers';

const env = 'mainnet-beta';

const main = async () => {
	// Initialize Drift SDK
	const sdkConfig = initialize({ env });

	// Set up the Wallet and Provider
	let wallet = new Wallet(Keypair.generate());
	try {
		const privateKey = process.env.BOT_PRIVATE_KEY; // stored as an array string
		const keypair = Keypair.fromSecretKey(
			Uint8Array.from(JSON.parse(privateKey))
		);
		wallet = new Wallet(keypair);
	} catch {
		console.log('cannot load `process.env.BOT_PRIVATE_KEY`');
	}

	// Set up the Connection
	const rpcAddress = process.env.RPC_ADDRESS || `https://api.${env}.solana.com`; // can use: https://api.devnet.solana.com for devnet; https://api.mainnet-beta.solana.com for mainnet;
	const connection = new Connection(rpcAddress);

	// Set up the Provider
	const provider = new AnchorProvider(
		connection,
		// @ts-ignore
		wallet,
		AnchorProvider.defaultOptions()
	);

	// Set up the Drift Clearing House
	const driftPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
	const bulkAccountLoader = new BulkAccountLoader(
		connection,
		'confirmed',
		1000
	);
	const driftClient = new DriftClient({
		connection,
		wallet: provider.wallet,
		programID: driftPublicKey,
		...getMarketsAndOraclesForSubscription(env),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});

	console.log('Subscribing drift client...');
	await driftClient.subscribe();

    // TODO: this doesnt filter all margin/read instances
	// listen to this market account only (mainnet perp marketIndex=0 is SOL-PERP)
	const address = driftClient.getPerpMarketAccount(0).pubkey;

	const eventSubscriber = new EventSubscriber(connection, driftClient.program, {
		address: address,
		commitment: 'recent',
		eventTypes: [
			// Order and Order Action records are handled by polling the history server now
			// 'DepositRecord',
			// 'FundingPaymentRecord',
			// 'LiquidationRecord',
			// 'SettlePnlRecord',
			// 'SwapRecord',
			'OrderActionRecord',
			// 'OrderRecord',
		],
	});
	eventSubscriber.subscribe();

	let lastLength = 0;
	while (1) {
		const eventArray = eventSubscriber.getEventsArray('OrderActionRecord');
		if (eventArray.length != lastLength) {
			for (let i = 0; i < eventArray.length - lastLength; i++) {
				const item = eventArray[i];
				if (isVariant(item.action, 'fill')) {
					console.log(eventArray[i]);
				}
			}
			lastLength = eventArray.length;
		}
		await sleep(1000); // wait 1 second
	}
};

main();
