import {
	RedisClient,
	RedisClientPrefix,
} from '@velocity-exchange/common/clients';
import { sleep } from '@velocity-exchange/common';
import {
	BigNum,
	DriftClient,
	OneShotUserAccountSubscriber,
	PerpMarkets,
	PublicKey,
	QUOTE_PRECISION_EXP,
	QUOTE_SPOT_MARKET_INDEX,
	User,
	Wallet,
	ZERO,
	calculateClaimablePnl,
	decodeUser,
} from '@velocity-exchange/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import { logger } from '../utils/logger';
import Bottleneck from 'bottleneck';

const dotenv = require('dotenv');
dotenv.config();

logger.info('Starting script to publish unsettled pnl users');

type UserPnlMap = {
	[perpMarketIndex: number]: {
		gain: { userPubKey: string; pnl: number }[];
		loss: { userPubKey: string; pnl: number }[];
	};
};

type AllPnlUsers = {
	[perpMarketIndex: number]: {
		users: { userPubKey: string; pnl: number }[];
	};
};

const startTime = Date.now();
const endpoint = process.env.ENDPOINT as string;
const wsEndpoint = process.env.WS_ENDPOINT as string;
const driftEnv = process.env.ENV as string;
const chunkSize = Number(process.env.CHUNK_SIZE) || 100;
const sleepTimeMs = Number(process.env.SLEEP_TIME_MS) || 500;
const delayMs = Number(process.env.DEFAULT_DELAY_MS) || 100;

const connection = new Connection(endpoint, {
	commitment: 'confirmed',
	wsEndpoint: wsEndpoint,
});

const driftClient = new DriftClient({
	connection,
	wallet: new Wallet(new Keypair()),
});

const userMapRedisClient = new RedisClient({
	host: process.env.ELASTICACHE_USERMAP_HOST ?? process.env.ELASTICACHE_HOST,
	port: process.env.ELASTICACHE_USERMAP_PORT ?? process.env.ELASTICACHE_PORT,
	prefix: RedisClientPrefix.USER_MAP,
});

const dlobRedisClient = new RedisClient({
	prefix: RedisClientPrefix.DLOB,
});

const main = async () => {
	// get the users from usermap redis client
	await driftClient.subscribe();

	const limiter = new Bottleneck({
		maxConcurrent: 10,
		minTime: delayMs,
	});

	const userStrings = await userMapRedisClient.lRange('user_pubkeys', 0, -1);

	const totalCount = userStrings.length;
	let finishedCount = 0;
	let allNonZeroPnls = {};

	logger.info(`Starting loop for total of ${totalCount} users`);

	while (finishedCount < totalCount) {
		const userChunk = userStrings.slice(
			finishedCount,
			finishedCount + chunkSize
		);

		limiter.schedule(async () => {
			const redisUsers = await Promise.all(
				userChunk.map((userStr) => getUserFromRedis(userStr))
			);
			// add all the nonzero pnl users from each market in chunks
			allNonZeroPnls = buildUserMarketLists(redisUsers, allNonZeroPnls);
		});

		finishedCount += chunkSize;

		logger.info(`Wrote ${finishedCount} users, sleeping for ${sleepTimeMs}ms`);

		await sleep(sleepTimeMs);
	}

	const userPnlMap = createMarketPnlLeaderboards(allNonZeroPnls);

	const success = await writeToDlobRedis(userPnlMap);

	logger.info(
		`Unsettled PnL publisher ${
			success ? 'successfully completed' : 'failed'
		} in ${Date.now() - startTime} ms`
	);

	await sleep(5000);

	logger.info('==== TEST PRINT LOSERS FROM BTC-PERP ====');
	const losers = await dlobRedisClient.getRaw(`perp_market_1_losers`);
	logger.info(losers);

	process.exit();
};

const writeToDlobRedis = async (userPnlMap: UserPnlMap): Promise<boolean> => {
	try {
		await Promise.all(
			Object.keys(userPnlMap).map(async (perpMarketIndex) => {
				const gainersRedisKey = `perp_market_${perpMarketIndex}_gainers`;
				const losersRedisKey = `perp_market_${perpMarketIndex}_losers`;

				// write the new lists
				await Promise.all([
					dlobRedisClient.setRaw(
						gainersRedisKey,
						JSON.stringify(userPnlMap[perpMarketIndex].gain ?? [])
					),
					dlobRedisClient.setRaw(
						losersRedisKey,
						JSON.stringify(userPnlMap[perpMarketIndex].loss ?? [])
					),
				]).then(([_winnersResult, _losersResult]) => {
					logger.info(
						`Wrote ${userPnlMap[perpMarketIndex].gain.length} users to redis key: ${gainersRedisKey}`
					);
					logger.info(
						`Wrote ${userPnlMap[perpMarketIndex].loss.length} users to redis key: ${losersRedisKey}`
					);
				});
			})
		);

		return true;
	} catch (e) {
		logger.info(`Error writing to dlob redis client: ${e}`);
		return false;
	}
};

