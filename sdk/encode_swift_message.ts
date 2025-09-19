import { BASE_PRECISION, BN, getMarketOrderParams, getOrderParams, MarketType, PositionDirection } from '@drift-labs/sdk';
import {
    DriftClient,
    Wallet,
    SignedMsgOrderParams,
    SignedMsgOrderParamsDelegateMessage,
    OrderParams,
    // SignedMsgExtensions,
} from './src/';
import {
    Connection,
    Keypair,
    PublicKey,
} from '@solana/web3.js';
import { nanoid } from 'nanoid';

async function main() {
    const keypair = Keypair.generate();
    console.log(keypair.publicKey.toString());
    const driftClient = new DriftClient({
        wallet: new Wallet(keypair),
        connection: new Connection('https://api.mainnet-beta.solana.com'),
    });
    const slot = new BN(2345);

    // test_deserialize_into_verified_message_delegate_with_max_margin_ratio
    // const e0 = driftClient.encodeSignedMsgOrderParamsMessage(
    //     {
    //         signedMsgOrderParams: getOrderParams(getMarketOrderParams(
    //             {
    //                 marketIndex: 0,
    //                 userOrderId: 2,
    //                 price: new BN("237000000"),
    //                 marketType: MarketType.PERP,
    //                 baseAssetAmount: new BN("1000000000"),
    //                 direction: PositionDirection.SHORT,
    //                 reduceOnly: false,
    //                 auctionDuration: 10,
    //                 auctionStartPrice: new BN("240000000"),
    //                 auctionEndPrice: new BN("238000000"),
    //             }
    //         )),
    //         takerPubkey: new PublicKey('HG2iQKnRkkasrLptwMZewV6wT7KPstw9wkA8yyu8Nx3m'),
    //         slot,
    //         uuid: Buffer.from([67, 82, 79, 51, 105, 114, 71, 49]),
    //         takeProfitOrderParams: {
    //             baseAssetAmount: new BN("1000000000"),
    //             triggerPrice: new BN("230000000"),
    //         },
    //         stopLossOrderParams: {
    //             baseAssetAmount: new BN("1000000000"),
    //             triggerPrice: new BN("250000000"),
    //         },
    //         ext: SignedMsgExtensions.V1({ maxMarginRatio: 1 }),
    //     },
    //     true,
    // )
    // console.log(JSON.stringify(Array.from(e0)));

    // test_deserialize_into_verified_message_non_delegate_with_max_margin_ratio
    const delegateSigner = false;
    const e0 = driftClient.encodeSignedMsgOrderParamsMessage(
        {
            signedMsgOrderParams: getOrderParams(getMarketOrderParams(
                {
                    marketIndex: 0,
                    userOrderId: 3,
                    price: new BN("237000000"),
                    marketType: MarketType.PERP,
                    baseAssetAmount: new BN("3456000000"),
                    direction: PositionDirection.LONG,
                    reduceOnly: false,
                    auctionDuration: 10,
                    auctionStartPrice: new BN("230000000"),
                    auctionEndPrice: new BN("237000000"),
                }
            )),
            subAccountId: 2,
            slot,
            uuid: Buffer.from([67, 82, 79, 51, 105, 114, 71, 49]),
            takeProfitOrderParams: {
                baseAssetAmount: new BN("3456000000"),
                triggerPrice: new BN("240000000"),
            },
            stopLossOrderParams: {
                baseAssetAmount: new BN("3456000000"),
                triggerPrice: new BN("225000000"),
            },
            // ext: SignedMsgExtensions.V0,
            // ext: SignedMsgExtensions.V1({ maxMarginRatio: 65535 }),
            // ext: SignedMsgExtensions.V2({ maxMarginRatio: 65535, newField: 1, newField2: 2 }),
        },
        delegateSigner,
    );
    // console.log('encoded: ', JSON.stringify(Array.from(e0)));

    // const messageToDecode = e0;

     // v0 message
     // const messageToDecode = Buffer.from([200,213,166,94,34,52,245,93,0,1,0,3,0,96,254,205,0,0,0,0,64,85,32,14,0,0,0,0,0,0,0,0,0,0,0,0,0,1,10,1,128,133,181,13,0,0,0,0,1,64,85,32,14,0,0,0,0,2,0,41,9,0,0,0,0,0,0,67,82,79,51,105,114,71,49,1,0,28,78,14,0,0,0,0,0,96,254,205,0,0,0,0,1,64,58,105,13,0,0,0,0,0,96,254,205,0,0,0,0,0]);

    // the v1 message
    // const messageToDecode = Buffer.from([200,213,166,94,34,52,245,93,0,1,0,3,0,96,254,205,0,0,0,0,64,85,32,14,0,0,0,0,0,0,0,0,0,0,0,0,0,1,10,1,128,133,181,13,0,0,0,0,1,64,85,32,14,0,0,0,0,2,0,41,9,0,0,0,0,0,0,67,82,79,51,105,114,71,49,1,0,28,78,14,0,0,0,0,0,96,254,205,0,0,0,0,1,64,58,105,13,0,0,0,0,0,96,254,205,0,0,0,0,1,1,255,255]);

    // the v2 message
    const messageToDecode = Buffer.from([200,213,166,94,34,52,245,93,0,1,0,3,0,96,254,205,0,0,0,0,64,85,32,14,0,0,0,0,0,0,0,0,0,0,0,0,0,1,10,1,128,133,181,13,0,0,0,0,1,64,85,32,14,0,0,0,0,2,0,41,9,0,0,0,0,0,0,67,82,79,51,105,114,71,49,1,0,28,78,14,0,0,0,0,0,96,254,205,0,0,0,0,1,64,58,105,13,0,0,0,0,0,96,254,205,0,0,0,0,2,1,255,255,1,1,0,1,2,0]);

    console.log('decoding:', JSON.stringify(Array.from((messageToDecode))));
    const d0 = driftClient.decodeSignedMsgOrderParamsMessage(messageToDecode, delegateSigner)
    console.log(d0)
}

main();
