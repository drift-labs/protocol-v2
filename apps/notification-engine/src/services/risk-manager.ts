import { Message } from '@aws-sdk/client-sqs';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
	DEFAULT_ENDPOINT,
	NotificationType,
	RiskBucket,
	batchArray,
	getTimestamp,
	logger,
	simpleSerialize,
	sleep,
} from '@backend/common';
import { Redis, RiskRepository } from '@backend/redis';
import { SQS } from '@backend/sqs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	VelocityClient,
	VelocityEnv,
	OneShotUserAccountSubscriber,
	User,
	Wallet,
	decodeUser,
} from '@velocity-exchange/sdk';
import { SNSMessage } from 'aws-lambda';
import Bottleneck from 'bottleneck';
import { HealthComparison, MessageBody, OraclePriceData, RiskNotification } from '../types';
import { PositionTracker } from './position-tracker';

const ENDPOINT = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;
const connection = new Connection(ENDPOINT, 'finalized');
const driftClient = new VelocityClient({
	env: (process.env.ENV ?? 'mainnet-beta') as VelocityEnv,
	connection,
	wallet: new Wallet(new Keypair()),
});

const HEALTH_CHANGE_THRESHOLD = 2;
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 10;
const MAX_PARALLEL_BATCHES = Number(process.env.MAX_PARALLEL_BATCHES) || 5;
const USER_RISK_MIN_INTERVAL_MS = Number(process.env.USER_RISK_MIN_INTERVAL_MS) || 3000;

const limiter = new Bottleneck({
	maxConcurrent: 400,
});

