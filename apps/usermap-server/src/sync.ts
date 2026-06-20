#!/usr/bin/env ts-node

import { Connection, PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import {
	getConfig,
	getNonIdleUserFilter,
	getUserFilter,
} from '@velocity-exchange/sdk';
import {
	RedisClient,
	RedisClientPrefix,
} from '@velocity-exchange/common/clients';
import { COMMON_UI_UTILS } from '@velocity-exchange/common';
import { logger } from './utils/logger';
import { ZSTDDecoder } from 'zstddec';
import { performance } from 'perf_hooks';

require('dotenv').config();

const USE_ELASTICACHE = process.env.ELASTICACHE === 'true' || false;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

const endpoint = process.env.ENDPOINT;
if (!endpoint) {
	logger.error('ENDPOINT env var required');
	process.exit(1);
}

const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || '90000');
const SYNC_ON_STARTUP = process.env.SYNC_ON_STARTUP === 'true';
const EXPIRY_MULTIPLIER = 4;
const MAX_USER_ACCOUNT_SIZE_BYTES = 4376;
const sdkConfig = getConfig();
const connection = new Connection(endpoint, 'confirmed');

const redisClient = USE_ELASTICACHE
	? new RedisClient({
			prefix: RedisClientPrefix.USER_MAP,
	  })
	: new RedisClient({
			host: REDIS_HOST,
			port: REDIS_PORT,
			cluster: false,
			opts: { password: REDIS_PASSWORD, tls: null },
	  });

let syncLock = false;

const decoder = new ZSTDDecoder();

async function sync(): Promise<void> {
	const start = performance.now();
	try {
		if (syncLock) {
			logger.info('SYNC LOCKED');
			return;
		}

		logger.info('Running Sync');
		syncLock = true;

		const filters = [getUserFilter(), getNonIdleUserFilter()];
		const rpcRequestArgs = [
			new PublicKey(sdkConfig.VELOCITY_PROGRAM_ID),
			{
				commitment: 'confirmed',
				filters,
				encoding: 'base64+zstd',
				withContext: true,
			},
		];

		// @ts-ignore – using private _rpcRequest call to pass custom encoding
		const response = await connection._rpcRequest(
			'getProgramAccounts',
			rpcRequestArgs
		);

		const rpcResponseAndContext: RpcResponseAndContext<
			Array<{ pubkey: PublicKey; account: { data: [string, string] } }>
		> = response.result;

		const context = rpcResponseAndContext.context;
		const programAccountBufferMap = new Map<string, Buffer>();

		const decodingPromises = rpcResponseAndContext.value.map(
			async (programAccount) => {
				const compressedUserData = Buffer.from(
					programAccount.account.data[0],
					'base64'
				);
				const userBuffer = decoder.decode(
					compressedUserData,
					MAX_USER_ACCOUNT_SIZE_BYTES
				);
				programAccountBufferMap.set(
					programAccount.pubkey.toString(),
					Buffer.from(userBuffer)
				);
			}
		);

		await Promise.all(decodingPromises);
		logger.info(`${programAccountBufferMap.size} users to sync`);

		const promises = Array.from(programAccountBufferMap.entries()).map(
			async ([key, buffer]) => {
				const existingData = await redisClient.getRaw(key);
				const incomingSlot = context.slot;

				if (!existingData) {
					await redisClient
						.forceGetClient()
						.setex(
							key,
							(SYNC_INTERVAL * EXPIRY_MULTIPLIER) / 1000,
							`${incomingSlot}::${buffer.toString('base64')}`
						);
					return;
				}

				const existingSlot = parseInt(existingData.split('::')[0]);
				if (incomingSlot >= existingSlot || isNaN(existingSlot)) {
					await redisClient
						.forceGetClient()
						.setex(
							key,
							(SYNC_INTERVAL * EXPIRY_MULTIPLIER) / 1000,
							`${incomingSlot}::${buffer.toString('base64')}`
						);
				}
			}
		);

		await Promise.all(promises);

		await syncPubKeys(programAccountBufferMap);
	} catch (err) {
		logger.error(`Error in sync(): ${(err as Error).message}`);
		logger.error((err as Error).stack || '');
	} finally {
		syncLock = false;
		logger.info('Releasing sync lock');
		logger.info(`Sync took ${performance.now() - start}ms`);
	}
}

async function syncPubKeys(
	programAccountBufferMap: Map<string, Buffer>
): Promise<void> {
	const newKeys = Array.from(programAccountBufferMap.keys());
	const currentKeys = await redisClient.lRange('user_pubkeys', 0, -1);

	const keysToAdd = newKeys.filter((key) => !currentKeys.includes(key));
	const keysToRemove = currentKeys.filter((key) => !newKeys.includes(key));

	// Remove outdated keys
	const removalBatches = COMMON_UI_UTILS.chunks(keysToRemove, 100);
	for (const batch of removalBatches) {
		await Promise.all(
			batch.map((key) => redisClient.lRem('user_pubkeys', 0, key))
		);
	}

	// Add missing keys
	const additionBatches = COMMON_UI_UTILS.chunks(keysToAdd, 100);
	for (const batch of additionBatches) {
		await redisClient.rPush('user_pubkeys', ...batch);
	}

	logger.info(
		`Synchronized user_pubkeys: Added ${keysToAdd.length}, Removed ${keysToRemove.length}`
	);
}

/**
 * Remove any pubkeys from the Redis list that no longer have data in Redis.
 */
async function checkSync(): Promise<void> {
	if (syncLock) {
		logger.info('SYNC LOCKED DURING CHECK');
		return;
	}

	const storedUserPubkeys = await redisClient.lRange('user_pubkeys', 0, -1);
	const removedKeys: string[] = [];

	await Promise.all(
		storedUserPubkeys.map(async (pubkey) => {
			const exists = await redisClient.forceGetClient().exists(pubkey);
			if (!exists) {
				removedKeys.push(pubkey);
			}
		})
	);

	if (removedKeys.length > 0) {
		await Promise.all(
			removedKeys.map((pubkey) => redisClient.lRem('user_pubkeys', 0, pubkey))
		);
	}

	logger.warn(
		`Found ${removedKeys.length} keys to remove from user_pubkeys list`
	);
}

async function mainChildProcess() {
	await decoder.init();

	if (SYNC_ON_STARTUP) {
		await sync();
	}

	let syncCount = 0;
	setInterval(async () => {
		logger.info('Syncing on interval from child process');
		await sync();

		if (syncCount % EXPIRY_MULTIPLIER === 0) {
			logger.info('Checking sync on interval from child process');
			await checkSync();
		}
		syncCount++;
	}, SYNC_INTERVAL);
}

mainChildProcess().catch((err) => {
	logger.error(`Unhandled error in sync.ts child process: ${err}`);
	process.exit(1);
});