const createMarketPnlLeaderboards = (allPnlUsers: AllPnlUsers): UserPnlMap => {
	const pnlMap = {};

	Object.keys(allPnlUsers).forEach((perpMarketIndex) => {
		try {
			const sortedPnls = allPnlUsers[perpMarketIndex].users.sort(
				(a, b) => b.pnl - a.pnl
			);
			// store the top 20 winners and losers in each perp market
			pnlMap[perpMarketIndex] = {
				gain: sortedPnls.slice(0, 20),
				loss: sortedPnls.slice(-20).reverse(),
			};
		} catch (e) {
			logger.info(
				`Error in ${PerpMarkets[driftEnv][perpMarketIndex].symbol}: ${e}`
			);

			pnlMap[perpMarketIndex] = {
				gain: [],
				loss: [],
			};
		}
	});

	return pnlMap;
};

const buildUserMarketLists = (
	redisUsers: { user: User; bufferString: string }[],
	allPnlUsers: AllPnlUsers
): AllPnlUsers => {
	const newPnlUsers = allPnlUsers;

	const usdcSpotMarket = driftClient.getSpotMarketAccount(
		QUOTE_SPOT_MARKET_INDEX
	);

	for (const perpMarket of PerpMarkets[driftEnv]) {
		try {
			const perpMarketAccount = driftClient.getPerpMarketAccount(
				perpMarket.marketIndex
			);

			const oraclePriceData = driftClient.getOracleDataForPerpMarket(
				perpMarket.marketIndex
			);

			const allNonZeroPnlsInMarket = redisUsers.flatMap((redisUser) => {
				try {
					const perpPosition = redisUser.user.getPerpPosition(
						perpMarket.marketIndex
					);

					if (
						!perpPosition ||
						(perpPosition.baseAssetAmount.eq(ZERO) &&
							perpPosition.quoteAssetAmount.eq(ZERO))
					)
						return [];

					const marketPnl = calculateClaimablePnl(
						perpMarketAccount,
						usdcSpotMarket,
						perpPosition,
						oraclePriceData
					);

					return marketPnl.eq(ZERO)
						? []
						: {
								userPubKey: redisUser.user.userAccountPublicKey.toString(),
								pnl: BigNum.from(marketPnl, QUOTE_PRECISION_EXP).toNum(),
						  };
				} catch (e) {
					logger.error(
						`Error reading pnl for user ${redisUser?.user?.userAccountPublicKey?.toString()}: `,
						e
					);
					return [];
				}
			});

			if (!allPnlUsers[perpMarket.marketIndex]) {
				newPnlUsers[perpMarket.marketIndex] = { users: allNonZeroPnlsInMarket };
			} else {
				newPnlUsers[perpMarket.marketIndex] = {
					users: allPnlUsers[perpMarket.marketIndex].users.concat(
						allNonZeroPnlsInMarket
					),
				};
			}
		} catch (e) {
			logger.error(`Could not fetch PnLs for ${perpMarket.symbol}: `, e);
		}
	}

	return newPnlUsers;
};

const getUserFromRedis = async (userAccountStr: string) => {
	const data = await userMapRedisClient.getRaw(userAccountStr);
	try {
		const bufferString = data.split('::')[1];
		const user = await createUserAccountFromBuffer(
			driftClient,
			userAccountStr,
			bufferString
		);
		return { user, bufferString };
	} catch (e) {
		logger.error(
			`Error creating user account from buffer for user ${userAccountStr}`,
			e.message
		);
	}
};

const createUserAccountFromBuffer = async (
	driftClient: DriftClient,
	userAccountKey: string,
	bufferString: string
): Promise<User> => {
	const publicKey = new PublicKey(userAccountKey);
	const buffer = Buffer.from(bufferString, 'base64');
	const userAccount = decodeUser(buffer);
	const user = new User({
		driftClient: driftClient,
		userAccountPublicKey: publicKey,
		accountSubscription: {
			type: 'custom',
			userAccountSubscriber: new OneShotUserAccountSubscriber(
				driftClient.program,
				publicKey,
				userAccount
			),
		},
	});
	await user.subscribe(userAccount);
	return user;
};

main();
