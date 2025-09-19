import { Connection, Keypair } from '@solana/web3.js';
import {
    BASE_PRECISION,
    BN,
    DriftClient,
    getMarketOrderParams,
    getUserAccountPublicKey,
    MarketType,
    OrderParams,
    OrderType,
    PositionDirection,
    PostOnlyParams,
    PRICE_PRECISION,
    Wallet
} from '../src';
import { nanoid } from 'nanoid';

function hexDump(buf: Buffer) {
    for (let i = 0; i < buf.length; i += 16) {
        const chunk = buf.slice(i, i + 16);
        const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(chunk).map(b => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
        console.log(i.toString(16).padStart(8, '0'), hex.padEnd(16 * 3 - 1, ' '), ascii);
    }
}

const with_delegate = async (driftClient: DriftClient) => {
    const signedMsgOrderParams = getMarketOrderParams({
        marketIndex: 0,
        direction: PositionDirection.SHORT,
        baseAssetAmount: BASE_PRECISION,
        price: new BN(237).mul(PRICE_PRECISION),
        auctionStartPrice: new BN(240).mul(PRICE_PRECISION),
        auctionEndPrice: new BN(238).mul(PRICE_PRECISION),
        auctionDuration: 10,
        userOrderId: 2,
        postOnly: PostOnlyParams.NONE,
        marketType: MarketType.PERP,
    }) as OrderParams;

    // const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
    const uuid = Uint8Array.from([
        67,  82, 79, 51,
        105, 114, 71, 49
    ]);
    const orderParamsMessage = {
        signedMsgOrderParams,
        takerPubkey: await getUserAccountPublicKey(driftClient.program.programId, driftClient.wallet.publicKey, 0),
        slot: new BN(2345),
        uuid,
        takeProfitOrderParams:  {
            triggerPrice: new BN(230).mul(PRICE_PRECISION),
            baseAssetAmount: BASE_PRECISION
        },
        stopLossOrderParams: {
            triggerPrice: new BN(250).mul(PRICE_PRECISION),
            baseAssetAmount: BASE_PRECISION
        },
    };
    const signedMsgOrderParamsMessage = driftClient.signSignedMsgOrderParamsMessage(
        orderParamsMessage,
        true);
    const asciiHex = signedMsgOrderParamsMessage.orderParams; // Buffer of ASCII digits
    const payload = Buffer.from(asciiHex.toString('utf8'), 'hex'); // parse to raw bytes
    console.log('orderParamsMessage', orderParamsMessage);
    console.log('payload len:', payload.length);
    // console.log('payload:', payload.toString('hex'));
    console.log('numbers array:', JSON.stringify(Array.from(payload)));
    hexDump(payload);
};

const generate_payload = async (driftClient: DriftClient, delegate: boolean, tpsl: boolean) => {
    console.log('delegate:', delegate, 'tpsl:', tpsl);
    const base = 3.456 * BASE_PRECISION.toNumber();
    const signedMsgOrderParams = getMarketOrderParams({
        marketIndex: 0,
        direction: PositionDirection.LONG,
        baseAssetAmount: new BN(base),
        price: new BN(237).mul(PRICE_PRECISION),
        auctionStartPrice: new BN(230).mul(PRICE_PRECISION),
        auctionEndPrice: new BN(237).mul(PRICE_PRECISION),
        auctionDuration: 10,
        userOrderId: 3,
        postOnly: PostOnlyParams.NONE,
        marketType: MarketType.PERP,
    }) as OrderParams;

    // const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
    const uuid = Uint8Array.from([
        67,  82, 79, 51,
        105, 114, 71, 49
    ]);
    const orderParamsMessage = {
        signedMsgOrderParams,
        takerPubkey: delegate ? await getUserAccountPublicKey(driftClient.program.programId, driftClient.wallet.publicKey, 0) : undefined,
        subAccountId: delegate ? undefined : 2,
        slot: new BN(2345),
        uuid,
        takeProfitOrderParams:  tpsl ? {
            triggerPrice: new BN(240).mul(PRICE_PRECISION),
            baseAssetAmount: new BN(base),
        } : null,
        stopLossOrderParams: tpsl ? {
            triggerPrice: new BN(225).mul(PRICE_PRECISION),
            baseAssetAmount: new BN(base),
        } : null,
    };

    const signedMsgOrderParamsMessage = driftClient.signSignedMsgOrderParamsMessage(
        orderParamsMessage,
        delegate);

    const asciiHex = signedMsgOrderParamsMessage.orderParams; // Buffer of ASCII digits
    const payload = Buffer.from(asciiHex.toString('utf8'), 'hex'); // parse to raw bytes
    console.log('orderParamsMessage', orderParamsMessage);
    console.log('payload len:', payload.length);
    // console.log('payload:', payload.toString('hex'));
    console.log('numbers array:', JSON.stringify(Array.from(payload)));
    hexDump(payload);
};

const main = async () => {
    const connection = new Connection('https://rpc.helius.xyz/?api-key=91020679-6d19-4e39-a1db-e61df95c729f');
    const driftClient = new DriftClient({
        connection,
        wallet: new Wallet(Keypair.generate())
    });

    await generate_payload(driftClient, false, true);
};

main();