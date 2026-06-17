import { Message } from '@aws-sdk/client-sqs';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { logger, RecordTypes } from '@backend/common';
import { Redis, RiskRepository } from '@backend/redis';
import { SQS } from '@backend/sqs';

import {
	depositSchema,
	fundingPaymentSchema,
	liquidationSchema,
	orderActionSchema,
	orderSchema,
	settlePnlSchema,
	swapSchema,
} from '@backend/aggregator-api/src/schemas';
import { applyPrecisions } from '@backend/aggregator-api/src/utils/apply-precisions';
import {
	DEPOSIT_RECORD_ID,
	FUNDING_PAYMENT_RECORD_ID,
	LIQUIDATION_RECORD_ID,
	ORDER_ACTION_RECORD_ID,
	ORDER_RECORD_ID,
	SETTLE_PNL_RECORD_ID,
	SWAP_RECORD_ID,
} from '@backend/dynamodb';
import fastJson from 'fast-json-stringify';
import { UserUpdateRecord } from '../types';

const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 10;
const MAX_PARALLEL_BATCHES = Number(process.env.MAX_PARALLEL_BATCHES) || 1;
const UPDATE_MAX_PER_FLUSH = Number(process.env.UPDATE_MAX_PER_FLUSH ?? 100) as number;

const schemaMap = {
	[RecordTypes.OrderActionRecord]: orderActionSchema,
	[RecordTypes.OrderRecord]: orderSchema,
	[RecordTypes.FundingPaymentRecord]: fundingPaymentSchema,
	[RecordTypes.SettlePnlRecord]: settlePnlSchema,
	[RecordTypes.DepositRecord]: depositSchema,
	[RecordTypes.LiquidationRecord]: liquidationSchema,
	[RecordTypes.SwapRecord]: swapSchema,
	[RecordTypes.RewardRecord]: depositSchema,
};

export const UpdateManager = ({ isRunning } = { isRunning: true }) => {
	const { executeInPipeline } = Redis();
	const { getMessages, deleteMessages } = SQS();
	const { generateAccountUpdateKey } = RiskRepository();

	const userUpdateQueue: UserUpdateRecord[] = [];

	const serializers = Object.entries(schemaMap).reduce((acc, [key, schema]) => {
		acc[key as RecordTypes] = fastJson(schema as any);
		return acc;
	}, {} as Record<RecordTypes, (data: any) => string>);

	const getRecordTypeFromSk = (sk: string): RecordTypes | null => {
		if (sk.startsWith(`${ORDER_ACTION_RECORD_ID}#`)) return RecordTypes.OrderActionRecord;
		if (sk.startsWith(`${ORDER_RECORD_ID}#`)) return RecordTypes.OrderRecord;
		if (sk.startsWith(`${FUNDING_PAYMENT_RECORD_ID}#`)) return RecordTypes.FundingPaymentRecord;
		if (sk.startsWith(`${SETTLE_PNL_RECORD_ID}#`)) return RecordTypes.SettlePnlRecord;
		if (sk.startsWith(`${DEPOSIT_RECORD_ID}#`)) return RecordTypes.DepositRecord;
		if (sk.startsWith(`${LIQUIDATION_RECORD_ID}#`)) return RecordTypes.LiquidationRecord;
		if (sk.startsWith(`${SWAP_RECORD_ID}#`)) return RecordTypes.SwapRecord;
		return null;
	};

	const serializeUserUpdates = (records: any[]) => {
		const serialisedRecords: string[] = [];

		records.forEach((record) => {
			const recordType = getRecordTypeFromSk(record.sk)! as RecordTypes;
			const serializer = serializers[recordType];
			if (!serializer) return;

			const withPrecision = applyPrecisions(record);
			const json = serializer(withPrecision);
			serialisedRecords.push({ ...JSON.parse(json), recordType });
		});

		return serialisedRecords;
	};

	const resetUserUpdateQueue = () => userUpdateQueue.splice(0);

	const processUserUpdates = async () => {
		if (userUpdateQueue.length === 0) return { usersProcessed: 0, updates: 0 };

		const toPublish = userUpdateQueue.splice(
			0,
			Math.min(UPDATE_MAX_PER_FLUSH, userUpdateQueue.length)
		);

		try {
			const updatesByUser = toPublish.reduce((acc, update) => {
				const userId = (update as any).user as string | undefined;
				if (userId) (acc[userId] ||= []).push(update);
				return acc;
			}, {} as Record<string, typeof toPublish>);

			if (Object.keys(updatesByUser).length) {
				await executeInPipeline((pipeline) => {
					Object.entries(updatesByUser).forEach(([userId, items]) => {
						const serialized = serializeUserUpdates(items);
						pipeline.publish(
							generateAccountUpdateKey(userId),
							JSON.stringify(serialized)
						);
					});
				});
			}

			const usersProcessed = Object.keys(updatesByUser).length;
			logger.info(
				`UserUpdate: published ${toPublish.length} updates for ${usersProcessed} users`
			);
			return { usersProcessed, updates: toPublish.length };
		} catch (error: any) {
			logger.error(`UserUpdate: publish failed: ${error?.message ?? error}`);
			userUpdateQueue.unshift(...toPublish);
			return { usersProcessed: 0, updates: 0 };
		}
	};

	const processMessage = async (message: Message) => {
		if (!message.Body) return;
		try {
			const { data = null } = JSON.parse(message.Body);
			if (!data) return;
			const record = unmarshall(data) as UserUpdateRecord;
			userUpdateQueue.push(record);
		} catch (e) {
			logger.error(`UserUpdate: failed to parse message ${message.MessageId}: ${e}`);
		}
	};

	const processBatch = async () => {
		const messages = await getMessages({ maxMessages: BATCH_SIZE });
		if (!messages || messages.length === 0) return;
		await Promise.all(messages.map((m) => processMessage(m)));
		try {
			await deleteMessages(
				messages.map((m) => ({ Id: m.MessageId!, ReceiptHandle: m.ReceiptHandle! }))
			);
		} catch (e) {
			logger.warn(`UserUpdate: deleteMessages had failures: ${e}`);
		}
	};

	const processParallelBatches = async () => {
		const tasks = Array(MAX_PARALLEL_BATCHES)
			.fill(null)
			.map(() => processBatch());
		await Promise.all(tasks);
	};

	const start = async () => {
		logger.info(`UserUpdate: starting with ${MAX_PARALLEL_BATCHES}×${BATCH_SIZE} SQS batches`);
		while (isRunning) {
			await processParallelBatches();
		}
		logger.info('UserUpdate: stopped');
	};

	const stop = async () => {
		isRunning = false;
		await processUserUpdates();
		logger.info('UserUpdate: shutdown complete');
	};

	return {
		resetUserUpdateQueue,
		processUserUpdates,
		processMessage,
		processBatch,
		processParallelBatches,
		start,
		stop,
	};
};
