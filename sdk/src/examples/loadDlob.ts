import { AnchorProvider } from '@coral-xyz/anchor';
import { UserMap, Wallet } from '..';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	DriftClient,
	initialize,
	BulkAccountLoader,
	getMarketsAndOraclesForSubscription,
} from '..';

const env = 'mainnet-beta';

const main = async () => {
	// Initialize Drift SDK
	const sdkConfig = initialize({ env });

	// Set up the Wallet and Provider
	const privateKey = process.env.BOT_PRIVATE_KEY; // stored as an array string
	const keypair = Keypair.fromSecretKey(
		Uint8Array.from(JSON.parse(privateKey))
	);
	const wallet = new Wallet(keypair);

	// Set up the Connection
	const rpcAddress = process.env.RPC_ADDRESS; // can use: https://api.devnet.solana.com for devnet; https://api.mainnet-beta.solana.com for mainnet;
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

	console.log('Loading user map...');
	const userMap = new UserMap({
		driftClient,
		subscriptionConfig: {
			type: 'websocket',
			commitment: 'processed',
		},
		skipInitialLoad: false,
		includeIdle: false,
	});

	// fetches all users and subscribes for updates
	await userMap.subscribe();

	console.log('Loading dlob from user map...');
	const slot = await driftClient.connection.getSlot();
	const dlob = await userMap.getDLOB(slot);

	console.log('number of orders', dlob.getDLOBOrders().length);

	dlob.clear();

	console.log('Unsubscribing users...');
	await userMap.unsubscribe();

	console.log('Unsubscribing drift client...');
	await driftClient.unsubscribe();
};

main();
