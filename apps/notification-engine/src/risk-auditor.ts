import { DEFAULT_ENDPOINT, RiskBucket, batchArray, getTimestamp, logger } from '@backend/common';
import { RiskRepository } from '@backend/redis';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { VelocityClient, VelocityEnv, Wallet } from '@velocity-exchange/sdk';
import Bottleneck from 'bottleneck';
import { RiskManager } from './services/risk-manager';
import { UserRiskData, VerificationResults } from './types';

const ENDPOINT = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;
const ALERT_SUMMARY = process.env.ALERT_SUMMARY === 'true';
const CHUNK_SIZE = 100;

const limiter = new Bottleneck({
	maxConcurrent: 5,
});

const connection = new Connection(ENDPOINT, {
	commitment: 'confirmed',
});

const driftClient = new VelocityClient({
	env: (process.env.ENV ?? 'mainnet-beta') as VelocityEnv,
	connection,
	wallet: new Wallet(new Keypair()),
});

export const handler = async (event: any) => {
	try {
		if (!driftClient._isSubscribed) {
			await driftClient.subscribe();
		}

		const riskBucket: RiskBucket = event.riskBucket;

		if (!Object.values(RiskBucket).includes(riskBucket)) {
			throw new Error(`Invalid risk bucket: ${riskBucket}`);
		}

		logger.info(`Starting verification for ${RiskBucket[riskBucket]} bucket`);

		const {
			determineRiskBucket,
			createUserAccountFromBuffer,
			isSignificantHealthChange,
			addToNotificationQueue,
			processNotifications,
			getNotificationQueue,
		} = RiskManager();

		const { getUsersByRiskBucket, updateAccountRisk, removeAccountFromBucket } =
			RiskRepository();

		const riskBucketUsers = await getUsersByRiskBucket(riskBucket);

		const userDataArray: UserRiskData[] = riskBucketUsers.map(
			(entry: { score: number; value: string }) => ({
				user: entry.value,
				healthRatio: entry.score,
			})
		);

		logger.info(`Found ${userDataArray.length} users in ${RiskBucket[riskBucket]} bucket`);

		const results: VerificationResults = {
			total: userDataArray.length,
			verified: 0,
			mismatched: 0,
			failed: 0,
			notificationsSent: 0,
			details: [],
		};

		const userChunks = batchArray(userDataArray, CHUNK_SIZE);

		await Promise.all(
			userChunks.map(async (chunk, chunkIndex) => {
				const users = chunk.map((userData) => new PublicKey(userData.user));

				const accountsResponse = await limiter.schedule(() =>
					connection.getMultipleAccountsInfo(users)
				);

				await Promise.all(
					chunk.map(async (userData, index) => {
						try {
							const accountInfo = accountsResponse[index];
							if (!accountInfo?.data) {
								await removeAccountFromBucket(userData.user, riskBucket);
								results.failed++;
								results.details.push({
									user: userData.user,
									status: 'failed',
									reason: 'Account not found on-chain',
								});
								return;
							}

							const buffer = Buffer.from(accountInfo.data).toString('base64');
							const user = await createUserAccountFromBuffer(
								driftClient,
								userData.user,
								buffer
							);

							const currentHealth = user.getHealth();
							const currentBucket = determineRiskBucket(currentHealth);

							if (
								isSignificantHealthChange(
									userData.healthRatio,
									currentHealth,
									riskBucket,
									currentBucket
								)
							) {
								results.mismatched++;
								results.details.push({
									user: userData.user,
									status: 'mismatched',
									storedHealth: userData.healthRatio,
									currentHealth,
									storedBucket: riskBucket,
									currentBucket,
								});

								if (currentBucket !== riskBucket) {
									addToNotificationQueue(
										userData.user,
										riskBucket,
										currentBucket,
										currentHealth
									);
								}

								await updateAccountRisk(userData.user, riskBucket, {
									healthRatio: currentHealth,
									riskBucket: currentBucket,
									lastUpdated: getTimestamp(),
								});
							} else {
								results.verified++;
								results.details.push({
									user: userData.user,
									status: 'verified',
									currentHealth: currentHealth,
								});
							}
						} catch (error) {
							results.failed++;
							results.details.push({
								user: userData.user,
								status: 'failed',
								reason: error.message,
							});
						}
					})
				);
				logger.info(`Processed chunk ${chunkIndex + 1}/${userChunks.length}`);
			})
		);

		const notifications = getNotificationQueue();
		results.notificationsSent = notifications.length;

		const summaryMessage = `
			Verification complete for ${RiskBucket[riskBucket]} bucket:
            Total: ${results.total}
            Verified: ${results.verified}
            Mismatched: ${results.mismatched}
            Failed: ${results.failed}
            Notifications Sent: ${results.notificationsSent}
        `;

		if (results.notificationsSent > 0 && ALERT_SUMMARY) {
			logger.warn(summaryMessage, true);
		} else {
			logger.info(summaryMessage);
		}

		if (notifications.length) await processNotifications();

		return {
			total: results.total,
			verified: results.verified,
			mismatched: results.mismatched,
			failed: results.failed,
			notificationsSent: results.notificationsSent,
			summary: summaryMessage.trim(),
		};
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Error in risk bucket verification: ${message}`);
		throw error;
	}
};
