import {
	AthenaClient,
	ColumnInfo,
	GetQueryExecutionCommand,
	GetQueryResultsCommand,
	GetQueryResultsCommandOutput,
	QueryExecutionState,
	Row,
	StartQueryExecutionCommand,
	StartQueryExecutionCommandInput,
} from '@aws-sdk/client-athena';
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';
import Bottleneck from 'bottleneck';
import { logger } from '../utils/logger';

const QUERY_TIMEOUT = 300000;
const POLL_INTERVAL = 1000;

const DEFAULT_ATHENA_DATABASE = 'staging-archive';
const DEFAULT_ATHENA_OUTPUT_BUCKET = 'staging-data-ingestion-bucket';

const limiter = new Bottleneck({
	maxConcurrent: 5,
	minTime: 100,
});

type QueryResult = Record<string, string | null>;

const parseRow = (row: Row, columnInfo: ColumnInfo[]): QueryResult => {
	const rowData = row.Data;
	if (!rowData) {
		return {};
	}

	return columnInfo.reduce((acc: QueryResult, column, index) => {
		if (column.Name) {
			acc[column.Name] = rowData[index]?.VarCharValue ?? null;
		}
		return acc;
	}, {});
};

const athena = new AthenaClient({
	region: process.env.AWS_REGION,
	retryStrategy: new ConfiguredRetryStrategy(
		3,
		(attempt: number) => 100 + attempt * 1000
	),
});

export const Athena = ({
	overrideDatabaseName,
	overrideBucketName,
}: { overrideDatabaseName?: string; overrideBucketName?: string } = {}) => {
	const database =
		overrideDatabaseName ??
		process.env.ATHENA_DATABASE ??
		DEFAULT_ATHENA_DATABASE;
	const outputLocation = `s3://${
		overrideBucketName ??
		process.env.ATHENA_OUTPUT_BUCKET ??
		DEFAULT_ATHENA_OUTPUT_BUCKET
	}/athena`;

	const startQuery = async (query: string, params?: Record<string, string>) => {
		const executionParams: StartQueryExecutionCommandInput = {
			QueryString: query,
			QueryExecutionContext: {
				Database: database,
			},
			ResultConfiguration: {
				OutputLocation: outputLocation,
			},
			ResultReuseConfiguration: {
				ResultReuseByAgeConfiguration: {
					Enabled: false,
				},
			},
		};

		if (params) {
			executionParams.ExecutionParameters = Object.values(params);
		}

		const { QueryExecutionId } = await athena.send(
			new StartQueryExecutionCommand(executionParams)
		);

		if (!QueryExecutionId) {
			throw new Error('Failed to start query execution');
		}

		return QueryExecutionId;
	};

	const getQueryExecution = async (queryExecutionId: string) => {
		const { QueryExecution } = await athena.send(
			new GetQueryExecutionCommand({
				QueryExecutionId: queryExecutionId,
			})
		);

		return QueryExecution;
	};

	const waitForQueryCompletion = async (
		queryExecutionId: string,
		timeout: number = QUERY_TIMEOUT
	): Promise<void> => {
		const startTime = Date.now();

		while (Date.now() - startTime < timeout) {
			const execution = await getQueryExecution(queryExecutionId);
			logger.info(
				`Total bytes scanned: ${
					(execution?.Statistics?.DataScannedInBytes ?? 0) / 1024
				}kb`
			);
			const state = execution?.Status?.State;

			switch (state) {
				case QueryExecutionState.SUCCEEDED:
					return;
				case QueryExecutionState.FAILED:
					throw new Error(
						`Query failed: ${execution?.Status?.StateChangeReason}`
					);
				case QueryExecutionState.CANCELLED:
					throw new Error('Query was cancelled');
				default:
					await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
			}
		}

		throw new Error(`Query timeout after ${timeout}ms`);
	};

	const getQueryResults = async (
		queryExecutionId: string,
		nextToken?: string
	): Promise<GetQueryResultsCommandOutput> => {
		return athena.send(
			new GetQueryResultsCommand({
				QueryExecutionId: queryExecutionId,
				NextToken: nextToken,
			})
		);
	};

	const getAllQueryResults = async (
		queryExecutionId: string
	): Promise<QueryResult[]> => {
		let nextToken: string | undefined;
		const allResults: QueryResult[] = [];

		do {
			const results = await getQueryResults(queryExecutionId, nextToken);
			if (
				results.ResultSet?.Rows &&
				results.ResultSet.ResultSetMetadata?.ColumnInfo
			) {
				const columnInfo = results.ResultSet.ResultSetMetadata.ColumnInfo;
				const rows = nextToken
					? results.ResultSet.Rows
					: results.ResultSet.Rows.slice(1);
				const parsedRows = rows.map((row) => parseRow(row, columnInfo));
				allResults.push(...parsedRows);
			}

			nextToken = results.NextToken;
		} while (nextToken);

		return allResults;
	};

	const query = async (
		queryString: string,
		params?: Record<string, string>
	): Promise<QueryResult[]> => {
		try {
			const queryExecutionId = await startQuery(queryString, params);
			await waitForQueryCompletion(queryExecutionId);
			return getAllQueryResults(queryExecutionId);
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error executing Athena query: ${message}`);
			throw error;
		}
	};

	const batchQuery = async ({
		queries,
	}: {
		queries: { query: string; params?: Record<string, string> }[];
	}): Promise<{
		results: QueryResult[][];
		errors: Error[];
	}> => {
		const results: QueryResult[][] = [];
		const errors: Error[] = [];

		await Promise.all(
			queries.map(async ({ query: queryString, params }, index) => {
				try {
					const result = await limiter.schedule(() =>
						query(queryString, params)
					);
					results[index] = result;
				} catch (error) {
					logger.error(
						`Error in batch query ${index}: ${queryString}, Error: ${error}`
					);
					errors[index] = error as Error;
				}
			})
		);

		if (errors.length > 0) {
			logger.warn(`${errors.length} queries failed in batch execution`);
		}

		return {
			results,
			errors,
		};
	};

	return {
		query,
		batchQuery,
		startQuery,
		getQueryExecution,
		getQueryResults,
		getAllQueryResults,
		waitForQueryCompletion,
	};
};
