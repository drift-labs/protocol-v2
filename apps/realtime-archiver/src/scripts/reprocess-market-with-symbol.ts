import { logger } from '@backend/common';
import { DynamoDB, RealTimeArchiverRepository } from '@backend/dynamodb';

const { createFailedSlotRecords } = RealTimeArchiverRepository();
const { queryAll, batchRemove } = DynamoDB({ overrideTableName: 'mainnet-beta-record-db' });

async function main() {
	try {
		const unknownMarkets = await queryAll({
			pk: 'MARKET#NA',
			expression: 'pk = :pk',
			expressionValues: { ':pk': 'MARKET#NA' },
		});

		const uniqueSlots = new Set<number>();

		unknownMarkets.forEach((record) => {
			if (record.slot !== undefined) {
				uniqueSlots.add(record.slot);
			}
		});

		const failedSlotArray = [...uniqueSlots];
		await logger.error(`Failed slots: ${failedSlotArray.join(', ')}`);
		await createFailedSlotRecords(failedSlotArray);
		await batchRemove({
			records: unknownMarkets.map((record) => ({ pk: record.pk, sk: record.sk })),
		});
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Script failed: ${message}`);
		process.exit(1);
	}
}

main();
