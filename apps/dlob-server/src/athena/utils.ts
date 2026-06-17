export const getTimePartition = (from: number, to: number) => {
	return `WITH time_range AS (
        SELECT 
            ${from} as from_ts,
            ${to} as to_ts,
            DATE_FORMAT(from_unixtime(${from}), '%Y%m%d') as from_date,
            DATE_FORMAT(from_unixtime(${to}), '%Y%m%d') as to_date
        )`;
};

export const getTimeRangeAndPartitions = (
	from: number,
	to: number,
	valid_partitions_label = 'v'
) => {
	const dates: { year: string; month: string; day: string }[] = [];
	const fromDate = new Date(from * 1000);
	const toDate = new Date(to * 1000);

	for (let d = fromDate; d <= toDate; d.setDate(d.getDate() + 1)) {
		dates.push({
			year: d.getUTCFullYear().toString(),
			month: (d.getUTCMonth() + 1).toString().padStart(2, '0'),
			day: d.getUTCDate().toString().padStart(2, '0'),
		});
	}

	return `WITH time_range AS (
		SELECT 
			${from} AS from_ts,
			${to} AS to_ts
	),

	valid_partitions AS (
		SELECT * FROM (VALUES
			${dates.map((d) => `('${d.year}', '${d.month}', '${d.day}')`).join(', ')}
		) AS ${valid_partitions_label}(year, month, day)
	)`;
};
