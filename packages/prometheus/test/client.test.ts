import { request } from 'undici';
import { Prometheus } from '../src/client';
import { PrometheusRangeQueryResponse } from '../src/types';

jest.mock('undici');
jest.mock('@backend/common', () => ({
	DEFAULT_PROM_URL: 'http://default-prometheus:9090',
	logger: {
		warn: jest.fn(),
		error: jest.fn(),
	},
}));

describe('Prometheus Client', () => {
	const mockRequestFn = request as jest.MockedFunction<typeof request>;

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('fetchRangeData', () => {
		const mockParams = {
			query: 'test_query',
			start: 1746000256,
			end: 1746004256,
			step: 1000,
		};

		const mockSuccessResponse: PrometheusRangeQueryResponse = {
			status: 'success',
			data: {
				resultType: 'matrix',
				result: [
					{
						metric: { name: 'test_metric' },
						values: [
							[1672531200, '100'],
							[1672534800, '1.23e-10'],
							[1672538400, '200'],
						],
					},
				],
			},
		};

		const { fetchRangeData } = Prometheus();

		it('should fetch data successfully and filter small values', async () => {
			const mockBodyJson = jest.fn().mockResolvedValue(mockSuccessResponse);
			mockRequestFn.mockResolvedValue({
				statusCode: 200,
				body: {
					json: mockBodyJson,
					text: jest.fn(),
				},
			} as any);

			const result = await fetchRangeData(mockParams);

			expect(result).toEqual([
				[1672531200, '100'],
				[1672534800, '0'],
				[1672538400, '200'],
			]);

			expect(mockRequestFn).toHaveBeenCalledWith(
				expect.stringContaining(
					'http://default-prometheus:9090/api/v1/query_range?query=test_query'
				),
				expect.objectContaining({
					method: 'GET',
					headersTimeout: 30000,
					bodyTimeout: 30000,
				})
			);
		});

		it('should handle HTTP errors from Prometheus API', async () => {
			const mockBodyText = jest.fn().mockResolvedValue('Bad query');
			mockRequestFn.mockResolvedValue({
				statusCode: 400,
				body: {
					text: mockBodyText,
					json: jest.fn(),
				},
			} as any);

			try {
				await fetchRangeData(mockParams);
				fail('Expected function to throw but it did not');
			} catch (error) {
				expect((error as Error).message).toContain('Prometheus API returned 400');
			}
		});

		it('should handle error status in Prometheus response', async () => {
			const errorResponse: PrometheusRangeQueryResponse = {
				status: 'error',
				error: 'Invalid query',
				errorType: 'bad_data',
			};

			mockRequestFn.mockResolvedValue({
				statusCode: 200,
				body: {
					json: jest.fn().mockResolvedValue(errorResponse),
					text: jest.fn(),
				},
			} as any);

			await expect(fetchRangeData(mockParams)).rejects.toThrow(
				'Prometheus error: Invalid query'
			);
		});

		it('should return empty array if no results', async () => {
			const emptyResponse: PrometheusRangeQueryResponse = {
				status: 'success',
				data: {
					resultType: 'matrix',
					result: [],
				},
			};

			mockRequestFn.mockResolvedValue({
				statusCode: 200,
				body: {
					json: jest.fn().mockResolvedValue(emptyResponse),
					text: jest.fn(),
				},
			} as any);

			const result = await fetchRangeData(mockParams);
			expect(result).toEqual([]);
		});

		it('should retry on temporary failures', async () => {
			mockRequestFn.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
				statusCode: 200,
				body: {
					json: jest.fn().mockResolvedValue(mockSuccessResponse),
					text: jest.fn(),
				},
			} as any);

			const resultPromise = fetchRangeData(mockParams);

			const result = await resultPromise;

			expect(mockRequestFn).toHaveBeenCalledTimes(2);

			expect(result).toEqual([
				[1672531200, '100'],
				[1672534800, '0'],
				[1672538400, '200'],
			]);
		});

		it('should exhaust retries and throw after max attempts', async () => {
			const networkError = new Error('Network error');
			mockRequestFn.mockRejectedValue(networkError);
			const resultPromise = fetchRangeData(mockParams);
			await expect(resultPromise).rejects.toThrow('Network error');
			expect(mockRequestFn).toHaveBeenCalledTimes(4);
		});
	});
});
