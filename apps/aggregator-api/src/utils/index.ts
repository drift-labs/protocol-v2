import {
	EarnSnapshotRecord,
	getTimestamp,
	getTimestampDay,
	SnapshotFrequency,
} from '@backend/common';

export const rangeForDays = (
	days: number
): {
	startTs: number;
	endTs: number;
	frequency: SnapshotFrequency;
} => {
	const startTs = getTimestampDay({ days: days * -1 });
	const endTs = getTimestamp();
	const frequency = days === 1 ? 'hourly' : 'daily';
	return { startTs, endTs, frequency };
};

export const flagInterestOutliers = (snapshots: EarnSnapshotRecord[]) => {
	const checkAssets = (snapshot: EarnSnapshotRecord) => {
		return snapshot.assets.some((asset) => {
			const absBal = Math.abs(asset.balance);
			const absInt = Math.abs(asset.interestBaseValue);
			return absBal > 1 && absInt > 0.05 * absBal;
		});
	};

	return snapshots.reduce(
		(acc, s) => {
			(checkAssets(s) ? acc.failed : acc.ok).push(s);
			return acc;
		},
		{ ok: [] as EarnSnapshotRecord[], failed: [] as EarnSnapshotRecord[] }
	);
};
