import {
	GetQueryExecutionCommand,
	GetQueryResultsCommand,
	QueryExecutionState,
	StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { DEFAULT_ATHENA_DATABASE, DEFAULT_ATHENA_OUTPUT_BUCKET, logger } from '@backend/common';
import { Athena } from '../src/client';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-athena', () => ({
	AthenaClient: jest.fn().mockImplementation(() => ({
		send: (params: any) => mockSend(params),
	})),
	StartQueryExecutionCommand: jest.fn().mockImplementation((values) => values),
	GetQueryExecutionCommand: jest.fn().mockImplementation((values) => values),
	GetQueryResultsCommand: jest.fn().mockImplementation((values) => values),
	QueryExecutionState: {
		QUEUED: 'QUEUED',
		RUNNING: 'RUNNING',
		SUCCEEDED: 'SUCCEEDED',
		FAILED: 'FAILED',
		CANCELLED: 'CANCELLED',
	},
}));

jest.mock('@backend/common', () => ({
	logger: {
		info: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
	},
	DEFAULT_ATHENA_DATABASE: 'default_database',
	DEFAULT_ATHENA_OUTPUT_BUCKET: 'default-bucket',
}));

describe('Athena', () => {
	const athenaService = Athena();
	const {
		query,
		batchQuery,
		startQuery,
		getQueryExecution,
		getQueryResults,
		getAllQueryResults,
	} = athenaService;

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('startQuery', () => {
		it('should call send with correct StartQueryExecutionCommand', async () => {
			const queryExecutionId = 'test-query-id';
			mockSend.mockResolvedValue({ QueryExecutionId: queryExecutionId });

			const result = await startQuery('SELECT * FROM test_table');

			expect(StartQueryExecutionCommand).toHaveBeenCalledWith({
				QueryString: 'SELECT * FROM test_table',
				QueryExecutionContext: {
					Database: DEFAULT_ATHENA_DATABASE,
				},
				ResultConfiguration: {
					OutputLocation: `s3://${DEFAULT_ATHENA_OUTPUT_BUCKET}/athena`,
				},
				ResultReuseConfiguration: {
					ResultReuseByAgeConfiguration: {
						Enabled: false,
					},
				},
			});
			expect(mockSend).toHaveBeenCalled();
			expect(result).toEqual(queryExecutionId);
		});

		it('should include execution parameters when provided', async () => {
			mockSend.mockResolvedValue({ QueryExecutionId: 'test-query-id' });

			await startQuery('SELECT * FROM test_table WHERE date = ?', { date: '2023-01-01' });

			expect(StartQueryExecutionCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					ExecutionParameters: ['2023-01-01'],
				})
			);
		});

		it('should throw an error if QueryExecutionId is not returned', async () => {
			mockSend.mockResolvedValue({});

			await expect(startQuery('SELECT * FROM test_table')).rejects.toThrow(
				'Failed to start query execution'
			);
		});

		it('should handle errors', async () => {
			const testError = new Error('Test error');
			mockSend.mockRejectedValue(testError);

			await expect(startQuery('SELECT * FROM test_table')).rejects.toThrow('Test error');
		});
	});

	describe('getQueryExecution', () => {
		it('should call send with correct GetQueryExecutionCommand', async () => {
			const mockExecution = { Status: { State: QueryExecutionState.SUCCEEDED } };
			mockSend.mockResolvedValue({ QueryExecution: mockExecution });

			const result = await getQueryExecution('test-query-id');

			expect(GetQueryExecutionCommand).toHaveBeenCalledWith({
				QueryExecutionId: 'test-query-id',
			});
			expect(mockSend).toHaveBeenCalled();
			expect(result).toEqual(mockExecution);
		});
	});

	describe('waitForQueryCompletion', () => {
		beforeEach(() => {
			jest.useFakeTimers();
			jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(100000);
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should resolve when query succeeds', async () => {
			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: { State: QueryExecutionState.SUCCEEDED },
					Statistics: { DataScannedInBytes: 1024 },
				},
			});

			await expect(
				athenaService.waitForQueryCompletion('test-query-id')
			).resolves.not.toThrow();

			expect(mockSend).toHaveBeenCalled();
			expect(logger.info).toHaveBeenCalledWith('Total bytes scanned: 1kb');
		});

		it('should throw error when query fails', async () => {
			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: {
						State: QueryExecutionState.FAILED,
						StateChangeReason: 'Syntax error',
					},
				},
			});

			await expect(athenaService.waitForQueryCompletion('test-query-id')).rejects.toThrow(
				'Query failed: Syntax error'
			);
		});

		it('should throw error when query is cancelled', async () => {
			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: { State: QueryExecutionState.CANCELLED },
				},
			});

			await expect(athenaService.waitForQueryCompletion('test-query-id')).rejects.toThrow(
				'Query was cancelled'
			);
		});
	});

	describe('getQueryResults', () => {
		it('should call send with correct GetQueryResultsCommand', async () => {
			const mockResults = { ResultSet: { Rows: [] } };
			mockSend.mockResolvedValue(mockResults);

			const result = await getQueryResults('test-query-id');

			expect(GetQueryResultsCommand).toHaveBeenCalledWith({
				QueryExecutionId: 'test-query-id',
				NextToken: undefined,
			});
			expect(mockSend).toHaveBeenCalled();
			expect(result).toEqual(mockResults);
		});

		it('should include nextToken when provided', async () => {
			mockSend.mockResolvedValue({});

			await getQueryResults('test-query-id', 'test-next-token');

			expect(GetQueryResultsCommand).toHaveBeenCalledWith({
				QueryExecutionId: 'test-query-id',
				NextToken: 'test-next-token',
			});
		});
	});

	describe('getAllQueryResults', () => {
		it('should fetch all pages of results', async () => {
			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [
						{ Data: [{ VarCharValue: 'id' }, { VarCharValue: 'name' }] },
						{ Data: [{ VarCharValue: '1' }, { VarCharValue: 'Alice' }] },
					],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'id' }, { Name: 'name' }],
					},
				},
				NextToken: 'test-next-token',
			});

			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [{ Data: [{ VarCharValue: '2' }, { VarCharValue: 'Bob' }] }],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'id' }, { Name: 'name' }],
					},
				},
			});

			const results = await getAllQueryResults('test-query-id');

			expect(GetQueryResultsCommand).toHaveBeenCalledTimes(2);
			expect(GetQueryResultsCommand).toHaveBeenNthCalledWith(1, {
				QueryExecutionId: 'test-query-id',
				NextToken: undefined,
			});
			expect(GetQueryResultsCommand).toHaveBeenNthCalledWith(2, {
				QueryExecutionId: 'test-query-id',
				NextToken: 'test-next-token',
			});

			expect(results).toEqual([
				{ id: '1', name: 'Alice' },
				{ id: '2', name: 'Bob' },
			]);
		});

		it('should handle null values correctly', async () => {
			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [
						{ Data: [{ VarCharValue: 'id' }, { VarCharValue: 'name' }] },
						{ Data: [{ VarCharValue: '1' }, {}] },
					],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'id' }, { Name: 'name' }],
					},
				},
			});

			const results = await getAllQueryResults('test-query-id');

			expect(results).toEqual([{ id: '1', name: null }]);
		});

		it('should handle errors', async () => {
			const testError = new Error('Test error');
			mockSend.mockRejectedValue(testError);

			await expect(getAllQueryResults('test-query-id')).rejects.toThrow('Test error');
		});
	});

	describe('query', () => {
		it('should execute a complete query workflow', async () => {
			mockSend.mockResolvedValueOnce({ QueryExecutionId: 'test-query-id' });

			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: { State: QueryExecutionState.SUCCEEDED },
					Statistics: { DataScannedInBytes: 1024 },
				},
			});

			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [
						{ Data: [{ VarCharValue: 'id' }, { VarCharValue: 'name' }] },
						{ Data: [{ VarCharValue: '1' }, { VarCharValue: 'Alice' }] },
					],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'id' }, { Name: 'name' }],
					},
				},
			});

			const results = await query('SELECT * FROM test_table');

			expect(results).toEqual([{ id: '1', name: 'Alice' }]);

			expect(StartQueryExecutionCommand).toHaveBeenCalled();
			expect(GetQueryExecutionCommand).toHaveBeenCalled();
			expect(GetQueryResultsCommand).toHaveBeenCalled();
		});

		it('should pass params to query when provided', async () => {
			mockSend.mockResolvedValueOnce({ QueryExecutionId: 'test-query-id' });
			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: { State: QueryExecutionState.SUCCEEDED },
				},
			});
			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [
						{ Data: [{ VarCharValue: 'count' }] },
						{ Data: [{ VarCharValue: '5' }] },
					],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'count' }],
					},
				},
			});

			await query('SELECT * FROM test_table WHERE date = ?', { date: '2023-01-01' });

			expect(StartQueryExecutionCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					ExecutionParameters: ['2023-01-01'],
				})
			);
		});

		it('should log and throw error on failure', async () => {
			const error = new Error('Test error');
			mockSend.mockRejectedValue(error);

			await expect(query('SELECT * FROM test_table')).rejects.toThrow('Test error');

			expect(logger.error).toHaveBeenCalled();
		});
	});

	describe('batchQuery', () => {
		it('should execute multiple queries in parallel', async () => {
			mockSend.mockResolvedValueOnce({ QueryExecutionId: 'query-id-1' });
			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: { State: QueryExecutionState.SUCCEEDED },
				},
			});
			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [{ Data: [{ VarCharValue: 'id' }] }, { Data: [{ VarCharValue: '1' }] }],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'id' }],
					},
				},
			});

			mockSend.mockResolvedValueOnce({ QueryExecutionId: 'query-id-2' });
			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: { State: QueryExecutionState.SUCCEEDED },
				},
			});
			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [
						{ Data: [{ VarCharValue: 'name' }] },
						{ Data: [{ VarCharValue: 'Alice' }] },
					],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'name' }],
					},
				},
			});

			const { results, errors } = await batchQuery({
				queries: [{ query: 'SELECT id FROM table1' }, { query: 'SELECT name FROM table2' }],
			});

			expect(results).toHaveLength(2);
			expect(results[0]).toEqual([{ id: '1' }]);
			expect(results[1]).toEqual([{ name: 'Alice' }]);
			expect(errors).toEqual([]);
		});

		it('should handle errors in batch queries', async () => {
			mockSend.mockResolvedValueOnce({ QueryExecutionId: 'query-id-1' });
			mockSend.mockResolvedValueOnce({
				QueryExecution: {
					Status: { State: QueryExecutionState.SUCCEEDED },
				},
			});
			mockSend.mockResolvedValueOnce({
				ResultSet: {
					Rows: [{ Data: [{ VarCharValue: 'id' }] }, { Data: [{ VarCharValue: '1' }] }],
					ResultSetMetadata: {
						ColumnInfo: [{ Name: 'id' }],
					},
				},
			});

			mockSend.mockResolvedValueOnce({ QueryExecutionId: 'query-id-2' });
			const error = new Error('Query failed');
			mockSend.mockRejectedValueOnce(error);

			const { results, errors } = await batchQuery({
				queries: [{ query: 'SELECT id FROM table1' }, { query: 'SELECT name FROM table2' }],
			});

			expect(results[0]).toEqual([{ id: '1' }]);
			expect(results[1]).toBeUndefined();
			expect(errors).toContain(error);
		});
	});
});
