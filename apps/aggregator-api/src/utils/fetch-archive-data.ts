import {
	EntityTypes,
	getRecordFileName,
	getRecordPathName,
	getTimestamp,
	getUniqueRecords,
	PageData,
	RecordTypes,
} from '@backend/common';
import { S3 } from '@backend/s3';

export const fetchArchiveData = async <T extends { [key: string]: any }>({
	id,
	year,
	month,
	page,
	recordType,
	entity = EntityTypes.User,
	day = undefined,
	bucket,
	getLatestRecords,
}: {
	id: string;
	year: number;
	month: number;
	page: number;
	recordType: RecordTypes;
	entity?: EntityTypes;
	day?: number;
	bucket?: string;
	getLatestRecords: ({
		id,
		startTs,
		endTs,
		entity,
	}: {
		id: string;
		startTs: number;
		endTs: number;
		entity?: EntityTypes;
	}) => Promise<{ records: T[]; meta: { nextPage: Record<string, any> | null } }>;
}) => {
	const { getObject } = S3({ overrideBucketName: bucket });

	const currentDate = new Date();
	const currentUTC = {
		year: currentDate.getUTCFullYear(),
		month: currentDate.getUTCMonth() + 1,
		day: currentDate.getUTCDate(),
	};

	const isCurrentYear = currentUTC.year === year;
	const isCurrentMonth = currentUTC.year === year && currentUTC.month === month;
	const isCurrentDay = day === undefined || currentUTC.day === day;
	const shouldFetchLatest = isCurrentYear && isCurrentMonth && isCurrentDay && page === 1;

	const key = getRecordPathName({
		id,
		entity,
		eventType: recordType,
		year,
		month,
		day,
	});

	const file = getRecordFileName({ page });

	const getLatestFromDB = async () => {
		const { records: latestRecords } = await getLatestRecords({
			id,
			startTs: getTimestamp({ minutes: -10 }),
			endTs: getTimestamp(),
			entity,
		});

		return latestRecords;
	};

	let archivedData: PageData<T>;
	try {
		const archiveContent = await getObject(`${key}/${file}`);
		archivedData = JSON.parse(archiveContent);
	} catch (error) {
		const { name } = error as Error;
		if (name == 'NoSuchKey') {
			if (shouldFetchLatest) {
				const latestRecords = await getLatestFromDB();

				if (latestRecords.length) {
					const mergedRecords = getUniqueRecords({ records: latestRecords as any });
					const newRecordsCount = mergedRecords.length;

					return {
						success: true,
						records: mergedRecords,
						meta: {
							records: newRecordsCount,
							totalRecords: newRecordsCount,
							totalPages: 1,
							currentPage: 1,
							nextPage: null,
						},
					};
				}
			}

			return {
				success: true,
				records: [],
				meta: {
					records: 0,
					totalRecords: 0,
					totalPages: 0,
					currentPage: page,
					nextPage: null,
				},
			};
		}

		throw error;
	}

	if (shouldFetchLatest) {
		const latestRecords = await getLatestFromDB();

		const allRecords = [...archivedData.records, ...latestRecords] as any; // TODO fix type
		const mergedRecords = getUniqueRecords({ records: allRecords });

		const newRecordsCount = mergedRecords.length - archivedData.meta.records;

		return {
			success: true,
			records: mergedRecords,
			meta: {
				...archivedData.meta,
				records: mergedRecords.length,
				totalRecords: archivedData.meta.totalRecords + newRecordsCount,
				includesLatest: true,
			},
		};
	} else {
		return {
			success: true,
			records: archivedData.records,
			meta: archivedData.meta,
		};
	}
};
