import {
	DEFAULT_STATE_TABLE,
	IngestionState,
	SlotStatus,
	getTimestamp,
	logger,
} from '@backend/common';
import { DynamoDB } from '..';

export const INGESTOR_PK = 'INGESTOR';
export const MISSED_PK = 'MISSED';
export const SKIPPED_PK = 'SKIPPED';
export const FAILED_PK = 'FAILED';
export const CHECKPOINT_PK = 'CHECKPOINT';
export const INGESTED_PK = 'INGESTED';

export const RealTimeArchiverRepository = () => {
	const { get, put, batchWrite, batchRemove, remove, queryAll } = DynamoDB({
		overrideTableName: process.env.STATE_TABLE ?? DEFAULT_STATE_TABLE,
	});

	const getState = async ({ id }: { id: string }): Promise<IngestionState | undefined> => {
		const pk = `${INGESTOR_PK}#${id}`;
		const sk = `${INGESTOR_PK}#${id}`;
		const { Item } = await get({ pk, sk });
		return Item as IngestionState | undefined;
	};

	const updateState = async ({ state }: { state: IngestionState }): Promise<IngestionState> => {
		await put({ record: state });
		return state;
	};

	const createSkippedSlotRecords = async (slots: number[]) => {
		const records = slots.map((slot) => ({
			pk: SKIPPED_PK,
			sk: `SLOT#${slot}`,
			slot: slot,
			status: SlotStatus.SKIPPED,
			createdAt: getTimestamp(),
			ttl: getTimestamp({ days: 90 }),
		}));

		return batchWrite({ records });
	};

	const createMissedSlotRecords = async (slots: number[]) => {
		const records = slots.map((slot) => ({
			pk: MISSED_PK,
			sk: `SLOT#${slot}`,
			slot: slot,
			status: SlotStatus.MISSED,
			createdAt: getTimestamp(),
		}));

		return batchWrite({ records });
	};

	const createFailedSlotRecords = async (slots: number[]) => {
		const records = slots.map((slot) => ({
			pk: FAILED_PK,
			sk: `SLOT#${slot}`,
			slot: slot,
			status: SlotStatus.FAILED,
			createdAt: getTimestamp(),
		}));

		return batchWrite({ records });
	};

	const createIngestedSlotRecords = async (slots: number[]) => {
		const records = slots.map((slot) => ({
			pk: INGESTED_PK,
			sk: `SLOT#${slot}`,
			slot: slot,
			status: SlotStatus.INGESTED,
			createdAt: getTimestamp(),
		}));

		return batchWrite({ records });
	};

	const deleteMissedSlotRecord = async (slot: number) => {
		return remove({ pk: MISSED_PK, sk: `SLOT#${slot}` });
	};

	const deleteFailedSlotRecord = async (slot: number) => {
		return remove({ pk: FAILED_PK, sk: `SLOT#${slot}` });
	};

	const getCheckpointSlot = async (): Promise<number> => {
		const { Item } = await get({
			pk: CHECKPOINT_PK,
			sk: CHECKPOINT_PK,
		});

		return Item?.lastProcessedSlot || 0;
	};

	const updateCheckpoint = async (slot: number): Promise<void> => {
		await put({
			record: {
				pk: CHECKPOINT_PK,
				sk: CHECKPOINT_PK,
				lastProcessedSlot: slot,
				createdAt: getTimestamp(),
			},
		});
	};

	const getIngestedSlots = async (targetSlot: number) => {
		const records = await queryAll({
			pk: INGESTED_PK,
			sk: `SLOT#${targetSlot}`,
			expression: 'pk = :pk and sk <= :sk',
		});

		return records || [];
	};

	const deleteIngestedSlots = async (slots: number[]) => {
		const records = slots.map((slot) => ({
			pk: INGESTED_PK,
			sk: `SLOT#${slot}`,
		}));

		const failedItems = await batchRemove({ records });

		if (failedItems.length > 0) {
			logger.warn(`Failed to delete ${failedItems.length} ingested slot records`);
			for (const item of failedItems) {
				try {
					await remove({
						pk: item.pk as string,
						sk: item.sk as string,
					});
				} catch (error) {
					logger.error(`Failed to delete individual record: ${JSON.stringify(item)}`);
				}
			}
		}
	};

	return {
		getState,
		updateState,
		createSkippedSlotRecords,
		createMissedSlotRecords,
		createFailedSlotRecords,
		createIngestedSlotRecords,
		deleteMissedSlotRecord,
		deleteFailedSlotRecord,
		getCheckpointSlot,
		updateCheckpoint,
		getIngestedSlots,
		deleteIngestedSlots,
	};
};
