import {
	calculatePnlFromTrade,
	DEFAULT_ENDPOINT,
	getTimestamp,
	getUTCDayFromTimestamp,
	LeaderboardEntry,
	LeaderboardSort,
	logger,
	TradeRecord,
	UserRankResult,
} from '@backend/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeUser } from '@velocity-exchange/sdk';
import Decimal from 'decimal.js';
import { Redis } from '../client';

const ENDPOINT = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;
const connection = new Connection(ENDPOINT);

export const LeaderboardCacheRepository = () => {
	const redis = Redis();

	const ignoredUserList = new Set();

	const MARKETS_KEY = '{leaderboard}:markets';
	const AUTHORITY_CACHE_HASH = '{leaderboard}:authorities';
	const LAST_VERIFIED_KEY = '{leaderboard}:last_verified_ts';
	const VERIFICATION_LOCK_KEY = '{leaderboard}:verification_lock';

	const TODAY_VOLUME_KEY = (day: string) => `{leaderboard}:${LeaderboardSort.VOLUME}:${day}`;
	const TODAY_PNL_KEY = (day: string) => `{leaderboard}:${LeaderboardSort.PNL}:${day}`;
	const TODAY_MARKET_VOLUME_KEY = (day: string, market: string) =>
		`{leaderboard}:market:${market}:${LeaderboardSort.VOLUME}:${day}`;
	const TODAY_MARKET_PNL_KEY = (day: string, market: string) =>
		`{leaderboard}:market:${market}:${LeaderboardSort.PNL}:${day}`;

	const TODAY_MAKER_VOLUME_KEY = (day: string) =>
		`{leaderboard}:maker:${LeaderboardSort.VOLUME}:${day}`;
	const TODAY_TAKER_VOLUME_KEY = (day: string) =>
		`{leaderboard}:taker:${LeaderboardSort.VOLUME}:${day}`;
	const TODAY_USER_PNL_KEY = (day: string) => `{leaderboard}:user:${LeaderboardSort.PNL}:${day}`;
	const TODAY_FEE_PAID_KEY = (day: string) => `{leaderboard}:fees:paid:${day}`;
	const TODAY_FEE_REBATE_KEY = (day: string) => `{leaderboard}:fees:rebate:${day}`;

	const VERIFIED_VOLUME_KEY = (day: string) =>
		`{leaderboard}:${LeaderboardSort.VOLUME}:verified:${day}`;
	const VERIFIED_PNL_KEY = (day: string) =>
		`{leaderboard}:${LeaderboardSort.PNL}:verified:${day}`;
	const VERIFIED_MARKET_VOLUME_KEY = (day: string, market: string) =>
		`{leaderboard}:market:${market}:${LeaderboardSort.VOLUME}:verified:${day}`;
	const VERIFIED_MARKET_PNL_KEY = (day: string, market: string) =>
		`{leaderboard}:market:${market}:${LeaderboardSort.PNL}:verified:${day}`;

	const VERIFIED_MAKER_VOLUME_KEY = (day: string) =>
		`{leaderboard}:maker:${LeaderboardSort.VOLUME}:verified:${day}`;
	const VERIFIED_TAKER_VOLUME_KEY = (day: string) =>
		`{leaderboard}:taker:${LeaderboardSort.VOLUME}:verified:${day}`;
	const VERIFIED_USER_PNL_KEY = (day: string) =>
		`{leaderboard}:user:${LeaderboardSort.PNL}:verified:${day}`;
	const VERIFIED_FEE_PAID_KEY = (day: string) => `{leaderboard}:fees:paid:verified:${day}`;
	const VERIFIED_FEE_REBATE_KEY = (day: string) => `{leaderboard}:fees:rebate:verified:${day}`;

	const getLastVerifiedDay = async () => {
		return redis.get(LAST_VERIFIED_KEY);
	};

	const setLastVerifiedDay = async (day: string) => {
		return redis.set(LAST_VERIFIED_KEY, day);
	};

	const VERIFICATION_LOCK_TTL_SECONDS = 60 * 60;

	const acquireVerificationLock = async () => {
		const acquired = await redis.setNX(
			VERIFICATION_LOCK_KEY,
			VERIFICATION_LOCK_TTL_SECONDS,
			'true'
		);
		if (!acquired) {
			throw new Error('Verification is already running when trying to lock');
		}
	};

	const releaseVerificationLock = async () => {
		return redis.del(VERIFICATION_LOCK_KEY);
	};

	const getAuthorityForUser = async (user: string): Promise<string | null> => {
		try {
			if (ignoredUserList.has(user)) return null;

			const cachedAuthority = await redis.hGet(AUTHORITY_CACHE_HASH, user);
			if (cachedAuthority) {
				return cachedAuthority;
			}

			const userPubkey = new PublicKey(user);
			const accountInfo = await connection.getAccountInfo(userPubkey);

			if (!accountInfo) {
				logger.warn(`Account not found for user: ${user}`);
				ignoredUserList.add(user);
				return null;
			}

			const authority = decodeUser(accountInfo.data).authority.toString();

			if (authority) {
				await redis.hSet(AUTHORITY_CACHE_HASH, user, authority);
				return authority;
			}

			logger.warn(`Could not determine authority for user: ${user}`);

			return null;
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error getting authority for user ${user}: ${message}`);
			return null;
		}
	};

	const updateTradeStats = async (trade: TradeRecord) => {
		const { taker, maker, quoteAssetAmountFilled, symbol, ts, makerFee, takerFee } = trade;

		const volume = new Decimal(quoteAssetAmountFilled);
		const takerPnlWithFees = calculatePnlFromTrade(trade, true, 'taker');
		const takerPnlWithoutFees = calculatePnlFromTrade(trade, false, 'taker');
		const makerPnlWithoutFees = calculatePnlFromTrade(trade, false, 'maker');
		const day = getUTCDayFromTimestamp(ts);

		const makerFeeDecimal = new Decimal(makerFee || 0);
		const takerFeeDecimal = new Decimal(takerFee || 0);

		let authority: string | null = null;
		if (taker) {
			authority = await getAuthorityForUser(taker);
		}

		await redis.executeInPipeline((pipeline) => {
			if (authority) {
				pipeline.zIncrBy(
					TODAY_MARKET_VOLUME_KEY(day, symbol),
					volume.toNumber(),
					authority
				);
				pipeline.zIncrBy(TODAY_VOLUME_KEY(day), volume.toNumber(), authority);
				pipeline.zIncrBy(
					TODAY_MARKET_PNL_KEY(day, symbol),
					takerPnlWithFees.toNumber(),
					authority
				);
				pipeline.zIncrBy(TODAY_PNL_KEY(day), takerPnlWithFees.toNumber(), authority);
			}

			if (taker) {
				pipeline.zIncrBy(TODAY_TAKER_VOLUME_KEY(day), volume.toNumber(), taker);
				// Track taker PnL without fees in shared key
				pipeline.zIncrBy(TODAY_USER_PNL_KEY(day), takerPnlWithoutFees.toNumber(), taker);

				// Track taker fees
				if (takerFeeDecimal.isPositive() && !takerFeeDecimal.isZero()) {
					pipeline.zIncrBy(TODAY_FEE_PAID_KEY(day), takerFeeDecimal.toNumber(), taker);
				} else if (takerFeeDecimal.isNegative() && !takerFeeDecimal.isZero()) {
					pipeline.zIncrBy(
						TODAY_FEE_REBATE_KEY(day),
						takerFeeDecimal.abs().toNumber(),
						taker
					);
				}
			}

			if (maker) {
				pipeline.zIncrBy(TODAY_MAKER_VOLUME_KEY(day), volume.toNumber(), maker);
				// Track maker PnL without fees in shared key
				pipeline.zIncrBy(TODAY_USER_PNL_KEY(day), makerPnlWithoutFees.toNumber(), maker);

				// Track maker fees
				if (makerFeeDecimal.isPositive() && !makerFeeDecimal.isZero()) {
					pipeline.zIncrBy(TODAY_FEE_PAID_KEY(day), makerFeeDecimal.toNumber(), maker);
				} else if (makerFeeDecimal.isNegative() && !makerFeeDecimal.isZero()) {
					pipeline.zIncrBy(
						TODAY_FEE_REBATE_KEY(day),
						makerFeeDecimal.abs().toNumber(),
						maker
					);
				}
			}

			pipeline.sAdd(MARKETS_KEY, symbol);
		});
	};

	const getMarkets = async (): Promise<string[]> => {
		return await redis.sMembers(MARKETS_KEY);
	};

	const adjustDate = (dateStr: string, days: number) => {
		const date = new Date(dateStr);
		date.setDate(date.getDate() + days);
		return date.toISOString().split('T')[0];
	};

	const enumerateDates = (start: string, end: string): string[] => {
		const startDate = new Date(start);
		const endDate = new Date(end);

		const result: string[] = [];
		const cur = new Date(startDate);

		while (cur.getTime() <= endDate.getTime()) {
			result.push(cur.toISOString().split('T')[0]);
			cur.setUTCDate(cur.getUTCDate() + 1);
		}

		return result;
	};

	const leaderboardDeltasCacheKey = (startDay: string, endDay: string, symbol?: string) =>
		`{leaderboard}:deltas:${startDay}:${endDay}:${symbol ?? 'all'}`;

	const computeLeaderboardDeltas = async ({
		startDay,
		endDay,
		symbol,
	}: {
		startDay: string;
		endDay: string;
		symbol?: string;
	}) => {
		const cacheKey = leaderboardDeltasCacheKey(startDay, endDay, symbol);

		const cached = await redis.get(cacheKey);
		if (cached) {
			try {
				return JSON.parse(cached);
			} catch {
				// fail forward
			}
		}

		const isToday = endDay >= getUTCDayFromTimestamp(getTimestamp());
		const lastVerifiedDay = (await getLastVerifiedDay()) ?? '';
		const effectiveStart = adjustDate(startDay, -1);

		logger.info(
			`Computing deltas: start=${startDay}, end=${endDay}, isToday=${isToday}, lastVerified=${lastVerifiedDay}`
		);

		let volumeDeltaEntries;
		let pnlDeltaEntries;

		const getVolumeKey = (day: string) =>
			symbol ? TODAY_MARKET_VOLUME_KEY(day, symbol) : TODAY_VOLUME_KEY(day);
		const getPnlKey = (day: string) =>
			symbol ? TODAY_MARKET_PNL_KEY(day, symbol) : TODAY_PNL_KEY(day);
		const getVerifiedVolumeKey = (day: string) =>
			symbol ? VERIFIED_MARKET_VOLUME_KEY(day, symbol) : VERIFIED_VOLUME_KEY(day);
		const getVerifiedPnlKey = (day: string) =>
			symbol ? VERIFIED_MARKET_PNL_KEY(day, symbol) : VERIFIED_PNL_KEY(day);

		try {
			if (startDay == endDay && isToday) {
				[volumeDeltaEntries, pnlDeltaEntries] = await Promise.all([
					redis.zRangeWithScores(getVolumeKey(endDay), 0, -1),
					redis.zRangeWithScores(getPnlKey(endDay), 0, -1),
				]);
			} else if (lastVerifiedDay >= effectiveStart && lastVerifiedDay >= endDay) {
				[volumeDeltaEntries, pnlDeltaEntries] = await Promise.all([
					redis.zUnion(
						[getVerifiedVolumeKey(endDay), getVerifiedVolumeKey(effectiveStart)],
						{ WEIGHTS: [1, -1] }
					),
					redis.zUnion([getVerifiedPnlKey(endDay), getVerifiedPnlKey(effectiveStart)], {
						WEIGHTS: [1, -1],
					}),
				]);
			} else if (!lastVerifiedDay) {
				// No verified data exists yet — sum daily TODAY keys across the range.
				// TODAY keys hold per-day deltas (see updateTradeStats), so a straight
				// sum over [startDay, endDay] is the delta we want.
				const dates = enumerateDates(startDay, endDay);
				const volumeKeys = dates.map(getVolumeKey);
				const pnlKeys = dates.map(getPnlKey);
				[volumeDeltaEntries, pnlDeltaEntries] = await Promise.all([
					redis.zUnion(volumeKeys, { WEIGHTS: volumeKeys.map(() => 1) }),
					redis.zUnion(pnlKeys, { WEIGHTS: pnlKeys.map(() => 1) }),
				]);
			} else {
				// We need to combine data together
				const tempKeys: string[] = [];

				const getAggregatedKey = async (
					condition: boolean,
					enumerateStartDate: string,
					enumerateEndDate: string,
					singleKeyDate: string,
					volumeKeyFn: (date: string) => string,
					pnlKeyFn: (date: string) => string,
					keyPrefix: string
				): Promise<{ volumeKey: string; pnlKey: string }> => {
					if (condition) {
						const tempVolumeKey = `{leaderboard}:temp:${new Date().getTime()}:${keyPrefix}_volume${
							symbol ? `_${symbol}` : ''
						}`;
						const tempPnlKey = `{leaderboard}:temp:${new Date().getTime()}:${keyPrefix}_pnl${
							symbol ? `_${symbol}` : ''
						}`;
						tempKeys.push(tempVolumeKey, tempPnlKey);

						const dates = enumerateDates(enumerateStartDate, enumerateEndDate);

						const volumeKeys = dates.map((date, index) =>
							index ? getVolumeKey(date) : getVerifiedVolumeKey(date)
						);
						const pnlKeys = dates.map((date, index) =>
							index ? getPnlKey(date) : getVerifiedPnlKey(date)
						);

						await Promise.all([
							redis.zUnionStore(tempVolumeKey, volumeKeys, {
								WEIGHTS: volumeKeys.map(() => 1),
							}),
							redis.zUnionStore(tempPnlKey, pnlKeys, {
								WEIGHTS: pnlKeys.map(() => 1),
							}),
						]);

						return { volumeKey: tempVolumeKey, pnlKey: tempPnlKey };
					} else {
						return {
							volumeKey: volumeKeyFn(singleKeyDate),
							pnlKey: pnlKeyFn(singleKeyDate),
						};
					}
				};

				try {
					const [startKeys, endKeys] = await Promise.all([
						getAggregatedKey(
							lastVerifiedDay < effectiveStart,
							lastVerifiedDay,
							startDay,
							effectiveStart,
							getVerifiedVolumeKey,
							getVerifiedPnlKey,
							'start'
						),
						getAggregatedKey(
							lastVerifiedDay < endDay,
							lastVerifiedDay,
							endDay,
							endDay,
							getVerifiedVolumeKey,
							getVerifiedPnlKey,
							'end'
						),
					]);

					[volumeDeltaEntries, pnlDeltaEntries] = await Promise.all([
						redis.zUnion([endKeys.volumeKey, startKeys.volumeKey], {
							WEIGHTS: [1, -1],
						}),
						redis.zUnion([endKeys.pnlKey, startKeys.pnlKey], {
							WEIGHTS: [1, -1],
						}),
					]);
				} finally {
					if (tempKeys.length > 0) {
						await Promise.all(tempKeys.map((key: string) => redis.del(key)));
					}
				}
			}
			const volumeDeltaMap = new Map(
				(volumeDeltaEntries ?? []).map((e) => [e.value, e.score])
			);
			const pnlDeltaMap = new Map((pnlDeltaEntries ?? []).map((e) => [e.value, e.score]));
			const allUsers = new Set([...volumeDeltaMap.keys(), ...pnlDeltaMap.keys()]);

			const results = [];
			for (const user of allUsers) {
				const volumeDelta = volumeDeltaMap.get(user) ?? 0;
				const pnlDelta = pnlDeltaMap.get(user) ?? 0;
				if (volumeDelta > 0 || Math.abs(pnlDelta) > 0.000001) {
					results.push({
						authority: user,
						volume: volumeDelta,
						pnl: pnlDelta,
					});
				}
			}

			const ttl = isToday ? 30 : 24 * 60 * 60;
			await redis.setEx(cacheKey, ttl, JSON.stringify(results));

			return results;
		} catch (error) {
			logger.error(`Error computing leaderboard deltas: ${error.message}`);
			return [];
		}
	};

	const assignRanks = (
		entries: Omit<LeaderboardEntry, 'rank'>[],
		sort: LeaderboardSort
	): Array<LeaderboardEntry> => {
		const sorted = [...entries].sort((a, b) =>
			sort === LeaderboardSort.PNL ? b.pnl - a.pnl : b.volume - a.volume
		);

		let currentRank = 1;
		let prevValue: number | null = null;
		let displayRank = 1;

		return sorted.map((entry) => {
			const value = sort === LeaderboardSort.PNL ? entry.pnl : entry.volume;
			if (value !== prevValue) {
				displayRank = currentRank;
			}
			prevValue = value;
			const result = { ...entry, rank: displayRank };
			currentRank++;
			return result;
		});
	};

	const getLeaderboard = async ({
		sort = LeaderboardSort.PNL,
		page,
		limit,
		start,
		end,
		symbol,
	}: {
		sort: LeaderboardSort;
		page: number;
		limit: number;
		start?: string;
		end?: string;
		symbol?: string;
	}): Promise<LeaderboardEntry[]> => {
		const paginationStart = (page - 1) * limit;
		const paginationEnd = paginationStart + limit - 1;

		const startDay = start ?? getUTCDayFromTimestamp(getTimestamp({ days: -7 }));
		const endDay = end ?? getUTCDayFromTimestamp(getTimestamp());

		if (startDay > endDay) {
			return [];
		}

		const deltas = await computeLeaderboardDeltas({
			startDay,
			endDay,
			symbol,
		});

		const ranked = assignRanks(deltas, sort);
		return ranked.slice(paginationStart, paginationEnd + 1);
	};

	const getLeaderboardRank = async ({
		authority,
		start,
		end,
		symbol,
	}: {
		authority: string;
		start?: string;
		end?: string;
		symbol?: string;
	}): Promise<UserRankResult> => {
		const startDay = start ?? getUTCDayFromTimestamp(getTimestamp({ days: -7 }));
		const endDay = end ?? getUTCDayFromTimestamp(getTimestamp());

		if (startDay > endDay) {
			return {
				pnl: 0,
				volume: 0,
				rank: { pnl: null, volume: null },
			};
		}
		const deltas = await computeLeaderboardDeltas({
			startDay,
			endDay,
			symbol,
		});

		const rankedByPnl = assignRanks(deltas, LeaderboardSort.PNL);
		const rankedByVolume = assignRanks(deltas, LeaderboardSort.VOLUME);

		const pnlEntry = rankedByPnl.find((e) => e.authority === authority);
		const volumeEntry = rankedByVolume.find((e) => e.authority === authority);

		return {
			pnl: pnlEntry?.pnl ?? 0,
			volume: volumeEntry?.volume ?? 0,
			rank: {
				pnl: pnlEntry?.rank ?? null,
				volume: volumeEntry?.rank ?? null,
			},
		};
	};

	const getAllUserVolumesAndFees = async (): Promise<{
		cumulativeMakerVolumes: Map<string, number>;
		cumulativeTakerVolumes: Map<string, number>;
		cumulativeRealizedPnl: Map<string, number>;
		cumulativeFeesPaid: Map<string, number>;
		cumulativeFeesRebate: Map<string, number>;
	}> => {
		const today = getUTCDayFromTimestamp(getTimestamp());
		const lastVerifiedDay = (await getLastVerifiedDay()) ?? '';

		let makerEntries, takerEntries, userPnlEntries;
		let feePaidEntries, feeRebateEntries;

		if (lastVerifiedDay) {
			const startUnverified = adjustDate(lastVerifiedDay, 1);
			const unverifiedDays = enumerateDates(startUnverified, today);

			const verifiedMakerKey = VERIFIED_MAKER_VOLUME_KEY(lastVerifiedDay);
			const verifiedTakerKey = VERIFIED_TAKER_VOLUME_KEY(lastVerifiedDay);
			const verifiedUserPnlKey = VERIFIED_USER_PNL_KEY(lastVerifiedDay);
			const verifiedFeePaidKey = VERIFIED_FEE_PAID_KEY(lastVerifiedDay);
			const verifiedFeeRebateKey = VERIFIED_FEE_REBATE_KEY(lastVerifiedDay);

			const makerKeys = [
				verifiedMakerKey,
				...unverifiedDays.map((d) => TODAY_MAKER_VOLUME_KEY(d)),
			];
			const takerKeys = [
				verifiedTakerKey,
				...unverifiedDays.map((d) => TODAY_TAKER_VOLUME_KEY(d)),
			];
			const userPnlKeys = [
				verifiedUserPnlKey,
				...unverifiedDays.map((d) => TODAY_USER_PNL_KEY(d)),
			];
			const feePaidKeys = [
				verifiedFeePaidKey,
				...unverifiedDays.map((d) => TODAY_FEE_PAID_KEY(d)),
			];
			const feeRebateKeys = [
				verifiedFeeRebateKey,
				...unverifiedDays.map((d) => TODAY_FEE_REBATE_KEY(d)),
			];

			[makerEntries, takerEntries, userPnlEntries, feePaidEntries, feeRebateEntries] =
				await Promise.all([
					redis.zUnion(makerKeys, { WEIGHTS: makerKeys.map(() => 1) }),
					redis.zUnion(takerKeys, { WEIGHTS: takerKeys.map(() => 1) }),
					redis.zUnion(userPnlKeys, { WEIGHTS: userPnlKeys.map(() => 1) }),
					redis.zUnion(feePaidKeys, { WEIGHTS: feePaidKeys.map(() => 1) }),
					redis.zUnion(feeRebateKeys, { WEIGHTS: feeRebateKeys.map(() => 1) }),
				]);
		} else {
			const todayMakerKey = TODAY_MAKER_VOLUME_KEY(today);
			const todayTakerKey = TODAY_TAKER_VOLUME_KEY(today);
			const todayUserPnlKey = TODAY_USER_PNL_KEY(today);
			const todayFeePaidKey = TODAY_FEE_PAID_KEY(today);
			const todayFeeRebateKey = TODAY_FEE_REBATE_KEY(today);

			[makerEntries, takerEntries, userPnlEntries, feePaidEntries, feeRebateEntries] =
				await Promise.all([
					redis.zRangeWithScores(todayMakerKey, 0, -1),
					redis.zRangeWithScores(todayTakerKey, 0, -1),
					redis.zRangeWithScores(todayUserPnlKey, 0, -1),
					redis.zRangeWithScores(todayFeePaidKey, 0, -1),
					redis.zRangeWithScores(todayFeeRebateKey, 0, -1),
				]);
		}

		const cumulativeMakerVolumes = new Map(makerEntries.map((e) => [e.value, e.score]));
		const cumulativeTakerVolumes = new Map(takerEntries.map((e) => [e.value, e.score]));
		const cumulativeRealizedPnl = new Map(userPnlEntries.map((e) => [e.value, e.score]));
		const cumulativeFeesPaid = new Map(feePaidEntries.map((e) => [e.value, e.score]));
		const cumulativeFeesRebate = new Map(feeRebateEntries.map((e) => [e.value, e.score]));

		return {
			cumulativeMakerVolumes,
			cumulativeTakerVolumes,
			cumulativeRealizedPnl,
			cumulativeFeesPaid,
			cumulativeFeesRebate,
		};
	};

	const getUserVolumeAndFees = async ({
		user,
	}: {
		user: string;
	}): Promise<{
		cumulativeMakerVolume: number;
		cumulativeTakerVolume: number;
		cumulativeRealizedPnl: number;
		cumulativeFeePaid: number;
		cumulativeFeeRebate: number;
	}> => {
		const today = getUTCDayFromTimestamp(getTimestamp());
		const lastVerifiedDay = (await getLastVerifiedDay()) ?? '';

		let cumulativeMakerVolume = 0;
		let cumulativeTakerVolume = 0;
		let cumulativeRealizedPnl = 0;
		let cumulativeFeePaid = 0;
		let cumulativeFeeRebate = 0;

		if (lastVerifiedDay) {
			const startUnverified = adjustDate(lastVerifiedDay, 1);
			const unverifiedDays = enumerateDates(startUnverified, today);

			const verifiedMakerKey = VERIFIED_MAKER_VOLUME_KEY(lastVerifiedDay);
			const verifiedTakerKey = VERIFIED_TAKER_VOLUME_KEY(lastVerifiedDay);
			const verifiedUserPnlKey = VERIFIED_USER_PNL_KEY(lastVerifiedDay);
			const verifiedFeePaidKey = VERIFIED_FEE_PAID_KEY(lastVerifiedDay);
			const verifiedFeeRebateKey = VERIFIED_FEE_REBATE_KEY(lastVerifiedDay);

			const makerKeys = [
				verifiedMakerKey,
				...unverifiedDays.map((d) => TODAY_MAKER_VOLUME_KEY(d)),
			];
			const takerKeys = [
				verifiedTakerKey,
				...unverifiedDays.map((d) => TODAY_TAKER_VOLUME_KEY(d)),
			];
			const userPnlKeys = [
				verifiedUserPnlKey,
				...unverifiedDays.map((d) => TODAY_USER_PNL_KEY(d)),
			];
			const feePaidKeys = [
				verifiedFeePaidKey,
				...unverifiedDays.map((d) => TODAY_FEE_PAID_KEY(d)),
			];
			const feeRebateKeys = [
				verifiedFeeRebateKey,
				...unverifiedDays.map((d) => TODAY_FEE_REBATE_KEY(d)),
			];

			const pipelineResults = await redis.executeInPipeline((pipeline) => {
				makerKeys.forEach((key) => pipeline.zScore(key, user));
				takerKeys.forEach((key) => pipeline.zScore(key, user));
				userPnlKeys.forEach((key) => pipeline.zScore(key, user));
				feePaidKeys.forEach((key) => pipeline.zScore(key, user));
				feeRebateKeys.forEach((key) => pipeline.zScore(key, user));
			});

			const makerScores = pipelineResults.slice(0, makerKeys.length);
			const takerScores = pipelineResults.slice(
				makerKeys.length,
				makerKeys.length + takerKeys.length
			);
			const userPnlScores = pipelineResults.slice(
				makerKeys.length + takerKeys.length,
				makerKeys.length + takerKeys.length + userPnlKeys.length
			);
			const feePaidScores = pipelineResults.slice(
				makerKeys.length + takerKeys.length + userPnlKeys.length,
				makerKeys.length + takerKeys.length + userPnlKeys.length + feePaidKeys.length
			);
			const feeRebateScores = pipelineResults.slice(
				makerKeys.length + takerKeys.length + userPnlKeys.length + feePaidKeys.length
			);

			cumulativeMakerVolume = makerScores.reduce(
				(sum: number, score) => sum + (Number(score) ?? 0),
				0
			);
			cumulativeTakerVolume = takerScores.reduce(
				(sum: number, score) => sum + (Number(score) ?? 0),
				0
			);
			cumulativeRealizedPnl = userPnlScores.reduce(
				(sum: number, score) => sum + (Number(score) ?? 0),
				0
			);
			cumulativeFeePaid = feePaidScores.reduce(
				(sum: number, score) => sum + (Number(score) ?? 0),
				0
			);
			cumulativeFeeRebate = feeRebateScores.reduce(
				(sum: number, score) => sum + (Number(score) ?? 0),
				0
			);
		} else {
			const todayMakerKey = TODAY_MAKER_VOLUME_KEY(today);
			const todayTakerKey = TODAY_TAKER_VOLUME_KEY(today);
			const todayUserPnlKey = TODAY_USER_PNL_KEY(today);
			const todayFeePaidKey = TODAY_FEE_PAID_KEY(today);
			const todayFeeRebateKey = TODAY_FEE_REBATE_KEY(today);

			const [makerScore, takerScore, userPnlScore, feePaidScore, feeRebateScore] =
				await Promise.all([
					redis.zScore(todayMakerKey, user),
					redis.zScore(todayTakerKey, user),
					redis.zScore(todayUserPnlKey, user),
					redis.zScore(todayFeePaidKey, user),
					redis.zScore(todayFeeRebateKey, user),
				]);

			cumulativeMakerVolume = makerScore ?? 0;
			cumulativeTakerVolume = takerScore ?? 0;
			cumulativeRealizedPnl = userPnlScore ?? 0;
			cumulativeFeePaid = feePaidScore ?? 0;
			cumulativeFeeRebate = feeRebateScore ?? 0;
		}

		return {
			cumulativeMakerVolume,
			cumulativeTakerVolume,
			cumulativeRealizedPnl,
			cumulativeFeePaid,
			cumulativeFeeRebate,
		};
	};

	const applyTradesToSnapshot = async (
		trades: TradeRecord[],
		snapshotKey: string,
		type: 'volume' | 'pnl' | 'feePaid' | 'feeRebate' | 'makerVolume' | 'takerVolume' | 'userPnl'
	) => {
		if (!trades.length) return;

		const updates = new Map<string, Decimal>();
		const markets = new Set();

		for (const trade of trades) {
			const { taker, maker, quoteAssetAmountFilled, makerFee, takerFee } = trade;
			const volume = new Decimal(quoteAssetAmountFilled);
			const makerFeeDecimal = new Decimal(makerFee || 0);
			const takerFeeDecimal = new Decimal(takerFee || 0);

			if (type === 'volume') {
				if (taker) {
					const authority = await getAuthorityForUser(taker);
					if (authority) {
						const currentValue = updates.get(authority) ?? new Decimal(0);
						updates.set(authority, currentValue.add(volume));
					}
				}
			} else if (type === 'pnl') {
				if (taker) {
					const authority = await getAuthorityForUser(taker);
					if (authority) {
						const pnl = calculatePnlFromTrade(trade, true, 'taker');
						const currentValue = updates.get(authority) ?? new Decimal(0);
						updates.set(authority, currentValue.add(pnl));
					}
				}
			} else if (type === 'makerVolume') {
				if (maker) {
					const currentValue = updates.get(maker) ?? new Decimal(0);
					updates.set(maker, currentValue.add(volume));
				}
			} else if (type === 'takerVolume') {
				if (taker) {
					const currentValue = updates.get(taker) ?? new Decimal(0);
					updates.set(taker, currentValue.add(volume));
				}
			} else if (type === 'userPnl') {
				if (maker) {
					const makerPnl = calculatePnlFromTrade(trade, false, 'maker');
					const currentValue = updates.get(maker) ?? new Decimal(0);
					updates.set(maker, currentValue.add(makerPnl));
				}

				if (taker) {
					const takerPnl = calculatePnlFromTrade(trade, false, 'taker');
					const currentValue = updates.get(taker) ?? new Decimal(0);
					updates.set(taker, currentValue.add(takerPnl));
				}
			} else if (type === 'feePaid') {
				if (taker && takerFeeDecimal.isPositive() && !takerFeeDecimal.isZero()) {
					const currentValue = updates.get(taker) ?? new Decimal(0);
					updates.set(taker, currentValue.add(takerFeeDecimal));
				}
				if (maker && makerFeeDecimal.isPositive() && !makerFeeDecimal.isZero()) {
					const currentValue = updates.get(maker) ?? new Decimal(0);
					updates.set(maker, currentValue.add(makerFeeDecimal));
				}
			} else if (type === 'feeRebate') {
				if (taker && takerFeeDecimal.isNegative() && !takerFeeDecimal.isZero()) {
					const currentValue = updates.get(taker) ?? new Decimal(0);
					updates.set(taker, currentValue.add(takerFeeDecimal.abs()));
				}
				if (maker && makerFeeDecimal.isNegative() && !makerFeeDecimal.isZero()) {
					const currentValue = updates.get(maker) ?? new Decimal(0);
					updates.set(maker, currentValue.add(makerFeeDecimal.abs()));
				}
			}

			markets.add(trade.symbol);
		}

		if (updates.size > 0) {
			await redis.executeInPipeline((pipeline) => {
				updates.forEach((value, user) => {
					pipeline.zIncrBy(snapshotKey, value.toNumber(), user);
				});
				markets.forEach((symbol) => {
					pipeline.sAdd(MARKETS_KEY, symbol);
				});
			});
		}
	};

	const verifyLeaderboardType = async ({
		currentVerifiedKey,
		previousVerifiedKey,
		trades,
		type,
	}: {
		currentVerifiedKey: string;
		previousVerifiedKey: string;
		trades: TradeRecord[];
		type:
			| 'volume'
			| 'pnl'
			| 'feePaid'
			| 'feeRebate'
			| 'makerVolume'
			| 'takerVolume'
			| 'userPnl';
	}) => {
		const deltaKey = currentVerifiedKey + `:delta:${getTimestamp()}`;

		logger.info(
			`Keys - current: ${currentVerifiedKey}, previous: ${previousVerifiedKey}, delta: ${deltaKey}`
		);

		try {
			await redis.copy(previousVerifiedKey, currentVerifiedKey);
			await applyTradesToSnapshot(trades, currentVerifiedKey, type);
			await redis.zDelta(deltaKey, [previousVerifiedKey, currentVerifiedKey]);
			const differences = await redis.zRangeWithScores(deltaKey, 0, -1);
			const updates = differences.filter(
				({ score }) => score !== 0 && Math.abs(score) > 0.000001
			);
			logger.info(
				`Updates being applied for ${currentVerifiedKey}: ${JSON.stringify(updates)}`
			);
		} finally {
			await redis.del(deltaKey);
			logger.info('Temporary keys have been deleted');
		}
	};

	return {
		TODAY_PNL_KEY,
		TODAY_VOLUME_KEY,
		TODAY_MARKET_VOLUME_KEY,
		TODAY_MARKET_PNL_KEY,
		TODAY_MAKER_VOLUME_KEY,
		TODAY_TAKER_VOLUME_KEY,
		TODAY_USER_PNL_KEY,
		TODAY_FEE_PAID_KEY,
		TODAY_FEE_REBATE_KEY,

		VERIFIED_PNL_KEY,
		VERIFIED_VOLUME_KEY,
		VERIFIED_MARKET_PNL_KEY,
		VERIFIED_MARKET_VOLUME_KEY,
		VERIFIED_MAKER_VOLUME_KEY,
		VERIFIED_TAKER_VOLUME_KEY,
		VERIFIED_USER_PNL_KEY,
		VERIFIED_FEE_PAID_KEY,
		VERIFIED_FEE_REBATE_KEY,

		updateTradeStats,
		getMarkets,
		getLeaderboard,
		getLeaderboardRank,
		getAllUserVolumesAndFees,
		getUserVolumeAndFees,
		getAuthorityForUser,
		setLastVerifiedDay,
		getLastVerifiedDay,
		verifyLeaderboardType,
		acquireVerificationLock,
		releaseVerificationLock,
	};
};
