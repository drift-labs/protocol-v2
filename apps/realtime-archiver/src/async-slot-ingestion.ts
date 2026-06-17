import {
	DEFAULT_ENDPOINT,
	IngestionState,
	isFeatureEnabled,
	logger,
	SlotStatus,
} from '@backend/common';
import { RealTimeArchiverRepository } from '@backend/dynamodb';
import { getVaultClient } from '@velocity-exchange/vaults-sdk';
import { Connection, Keypair } from '@solana/web3.js';
import { VelocityClient, VelocityEnv, Wallet } from '@velocity-exchange/sdk';
import { SQSEvent, SQSRecord } from 'aws-lambda';
import Bottleneck from 'bottleneck';
import { Ingestion } from './services/ingestion';

const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'finalized');
const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;
const wallet = new Wallet(new Keypair());

const driftClient = new VelocityClient({
	env: driftEnv,
	connection,
	wallet,
});

const vaultClient = getVaultClient(connection, wallet, driftClient);

const defaultState: IngestionState = {
	id: 'primary',
	currentSlot: 0,
	shards: 1,
	shardId: 0,
	paused: true,
	ingestedSlots: [],
	bypassSlots: [],
	skippedSlots: [],
	failedSlots: [],
	missedSlots: [],
};

const limiter = new Bottleneck({
	maxConcurrent: 10,
});

export const handler = async (event: SQSEvent) => {
	const reportBatchItemFailures = isFeatureEnabled('REPORT_BATCH_ITEM_FAILURES', false);

	const { processSlotWithBackoff, shutdown } = Ingestion({
		state: defaultState,
		driftClient,
		vaultClient,
		connection,
	});

	const { deleteMissedSlotRecord, deleteFailedSlotRecord } = RealTimeArchiverRepository();

	const batchItemFailures: { itemIdentifier: string }[] = [];

	const processRecord = async (record: SQSRecord) => {
		const body = JSON.parse(record.body);
		logger.info(`Processing ${body.status} slot: ${body.slot}`);
		try {
			const processed = await processSlotWithBackoff(body.slot);
			if (reportBatchItemFailures && !processed) {
				batchItemFailures.push({ itemIdentifier: record.messageId });
				return;
			}

			if (body.status === SlotStatus.FAILED) {
				await deleteFailedSlotRecord(body.slot);
			} else {
				await deleteMissedSlotRecord(body.slot);
			}
			logger.info(`Successfully ingested slot: ${body.slot}`);
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error async ingestion for slot ${body.slot}: ${message}`);
			batchItemFailures.push({ itemIdentifier: record.messageId });
		}
	};

	try {
		await Promise.all(
			event.Records.map((record) => limiter.schedule(() => processRecord(record)))
		);
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Error processing records: ${message}`);
		await shutdown({ syncState: false, skipOffloadRetrySlots: reportBatchItemFailures });
		throw error;
	}

	await shutdown({ syncState: false, skipOffloadRetrySlots: reportBatchItemFailures });

	logger.info(`Successfully processed batch`);

	return reportBatchItemFailures ? { batchItemFailures } : true;
};
