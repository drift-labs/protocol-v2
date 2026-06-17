import { DEFAULT_ENDPOINT, logger } from '@backend/common';
import { RealTimeArchiverRepository } from '@backend/dynamodb';
import { Connection } from '@solana/web3.js';

const SLOT_DIFFERENCE = process.env.SLOT_DIFFERENCE ? parseInt(process.env.SLOT_DIFFERENCE) : 1000;

export const handler = async () => {
	const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'finalized');

	const {
		getCheckpointSlot,
		getIngestedSlots,
		createMissedSlotRecords,
		deleteIngestedSlots,
		updateCheckpoint,
	} = RealTimeArchiverRepository();

	try {
		const checkpoint = await getCheckpointSlot();
		logger.info(`Last checkpoint slot: ${checkpoint}`);

		if (!checkpoint) {
			throw Error('No checkpoint found');
		}

		const latestSlot = await connection.getSlot('finalized');
		logger.info(`Latest blockchain slot: ${latestSlot}`);

		const targetSlot = Math.max(checkpoint, latestSlot - SLOT_DIFFERENCE);
		logger.info(`Checking slots between ${checkpoint} and ${targetSlot}`);

		const ingestedSlots = await getIngestedSlots(targetSlot);
		const ingestedSlotNumbers = new Set(ingestedSlots.map((item) => item.slot));

		const missingSlots: number[] = [];
		for (let slot = checkpoint + 1; slot <= targetSlot; slot++) {
			if (!ingestedSlotNumbers.has(slot)) {
				missingSlots.push(slot);
			}
		}

		if (missingSlots.length > 0) {
			logger.warn(
				`Found ${missingSlots.length} missing slots: ${JSON.stringify(missingSlots)}`,
				true
			);
			await createMissedSlotRecords(missingSlots);
		}

		if (ingestedSlots.length > 0) {
			await deleteIngestedSlots(Array.from(ingestedSlotNumbers));
		}

		await updateCheckpoint(targetSlot);

		logger.info(`Successfully verified slots up to ${targetSlot}`);

		return {
			statusCode: 200,
			body: JSON.stringify({
				message: 'Success',
				checkpointSlot: targetSlot,
				missingSlots: missingSlots.length,
			}),
		};
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Error verifying slots: ${message}`);
		throw error;
	}
};
