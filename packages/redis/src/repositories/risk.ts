import { RiskBucket } from '@backend/common';
import { Redis } from '../client';

export const RiskRepository = () => {
	const { mSet, get, set, zAdd, zRem, zRangeWithScores, zRangeByScore } = Redis();

	const generateAccountUpdateKey = (user: string) => `{account}:${user}:updates`;
	const generateAccountRiskKey = (user: string) => `{account}:${user}:risk`;
	const generateRiskBucketKey = (bucket: RiskBucket) => `risk:${bucket}:accounts`;

	const getAccountRisk = async (user: string) => {
		const data = await get(generateAccountRiskKey(user));
		return data ? JSON.parse(data) : null;
	};

	const updateAccountRisk = async (
		user: string,
		oldBucket: RiskBucket,
		data: {
			healthRatio: number;
			riskBucket: RiskBucket;
			lastUpdated: number;
		}
	) => {
		const accountKey = generateAccountRiskKey(user);
		await set(
			accountKey,
			JSON.stringify({
				healthRatio: data.healthRatio.toString(),
				riskBucket: data.riskBucket,
				lastUpdated: data.lastUpdated.toString(),
			})
		);

		const bucketKey = generateRiskBucketKey(data.riskBucket);
		await zAdd(bucketKey, [
			{
				score: data.healthRatio,
				value: user,
			},
		]);

		if (oldBucket !== null && oldBucket !== data.riskBucket) {
			await removeAccountFromBucket(user, oldBucket);
		}
	};

	const removeAccountFromBucket = async (user: string, bucket: RiskBucket) => {
		await zRem(generateRiskBucketKey(bucket), user);
	};

	const batchUpdateAccountRisk = async (
		updates: Array<{
			user: string;
			healthRatio: number;
			riskBucket: RiskBucket;
			lastUpdated: number;
		}>
	) => {
		const riskData: Record<string, string> = {};
		const bucketUpdates = new Map<
			RiskBucket,
			Array<{
				score: number;
				value: string;
			}>
		>();

		updates.forEach(({ user, healthRatio, riskBucket, lastUpdated }) => {
			riskData[generateAccountRiskKey(user)] = JSON.stringify({
				healthRatio: healthRatio.toString(),
				riskBucket,
				lastUpdated: lastUpdated.toString(),
			});

			if (!bucketUpdates.has(riskBucket)) {
				bucketUpdates.set(riskBucket, []);
			}

			bucketUpdates.get(riskBucket)!.push({
				score: healthRatio,
				value: user,
			});
		});

		const addOperations = Array.from(bucketUpdates.entries()).map(([bucket, members]) =>
			zAdd(generateRiskBucketKey(bucket), members)
		);

		const removeOperations = Array.from(bucketUpdates.entries()).flatMap(
			([bucket, members]) => {
				return Object.values(RiskBucket)
					.filter((cleanBucket) => cleanBucket !== bucket)
					.map((cleanBucket) =>
						zRem(generateRiskBucketKey(cleanBucket), ...members.map((m) => m.value))
					);
			}
		);

		await Promise.all([mSet(riskData), ...addOperations, ...removeOperations]);
	};

	const getUsersByRiskBucket = async (bucket: RiskBucket) => {
		return zRangeWithScores(generateRiskBucketKey(bucket), 0, -1);
	};

	const getUsersInRiskRange = async (
		bucket: RiskBucket,
		minHealthRatio: number,
		maxHealthRatio: number
	) => {
		return zRangeByScore(generateRiskBucketKey(bucket), minHealthRatio, maxHealthRatio);
	};

	const disconnect = async () => {
		await disconnect();
	};

	return {
		generateAccountUpdateKey,
		generateAccountRiskKey,
		generateRiskBucketKey,
		getAccountRisk,
		removeAccountFromBucket,
		updateAccountRisk,
		batchUpdateAccountRisk,
		getUsersByRiskBucket,
		getUsersInRiskRange,
		disconnect,
	};
};
