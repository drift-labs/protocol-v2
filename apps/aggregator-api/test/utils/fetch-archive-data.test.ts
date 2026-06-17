import { getTimestamp, PageData, RecordTypes } from '@backend/common';
import { S3 } from '@backend/s3';
import { fetchArchiveData } from '../../src/utils/fetch-archive-data';

const mockGetRecordFileName = jest.fn();
const mockGetRecordPathName = jest.fn();
const mockGetUniqueRecords = jest.fn();

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn(),
	getRecordFileName: () => mockGetRecordFileName(),
	getRecordPathName: () => mockGetRecordPathName(),
	getUniqueRecords: () => mockGetUniqueRecords(),
}));

jest.mock('@backend/s3', () => ({
	S3: jest.fn().mockReturnValue({
		getObject: jest.fn(),
	}),
}));

describe('fetchArchiveData', () => {
	const mockGetLatestRecords = jest.fn();
	const mockGetObject = jest.fn();

	beforeEach(() => {
		jest.clearAllMocks();
		(S3 as jest.Mock)().getObject = mockGetObject;
		(getTimestamp as jest.Mock).mockReturnValue(1000000000);
	});

	it('should fetch archived data successfully', async () => {
		const archivedData: PageData<any> = {
			records: [{ id: 1 }, { id: 2 }],
			meta: {
				records: 2,
				totalRecords: 2,
				totalPages: 1,
				currentPage: 1,
				nextPage: null,
			},
		};
		mockGetObject.mockResolvedValue(JSON.stringify(archivedData));
		mockGetRecordFileName.mockReturnValue('1.json.gz');
		mockGetRecordPathName.mockReturnValue('path/to/archive');

		const result = await fetchArchiveData({
			id: 'user123',
			year: 2022,
			month: 6,
			page: 1,
			recordType: RecordTypes.TradeRecord,
			getLatestRecords: mockGetLatestRecords,
		});

		expect(result).toEqual({
			success: true,
			records: archivedData.records,
			meta: archivedData.meta,
		});
		expect(mockGetObject).toHaveBeenCalledWith('path/to/archive/1.json.gz');
	});

	it('should handle current month data', async () => {
		const archivedData: PageData<any> = {
			records: [{ id: 1 }, { id: 2 }],
			meta: {
				records: 2,
				totalRecords: 2,
				totalPages: 1,
				currentPage: 1,
				nextPage: null,
			},
		};
		mockGetObject.mockResolvedValue(JSON.stringify(archivedData));
		mockGetLatestRecords.mockResolvedValue({
			records: [{ id: 3 }],
			meta: {},
		});
		mockGetUniqueRecords.mockReturnValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

		const currentDate = new Date();
		const result = await fetchArchiveData({
			id: 'user123',
			year: currentDate.getUTCFullYear(),
			month: currentDate.getUTCMonth() + 1,
			page: 1,
			recordType: RecordTypes.TradeRecord,
			getLatestRecords: mockGetLatestRecords,
		});

		expect(result).toEqual({
			success: true,
			records: [{ id: 1 }, { id: 2 }, { id: 3 }],
			meta: {
				records: 3,
				totalRecords: 3,
				totalPages: 1,
				currentPage: 1,
				nextPage: null,
				includesLatest: true,
			},
		});
		expect(mockGetLatestRecords).toHaveBeenCalled();
		expect(mockGetUniqueRecords).toHaveBeenCalled();
	});

	it('should handle NoSuchKey error', async () => {
		mockGetObject.mockRejectedValue({ name: 'NoSuchKey' });
		mockGetLatestRecords.mockReturnValue({ records: [] });
		const result = await fetchArchiveData({
			id: 'user123',
			year: 2022,
			month: 6,
			page: 1,
			recordType: RecordTypes.TradeRecord,
			getLatestRecords: mockGetLatestRecords,
		});

		expect(result).toEqual({
			success: true,
			records: [],
			meta: {
				records: 0,
				totalRecords: 0,
				totalPages: 0,
				currentPage: 1,
				nextPage: null,
			},
		});
	});

	it('should throw other errors', async () => {
		mockGetObject.mockRejectedValue(new Error('Unknown error'));

		await expect(
			fetchArchiveData({
				id: 'user123',
				year: 2022,
				month: 6,
				page: 1,
				recordType: RecordTypes.TradeRecord,
				getLatestRecords: mockGetLatestRecords,
			})
		).rejects.toThrow('Unknown error');
	});
});
