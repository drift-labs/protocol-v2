import { DriftClient } from '../src/driftClient';
import { grpcDriftClientAccountSubscriberV2 } from '../src/accounts/grpcDriftClientAccountSubscriberV2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DriftClientConfig } from '../src/driftClientConfig';
import { decodeName, DRIFT_PROGRAM_ID, Wallet } from '../src';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import dotenv from 'dotenv';

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
const TOKEN = process.env.TOKEN;

async function initializeGrpcDriftClientV2() {
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    const wallet = new Wallet(new Keypair());
    dotenv.config({ path: '../' });
    const config: DriftClientConfig = {
        connection,
        wallet,
        programID: new PublicKey(DRIFT_PROGRAM_ID),
        accountSubscription: {
            type: 'grpc',
            grpcConfigs: {
                endpoint: GRPC_ENDPOINT,
                token: TOKEN,
                commitmentLevel: 'confirmed' as unknown as CommitmentLevel,
                channelOptions: {
                    'grpc.keepalive_time_ms': 10_000,
                    'grpc.keepalive_timeout_ms': 1_000,
                    'grpc.keepalive_permit_without_calls': 1,
                },
            },
            driftClientAccountSubscriber: grpcDriftClientAccountSubscriberV2,
        },
        perpMarketIndexes: [0, 1, 2], // Example market indexes
        spotMarketIndexes: [0, 1, 2], // Example market indexes
        oracleInfos: [], // Add oracle information if needed
    };

    const driftClient = new DriftClient(config);

    let perpMarketUpdateCount = 0;
    let spotMarketUpdateCount = 0;
    let oraclePriceUpdateCount = 0;
    let userAccountUpdateCount = 0;

    const updatePromise = new Promise<void>((resolve) => {
        driftClient.accountSubscriber.eventEmitter.on('perpMarketAccountUpdate', (data) => {
            console.log('Perp market account update:', decodeName(data.name));
            perpMarketUpdateCount++;
            if (perpMarketUpdateCount >= 10 && spotMarketUpdateCount >= 10 && oraclePriceUpdateCount >= 10 && userAccountUpdateCount >= 2) {
                resolve();
            }
        });

        driftClient.accountSubscriber.eventEmitter.on('spotMarketAccountUpdate', (data) => {
            console.log('Spot market account update:', decodeName(data.name));
            spotMarketUpdateCount++;
            if (perpMarketUpdateCount >= 10 && spotMarketUpdateCount >= 10 && oraclePriceUpdateCount >= 10 && userAccountUpdateCount >= 2) {
                resolve();
            }
        });

        driftClient.accountSubscriber.eventEmitter.on('oraclePriceUpdate', (data) => {
            console.log('Oracle price update:', data.toBase58());
            oraclePriceUpdateCount++;
            if (perpMarketUpdateCount >= 10 && spotMarketUpdateCount >= 10 && oraclePriceUpdateCount >= 10 && userAccountUpdateCount >= 2) {
                resolve();
            }
        });

        driftClient.accountSubscriber.eventEmitter.on('userAccountUpdate', (data) => {
            console.log('User account update:', decodeName(data.name));
            userAccountUpdateCount++;
            if (perpMarketUpdateCount >= 10 && spotMarketUpdateCount >= 10 && oraclePriceUpdateCount >= 10 && userAccountUpdateCount >= 2) {
                resolve();
            }
        });
    });

    await driftClient.subscribe();
    console.log('DriftClient initialized and listening for updates.');

    await updatePromise;
    console.log('Received required number of updates.');
}

initializeGrpcDriftClientV2().catch(console.error);