export const RiskManager = (
	{ isRunning, collectStats, usePositionTracker } = {
		isRunning: true,
		collectStats: false,
		usePositionTracker: false,
	}
) => {
	const { initializeUserPosition, getUserState, getAllUserState, updatePrice, updatePosition } =
		PositionTracker();

	const { get, lRange } = Redis();
	const { getMessages, deleteMessages, putMessages } = SQS();
	const { batchUpdateAccountRisk, updateAccountRisk, getAccountRisk } = RiskRepository();

	const notificationQueue: RiskNotification[] = [];
	const healthComparisons: HealthComparison[] = [];
	const lastRiskProcessedAt = new Map<string, number>();

	const isSignificantHealthChange = (
		oldHealth: number,
		newHealth: number,
		oldRiskBucket: RiskBucket,
		newRiskBucket: RiskBucket
	): boolean => {
		const absoluteChange = Math.abs(oldHealth - newHealth);

		if (newRiskBucket !== oldRiskBucket) {
			return true;
		}

		if (newRiskBucket === RiskBucket.LIQUIDATABLE) {
			return absoluteChange >= HEALTH_CHANGE_THRESHOLD / 2;
		}
		return absoluteChange >= HEALTH_CHANGE_THRESHOLD;
	};

	const determineRiskBucket = (healthPercentage: number): RiskBucket => {
		if (healthPercentage >= 80) return RiskBucket.HEALTHY;
		if (healthPercentage >= 50) return RiskBucket.MODERATE;
		if (healthPercentage >= 20) return RiskBucket.AT_RISK;
		if (healthPercentage >= 5) return RiskBucket.CRITICAL;
		return RiskBucket.LIQUIDATABLE;
	};

	const createUserAccountFromBuffer = async (
		driftClient: VelocityClient,
		userAccountKey: string,
		bufferString: string
	): Promise<User> => {
		const publicKey = new PublicKey(userAccountKey);
		const buffer = Buffer.from(bufferString, 'base64');
		const userAccount = decodeUser(buffer);
		const user = new User({
			driftClient,
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

	const addToNotificationQueue = (
		user: string,
		oldBucket: RiskBucket,
		newBucket: RiskBucket,
		healthRatio: number
	) => {
		if (
			newBucket === RiskBucket.CRITICAL &&
			oldBucket !== RiskBucket.CRITICAL &&
			oldBucket !== RiskBucket.LIQUIDATABLE
		) {
			notificationQueue.push({
				user,
				oldBucket,
				newBucket,
				healthRatio,
				timestamp: getTimestamp(),
			});

			logger.info(
				`Queued risk notification for ${user}: ${RiskBucket[oldBucket]} -> ${healthRatio}%/${RiskBucket[newBucket]}`
			);
		}
	};

	const compareHealthCalculations = (user: string, userAccount?: User) => {
		if (!collectStats || !userAccount) return null;

		const calculatedState = getUserState(user);
		if (!calculatedState) return null;

		const {
			health: { totalCollateral, marginRequirement, healthRatio },
		} = calculatedState;

		const sdkHealth = userAccount.getHealth();
		const sdkCollateral = userAccount.getTotalCollateral('Maintenance').toNumber() / 1e6;
		const sdkMargin = userAccount.getMaintenanceMarginRequirement().toNumber() / 1e6;

		const difference = Math.abs(sdkHealth - healthRatio);
		const percentageDiff = (difference / sdkHealth) * 100;

		const comparison: HealthComparison = {
			user,
			sdkHealth,
			calculatedHealth: healthRatio,
			difference,
			percentageDiff,
			collateral: {
				sdk: sdkCollateral,
				calculated: totalCollateral,
				difference: Math.abs(sdkCollateral - totalCollateral),
			},
			margin: {
				sdk: sdkMargin,
				calculated: marginRequirement,
				difference: Math.abs(sdkMargin - marginRequirement),
			},
		};

		if (comparison.percentageDiff > 1) {
			logHealthComparison(comparison);
		}

		healthComparisons.push(comparison);

		return comparison;
	};

	const logHealthComparison = (comparison: HealthComparison) => {
		logger.warn(
			`=== Health warning for user ${comparison.user} ===
				SDK Health: ${comparison.sdkHealth.toFixed(2)}%
				Calculated Health: ${comparison.calculatedHealth.toFixed(2)}%
				Difference: ${comparison.percentageDiff.toFixed(2)}%
				Collateral Difference: ${comparison.collateral.difference.toFixed(4)}
				Margin Difference: ${comparison.margin.difference.toFixed(4)}`
		);
	};

	const logHealthStatistics = () => {
		const stats = calculateHealthStatistics();
		logger.info(
			`=== Health Calculation Statistics ===
			Total Comparisons: ${stats.total}
			Average Difference: ${stats.avgDifference.toFixed(4)}%
			Max Difference: ${stats.maxDifference.toFixed(4)}%
			Comparisons >1% Difference: ${stats.significantDiffs}
			Accuracy Rate: ${stats.accuracyRate.toFixed(2)}%`
		);
	};

	const calculateHealthStatistics = () => {
		const differences = healthComparisons.map((c) => c.percentageDiff);
		return {
			total: differences.length,
			avgDifference: differences.reduce((a, b) => a + b, 0) / differences.length,
			maxDifference: Math.max(...differences),
			significantDiffs: differences.filter((d) => d > 1).length,
			accuracyRate: (differences.filter((d) => d <= 1).length / differences.length) * 100,
		};
	};

	const getUserFromUsermap = async (user: string) => {
		try {
			const data = await get(`usermap-server:${user}`);
			if (!data) return null;

			const buffer = data.split('::')[1];
			const userAccount = await createUserAccountFromBuffer(driftClient, user, buffer);
			const healthRatio = userAccount.getHealth();

			return {
				user,
				userAccount,
				healthRatio,
				riskBucket: determineRiskBucket(healthRatio),
				positions: simpleSerialize(
					userAccount.getHealthComponents({ marginCategory: 'Maintenance' })
				),
			};
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error getting user ${user} from usermap: ${message}`);
			return null;
		}
	};

	const loadAccountStates = async (users: string[]) => {
		try {
			logger.info(`Loading ${users.length} accounts...`);

			const batchedUsers = batchArray(users, 500);

			const userDataResults = await Promise.all(
				batchedUsers.map((chunk: string[]) =>
					limiter.schedule(() =>
						Promise.all(chunk.map((user) => getUserFromUsermap(user)))
					)
				)
			);

			const validUserData = userDataResults
				.flat()
				.filter((data): data is NonNullable<typeof data> => data !== null);

			logger.info(`Successfully loaded ${validUserData.length}/${users.length} accounts`);

			validUserData.forEach((userData) => {
				initializeUserPosition(userData.user, userData.positions);
				if (collectStats) {
					compareHealthCalculations(userData.user, userData.userAccount);
				}
			});

			if (usePositionTracker) {
				const positionManagerState = getAllUserState();

				const batchedData = batchArray(
					Array.from(positionManagerState).map(([user, state]) => ({
						user,
						healthRatio: state.health.healthRatio,
						riskBucket: determineRiskBucket(state.health.healthRatio),
						lastUpdated: getTimestamp(),
					})),
					1000
				);

				await Promise.all(
					batchedData.map((chunk) =>
						limiter.schedule(() => batchUpdateAccountRisk(chunk))
					)
				);
			} else {
				const batchedData = batchArray(
					validUserData.map((userData) => ({
						user: userData.user,
						healthRatio: userData.healthRatio,
						riskBucket: userData.riskBucket,
						lastUpdated: getTimestamp(),
					})),
					1000
				);

				await Promise.all(
					batchedData.map((chunk) =>
						limiter.schedule(() => batchUpdateAccountRisk(chunk))
					)
				);
			}

			return validUserData;
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error in loadAccountStates: ${message}`);
			throw error;
		}
	};

	const processMessage = async (message: Message) => {
		try {
			if (!message.Body) {
				return { status: 'skipped', message };
			}

			const body: SNSMessage = JSON.parse(message.Body);
			const { type, data } = JSON.parse(body.Message) as MessageBody;

			switch (type) {
				case NotificationType.PRICE_ALERT: {
					await handlePriceUpdate(data);
					break;
				}
				case NotificationType.RECORD_UPDATE: {
					await handlePositionUpdate(unmarshall(data));
					break;
				}
				default: {
					logger.warn(`Message type: ${type} not supported`);
					return { status: 'unsupported', message };
				}
			}

			return {
				status: 'success',
				message,
				processedMessage: {
					Id: message.MessageId!,
					ReceiptHandle: message.ReceiptHandle!,
				},
			};
		} catch (error) {
			logger.error(`Failed to process message ${message.MessageId}: ${error}`);
			return { status: 'failed', message, error };
		}
	};

	const processBatch = async () => {
		try {
			const messages = await getMessages({ maxMessages: BATCH_SIZE });

			if (!messages || messages.length === 0) {
				return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
			}

			const processResults = await Promise.all(
				messages.map((message) => processMessage(message))
			);

			const processedMessages = processResults
				.filter((result) => result.status === 'success')
				.map((result) => result.processedMessage!);

			const failed = processResults
				.filter((result) => result.status === 'failed')
				.map((result) => result.message);

			const skipped = processResults.filter(
				(result) => result.status === 'skipped' || result.status === 'unsupported'
			).length;

			if (processedMessages.length > 0) {
				const failedDeletes = await deleteMessages(processedMessages);
				if (failedDeletes.length > 0) {
					logger.warn(`Failed to delete ${failedDeletes.length} messages`);
				}
			}

			return {
				processed: messages.length,
				succeeded: processedMessages.length,
				failed: failed.length,
				skipped,
			};
		} catch (error) {
			logger.error(`Error in processBatch: ${error}`);
			return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
		}
	};

	const processParallelBatches = async () => {
		try {
			const batchPromises = Array(MAX_PARALLEL_BATCHES)
				.fill(null)
				.map(() => processBatch());

			const results = await Promise.all(batchPromises);

			const totals = results.reduce(
				(acc, result) => {
					acc.processed += result.processed;
					acc.succeeded += result.succeeded;
					acc.failed += result.failed;
					acc.skipped += result.skipped;
					return acc;
				},
				{ processed: 0, succeeded: 0, failed: 0, skipped: 0 }
			);

			if (totals.processed > 0) {
				logger.info(
					`Processed ${totals.processed} messages: ${totals.succeeded} succeeded, ${totals.failed} failed, ${totals.skipped} skipped`
				);
			}

			return totals;
		} catch (error) {
			logger.error(`Error in processParallelBatches: ${error}`);
			return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
		}
	};

	const processUserRisk = async (user: string) => {
		try {
			const accountRisk = await getAccountRisk(user);
			const oldBucket = accountRisk?.riskBucket || null;
			const oldHealth = accountRisk?.healthRatio || 0;

			let userData: {
				userAccount?: User;
				healthRatio: number;
				riskBucket: RiskBucket;
			} | null = null;

			if (usePositionTracker) {
				const userState = getUserState(user);
				if (!userState) return;

				userData = {
					healthRatio: userState.health.healthRatio,
					riskBucket: determineRiskBucket(userState.health.healthRatio),
				};
			} else {
				userData = await getUserFromUsermap(user);
				if (!userData) return;
			}

			const { userAccount, healthRatio, riskBucket: newBucket } = userData;

			if (
				oldBucket !== null &&
				!isSignificantHealthChange(oldHealth, healthRatio, oldBucket, newBucket)
			) {
				lastRiskProcessedAt.set(user, Date.now());
				return;
			}

			if (newBucket !== oldBucket) {
				addToNotificationQueue(user, oldBucket, newBucket, healthRatio);
			}

			if (user && collectStats) {
				compareHealthCalculations(user, userAccount);
			}

			await updateAccountRisk(user, oldBucket, {
				healthRatio,
				riskBucket: newBucket,
				lastUpdated: getTimestamp(),
			});

			lastRiskProcessedAt.set(user, Date.now());
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error processing user ${user}: ${message}`);
		}
	};

	const handlePriceUpdate = async (message: OraclePriceData) => {
		try {
			const { symbol, price } = message;

			const affectedUsers = updatePrice({ symbol, price });

			if (affectedUsers.length === 0) {
				logger.info(`No users affected by market ${symbol} update`);
				return;
			}

			const now = Date.now();
			const eligibleUsers = affectedUsers.filter((user) => {
				const last = lastRiskProcessedAt.get(user) ?? 0;
				return now - last >= USER_RISK_MIN_INTERVAL_MS;
			});

			const skipped = affectedUsers.length - eligibleUsers.length;

			logger.info(
				`Processing price update for ${symbol}: ${price}, affected=${affectedUsers.length}, eligible=${eligibleUsers.length}, skipped=${skipped}`
			);

			if (eligibleUsers.length === 0) return;

			const userBatches = batchArray(eligibleUsers, 500);

			await Promise.all(
				userBatches.map((batch) => Promise.all(batch.map((user) => processUserRisk(user))))
			);
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error in handlePriceUpdate: ${message}`);
			throw error;
		}
	};

	const handlePositionUpdate = async (message: any) => {
		try {
			const { user } = message;

			if (!user) return;

			const now = Date.now();
			const last = lastRiskProcessedAt.get(user) ?? 0;
			if (now - last <= USER_RISK_MIN_INTERVAL_MS) return;

			logger.info(`Processing position update for: ${user}`);

			updatePosition({
				user,
			});

			return limiter.schedule(async () => {
				await processUserRisk(user);
				lastRiskProcessedAt.set(user, Date.now());
			});
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error in handlePositionUpdate: ${message}`);
			throw error;
		}
	};

	const processNotifications = async () => {
		if (notificationQueue.length === 0) return;

		const notifications = notificationQueue.splice(0);

		try {
			await putMessages({
				records: notifications.map((notification, index) => ({
					Id: `${notification.user}-${notification.timestamp}-${index}`,
					MessageBody: JSON.stringify({
						type: NotificationType.ACCOUNT_UPDATE,
						data: notification,
					}),
				})),
				overrideQueue: process.env.NOTIFICATION_QUEUE,
			});
		} catch (error) {
			const { message } = error;
			logger.error(`Failed to process notifications: ${message}`);
			notificationQueue.unshift(...notifications);
		}
	};

	const getNotificationQueue = () => {
		return notificationQueue;
	};

	const resetNotificationQueue = () => {
		return notificationQueue.splice(0);
	};

	const initialize = async () => {
		try {
			logger.info('Initializing risk manager');
			await driftClient.subscribe();
			const pubkeys = await lRange('usermap-server:user_pubkeys', 0, -1);
			await loadAccountStates(pubkeys);

			if (collectStats) {
				logHealthStatistics();
			}
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Failed to initialize risk manager: ${message}`);
			throw error;
		}
	};

	const start = async () => {
		logger.info(
			`Starting Risk manager with ${MAX_PARALLEL_BATCHES} parallel batches of ${BATCH_SIZE} messages...`
		);
		await initialize();
		while (isRunning) {
			await processParallelBatches();
		}
		logger.info('Risk manager stopped');
	};

	const stop = async () => {
		isRunning = false;
		await processNotifications();
		await sleep(5000);
		logger.info('Shutting down risk manager');
	};

	return {
		getUserFromUsermap,
		createUserAccountFromBuffer,
		determineRiskBucket,
		isSignificantHealthChange,
		loadAccountStates,
		processMessage,
		processBatch,
		processParallelBatches,
		processUserRisk,
		getNotificationQueue,
		resetNotificationQueue,
		addToNotificationQueue,
		processNotifications,
		start,
		stop,
	};
};
