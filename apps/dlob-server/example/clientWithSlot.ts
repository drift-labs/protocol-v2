/**
 * Usage:
 * ts-node clientWithSlot.ts
 */

import fetch from "node-fetch";
import {
    BulkAccountLoader,
    calculateAskPrice,
    calculateBidPrice,
    convertToNumber,
    DLOB,
    DLOBOrders,
    DLOBOrdersCoder,
    DriftClient,
    DriftClientSubscriptionConfig,
    EventSubscriber,
    getVariant,
    initialize,
    LogProviderConfig,
    MarketType,
    OrderActionRecord,
    OrderRecord,
    PRICE_PRECISION,
    Wallet,
    WrappedEvent,
} from "@velocity-exchange/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

/********** SET THESE **********/

// const dlobServerURL = "http://localhost:6969/orders/idlWithSlot";
const dlobServerURL = "https://dlob.drift.trade/orders/idlWithSlot";
const rpcEndpoint = "https://api.mainnet-beta.solana.com";
const driftEnv = "mainnet-beta";

// const dlobServerURL = "https://master.dlob.drift.trade/orders/idlWithSlot";
// const rpcEndpoint = "https://api.devnet.solana.com";
// const driftEnv = "devnet";

const initializedKey = [1, 2, 3, 4, 5]; // private key to initialize driftClient
const useWebsocket = true;
const levelsToPrint = 10;

/*******************************/

//@ts-ignore
const sdkConfig = initialize({ env: driftEnv });

const stateCommitment = 'confirmed';
const keypair = Keypair.fromSecretKey(Uint8Array.from(initializedKey));
const wallet = new Wallet(keypair);
const connection = new Connection(rpcEndpoint, stateCommitment);
const driftClientPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
let lastSeenSlot = 0;

/********** initializing driftClient as usual **********/
let accountSubscription: DriftClientSubscriptionConfig;
let logProviderConfig: LogProviderConfig;
if (useWebsocket) {
    accountSubscription = {
        type: 'websocket',
    };
    logProviderConfig = {
        type: 'websocket',
    };
} else {
    accountSubscription = {
        type: 'polling',
        accountLoader: new BulkAccountLoader(
            connection,
            stateCommitment,
            10000
        ),
    };
    logProviderConfig = {
        type: 'polling',
        frequency: 10000,
    };
}
const driftClient = new DriftClient({
    connection,
    wallet,
    programID: driftClientPublicKey,
    accountSubscription,
    env: driftEnv,
    userStats: true,
});
const eventSubscriber = new EventSubscriber(connection, driftClient.program, {
    maxTx: 8192,
    maxEventsPerType: 8192,
    orderBy: 'blockchain',
    orderDir: 'desc',
    commitment: stateCommitment,
    logProviderConfig,
});

const maxDlobSlot = 0;
const dlob = new DLOB();

driftClient.subscribe().then((success) => {
    if (!success) {
        throw new Error("DriftClient subscription failed");
    }
    eventSubscriber.subscribe().then((success) => {
        if (!success) {
            throw new Error("EventSubscriber subscription failed");
        }

        /********** Example for updating dlob on events **********/

        eventSubscriber.eventEmitter.on('newEvent', async (event: WrappedEvent<any>) => {
            // NOTE: only apply events if they're newer than the last
            // only apply new events if they're newer than the last slot we've seen
            lastSeenSlot = event.slot;
            if (event.eventType === "OrderRecord") {
                const record = event as OrderRecord;
                if (maxDlobSlot > 0 && event.slot > maxDlobSlot) {
                    dlob.handleOrderRecord(record, event.slot);
                    console.log(`Handled OrderRecord event for market ${record.order.marketIndex}`);
                    printDlob(record.order.marketIndex, dlob);
                }
            } else if (event.eventType === "OrderActionRecord") {
                const record = event as OrderActionRecord;
                if (maxDlobSlot > 0 && event.slot > maxDlobSlot) {
                    dlob.handleOrderActionRecord(record, event.slot);
                    console.log(`Handled OrderActionRecord event for market ${record.marketIndex}, action: ${getVariant(record.action)} ${getVariant(record.actionExplanation)}`);
                    printDlob(record.marketIndex, dlob);
                }
            }
        });

        setInterval(doDlobDemo, 10000);
    });
});


/********** Example for initializing dlob **********/

function _getLatestSlotFromOrders(dlobOrders: DLOBOrders): number {
    return Math.max(...dlobOrders.map((dlobOrder) => dlobOrder.order.slot.toNumber()));
}

function printDlob(marketIndex: number, dlob: DLOB) {
    const currSlot = lastSeenSlot;
    if (lastSeenSlot === 0) {
        console.log('waiting for first slot update...');
        return;
    }
    const marketAccount = driftClient.getPerpMarketAccount(marketIndex);
    const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);

    // you can also set vBid and vAsk to undefined to omit the vAMM price node from bids and asks
    const vBid = calculateBidPrice(marketAccount!, oracle);
    const vAsk = calculateAskPrice(marketAccount!, oracle);

    const dlobBids = dlob.getBids(marketIndex, vBid, lastSeenSlot, MarketType.PERP, oracle);
    const dlobAsks = dlob.getAsks(marketIndex, vAsk, lastSeenSlot, MarketType.PERP, oracle);

    console.log(`DLOB for market ${marketIndex}:`);
    console.log("Asks");
    const dlobAsksArray = Array(...dlobAsks).reverse();
    let countAsks = dlobAsksArray.length;
    for (const ask of dlobAsksArray) {
        const isVamm = ask.isVammNode();
        if (countAsks < levelsToPrint) {
            console.log(` [${countAsks - 1}] ${isVamm ? "vAMMNode" : getVariant(ask.order?.orderType)} ${convertToNumber(ask.getPrice(oracle, currSlot), PRICE_PRECISION)} (oraclePriceOffset: ${ask.order?.oraclePriceOffset || 0 * PRICE_PRECISION})`);
        }
        countAsks--;
    }

    console.log("Bids");
    let countBids = 0;
    for (const bid of dlobBids) {
        const isVamm = bid.isVammNode();
        if (countBids < levelsToPrint) {
            console.log(` [${countBids}] ${isVamm ? "vAMMNode" : getVariant(bid.order?.orderType)} ${convertToNumber(bid.getPrice(oracle, currSlot), PRICE_PRECISION)} (oraclePriceOffset: ${bid.order?.oraclePriceOffset || 0 * PRICE_PRECISION})`);
        }
        countBids++;
    }

    console.log("");
}

function doDlobDemo() {
    const dlobCoder = DLOBOrdersCoder.create();
    fetch(dlobServerURL)
        .then(
            async (r) => {
                console.log(`dlob server response: ${r.status} ${r.statusText}`);
                const resp = await r.json();
                lastSeenSlot = resp['slot'];
                console.log(`Latest dlob slot: ${lastSeenSlot}`);
                const dlobOrdersBuffer = Buffer.from(resp['data'], 'base64');
                const dlobOrders = dlobCoder.decode(Buffer.from(dlobOrdersBuffer));
                console.log(`Total Dlob orders count: ${dlobOrders.length}`);
                dlob.initFromOrders(dlobOrders, lastSeenSlot);

                const marketIndex = 0;
                console.log("Initialized DLOb from server");
                printDlob(marketIndex, dlob);
            });
}