import { main } from '../src/archiver';

const mockProcess = jest
	.fn()
	.mockImplementation(async (prefix: string, processedPrefix: string, processor: any) => {
		await processor(
			'content',
			'unprocessed/eventType=TestEvent/year=2023/month=06/day=01/file.json.gz'
		);
		throw Error('done');
	});
jest.mock('@backend/s3', () => ({
	S3: () => ({
		processFiles: mockProcess,
	}),
}));

const mockGetRecords = jest.fn().mockImplementation(() => ['record1', 'record2']);
const mockSortRecords = jest.fn().mockImplementation(() => {
	return {
		user: { user1: ['record1'], user2: ['record2'] },
		authority: {},
		market: { sol: ['record3'] },
	};
});
const mockProcessType = jest.fn();
const mockDestructureKey = jest
	.fn()
	.mockImplementation(() => ({ eventType: 'TestEvent', year: 2023, month: 6, day: 1 }));

const mockGetRecordPath = jest.fn().mockImplementation(() => 'mock-path');

jest.mock('../src/services/archive', () => ({
	Archiver: () => {
		return {
			getRecords: mockGetRecords,
			sortRecords: mockSortRecords,
			processType: mockProcessType,
			destructureKey: mockDestructureKey,
			getRecordPathName: mockGetRecordPath,
		};
	},
}));

jest.mock('../src/services/health');

describe('Archiver', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should process files continuously', async () => {
		await expect(main()).rejects.toThrow();

		expect(mockProcess).toHaveBeenCalledWith(
			'unprocessed/source=seq',
			'processed_files/source=seq',
			expect.any(Function)
		);

		expect(mockGetRecords).toHaveBeenCalledWith({ content: 'content' });

		expect(mockSortRecords).toHaveBeenCalledWith({
			records: ['record1', 'record2'],
		});

		expect(mockProcessType).toHaveBeenCalledTimes(3);

		expect(mockProcessType).toHaveBeenCalledWith({
			key: 'mock-path',
			records: ['record1'],
		});
		expect(mockProcessType).toHaveBeenCalledWith({
			key: 'mock-path',
			records: ['record2'],
		});
		expect(mockProcessType).toHaveBeenCalledWith({
			key: 'mock-path',
			records: ['record3'],
		});
	});
});
