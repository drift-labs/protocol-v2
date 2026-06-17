import { getTimeRangeAndPartitions } from '../src/utils';

describe('getTimeRangeAndPartitions', () => {
	it('should generate correct time range and partitions SQL', () => {
		const from = 1672531200; // 2023-01-01 00:00:00
		const to = 1672704000; // 2023-01-03 00:00:00

		const expected = `WITH time_range AS (
		SELECT 
			1672531200 AS from_ts,
			1672704000 AS to_ts
	),

	valid_partitions AS (
		SELECT * FROM (VALUES
			('2023', '01', '01'),
			('2023', '01', '02'),
			('2023', '01', '03')
		) AS v(year, month, day)
	)`;

		const result = getTimeRangeAndPartitions(from, to);
		expect(result.replace(/\s+/g, ' ')).toEqual(expected.replace(/\s+/g, ' '));
	});

	it('should handle single day range different day', () => {
		const from = 1672531200; // 2023-01-01 00:00:00
		const to = 1672617600; // 2023-01-02 00:00:00

		const expected = `WITH time_range AS (
		SELECT 
			1672531200 AS from_ts,
			1672617600 AS to_ts
	),

	valid_partitions AS (
		SELECT * FROM (VALUES
			('2023', '01', '01'),
			('2023', '01', '02')
		) AS v(year, month, day)
	)`;

		const result = getTimeRangeAndPartitions(from, to);
		expect(result.replace(/\s+/g, ' ')).toEqual(expected.replace(/\s+/g, ' '));
	});

	it('should handle single day range same day', () => {
		const from = 1672531200; // 2023-01-01 00:00:00
		const to = 1672617599; // 2023-01-01 23:59:59

		const expected = `WITH time_range AS (
		SELECT 
			1672531200 AS from_ts,
			1672617599 AS to_ts
	),

	valid_partitions AS (
		SELECT * FROM (VALUES
			('2023', '01', '01')
		) AS v(year, month, day)
	)`;

		const result = getTimeRangeAndPartitions(from, to);
		expect(result.replace(/\s+/g, ' ')).toEqual(expected.replace(/\s+/g, ' '));
	});
});
