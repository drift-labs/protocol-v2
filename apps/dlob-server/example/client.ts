import fetch from 'node-fetch';
import {
	BulkAccountLoader,
	calculateAskPrice,
	calculateBidPrice,
	convertToNumber,
	DLOB,
	DLOBOrders,
	DLOBOrdersCoder,
	VelocityClient,
	EventSubscriber,
	getVariant,
	initialize,
	MarketType,
	OrderActionRecord,
	OrderRecord,
	PRICE_PRECISION,
	Wallet,
	WrappedEvent,
} from '@velocity-exchange/sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

/********** SET THESE **********/

const dlobServerURL = 'http://localhost:6969/orders/idl';
// const dlobServerURL = "https://dlob.velocity.exchange/orders/idl";
// const velocityEnv = "mainnet-beta";

// const dlobServerURL = "https://dlob.master.velocity.exchange/orders/idl";
const rpcEndpoint = 'https://api.devnet.solana.com';
const velocityEnv = 'devnet';

const initializedKey = [1, 2, 3, 4, 5]; // private key to initialize velocityClient

/*******************************/

//@ts-ignore
const sdkConfig = initialize({ env: velocityEnv });

const stateCommitment = 'confirmed';
const keypair = Keypair.fromSecretKey(Uint8Array.from(initializedKey));
const wallet = new Wallet(keypair);
const connection = new Connection(rpcEndpoint, stateCommitment);
const velocityClientPublicKey = new PublicKey(sdkConfig.VELOCITY_PROGRAM_ID);

/********** initializing velocityClient as usual **********/
const bulkAccountLoader = new BulkAccountLoader(
	connection,
	stateCommitment,
	1000
);
const velocityClient = new VelocityClient({
	connection,
	wallet,
	programID: velocityClientPublicKey,
	accountSubscription: {
		type: 'polling',
		accountLoader: bulkAccountLoader,
	},
	env: velocityEnv,
	userStats: true,
});
const eventSubscriber = new EventSubscriber(
	connection,
	velocityClient.program,
	{
		maxTx: 8192,
		maxEventsPerType: 8192,
		orderBy: 'blockchain',
		orderDir: 'desc',
		commitment: stateCommitment,
		logProviderConfig: {
			type: 'polling',
			frequency: 1000,
			// type: 'websocket',
		},
	}
);

let maxDlobSlot = 0;
const dlob = new DLOB();

velocityClient.subscribe().then((success) => {
	if (!success) {
		throw new Error('VelocityClient subscription failed');
	}
	eventSubscriber.subscribe().then((success) => {
		if (!success) {
			throw new Error('EventSubscriber subscription failed');
		}

		/********** Example for updating dlob on events **********/

		eventSubscriber.eventEmitter.on(
			'newEvent',
			async (event: WrappedEvent<any>) => {
				// NOTE: only apply events if they're newer than the last
				// only apply new events if they're newer than the last slot we've seen
				if (event.eventType === 'OrderRecord') {
					const record = event as OrderRecord;
					if (maxDlobSlot > 0 && event.slot > maxDlobSlot) {
						dlob.handleOrderRecord(record);
						console.log(
							`Handled OrderRecord event for market ${record.order.marketIndex}`
						);
						printDlob(record.order.marketIndex, dlob);
					}
				} else if (event.eventType === 'OrderActionRecord') {
					const record = event as OrderActionRecord;
					if (maxDlobSlot > 0 && event.slot > maxDlobSlot) {
						dlob.handleOrderActionRecord(record);
						console.log(
							`Handled OrderActionRecord event for market ${
								record.marketIndex
							}, action: ${getVariant(record.action)} ${getVariant(
								record.actionExplanation
							)}`
						);
						printDlob(record.marketIndex, dlob);
					}
				}
			}
		);

		doDlobDemo();
	});
});

/********** Example for initializing dlob **********/

function getLatestSlotFromOrders(dlobOrders: DLOBOrders): number {
	return Math.max(
		...dlobOrders.map((dlobOrder) => dlobOrder.order.slot.toNumber())
	);
}

function printDlob(marketIndex: number, dlob: DLOB) {
	const currSlot = bulkAccountLoader.mostRecentSlot;
	const marketAccount = velocityClient.getPerpMarketAccount(marketIndex);
	const oracle = velocityClient.getOracleDataForPerpMarket(marketIndex);

	// you can also set vBid and vAsk to undefined to omit the vAMM price node from bids and asks
	const vBid = calculateBidPrice(marketAccount!, oracle);
	const vAsk = calculateAskPrice(marketAccount!, oracle);

	const dlobBids = dlob.getBids(
		marketIndex,
		vBid,
		currSlot,
		MarketType.PERP,
		oracle
	);
	const dlobAsks = dlob.getAsks(
		marketIndex,
		vAsk,
		currSlot,
		MarketType.PERP,
		oracle
	);

	console.log(`DLOB for market ${marketIndex}:`);
	console.log('Asks');
	const dlobAsksArray = Array(...dlobAsks).reverse();
	let countAsks = dlobAsksArray.length;
	for (const ask of dlobAsksArray) {
		const isVamm = ask.isVammNode();
		console.log(
			` [${countAsks}] ${
				isVamm ? 'vAMMNode' : getVariant(ask.order?.orderType)
			} ${convertToNumber(ask.getPrice(oracle, currSlot), PRICE_PRECISION)}`
		);
		countAsks--;
	}

	console.log('Bids');
	let countBids = 0;
	for (const bid of dlobBids) {
		const isVamm = bid.isVammNode();
		console.log(
			` [${countBids}] ${
				isVamm ? 'vAMMNode' : getVariant(bid.order?.orderType)
			} ${convertToNumber(bid.getPrice(oracle, currSlot), PRICE_PRECISION)}`
		);
		countBids++;
	}

	console.log('');
}

function doDlobDemo() {
	const dlobCoder = DLOBOrdersCoder.create();
	fetch(dlobServerURL).then((r) => {
		r.arrayBuffer().then((b) => {
			const dlobOrders = dlobCoder.decode(Buffer.from(b));
			// console.log(JSON.stringify(dlobOrders, null, 2));

			console.log(`dlob orders count: ${dlobOrders.length}`);
			dlob.initFromOrders(dlobOrders);

			maxDlobSlot = getLatestSlotFromOrders(dlobOrders);
			console.log(`maxSlot from DLOB init orders: ${maxDlobSlot}`);

			console.log('Initialized DLOb from server');
			printDlob(0, dlob);
			printDlob(1, dlob);
			printDlob(2, dlob);
		});
	});
}
