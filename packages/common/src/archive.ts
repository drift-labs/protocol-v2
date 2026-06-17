import { DBRecord, EntityTypes, RecordTypes } from './types';

export const getRecordPathName = ({
	id,
	eventType,
	year,
	month,
	day,
	entity = EntityTypes.User,
}: {
	id: string;
	eventType: RecordTypes;
	year: number;
	month: number;
	day?: number;
	entity?: EntityTypes;
}) => {
	switch (entity) {
		case EntityTypes.Market:
			return `markets/market=${id}/eventType=${eventType}/year=${year}/month=${month}/day=${day}`;
		case EntityTypes.Authority:
			return `authority/authority=${id}/eventType=${eventType}/year=${year}/month=${month}`;
		default:
			return `users/user=${id}/eventType=${eventType}/year=${year}/month=${month}`;
	}
};

export const getRecordFileName = ({ page }: { page: number }) => {
	return `${page}.json.gz`;
};

export const getUniqueRecords = ({ records }: { records: DBRecord[] }) => {
	const uniqueRecordsMap = new Map<string, DBRecord>();

	for (const record of records) {
		const key = `${record.txSig}-${record.txSigIndex}`;
		if (!uniqueRecordsMap.has(key)) {
			uniqueRecordsMap.set(key, record);
		}
	}

	return Array.from(uniqueRecordsMap.values()).sort((a, b) => b.ts - a.ts);
};
