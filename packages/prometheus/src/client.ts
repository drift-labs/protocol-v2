import { DEFAULT_PROM_URL, logger } from '@backend/common';
import { escape } from 'querystring';
import { request } from 'undici';
import { PrometheusRangeQueryParams, PrometheusRangeQueryResponse } from './types';

export const Prometheus = ({
	overrideUrl,
}: {
	overrideUrl?: string;
} = {}) => {
	const baseUrl = overrideUrl ?? process.env.PROM_URL ?? DEFAULT_PROM_URL;

	const retryConfig = {
		maxRetries: 3,
		initialDelayMs: 100,
		maxDelayMs: 5000,
		backoffFactor: 2,
	};

	const httpConfig = {
		headersTimeout: 30000,
		bodyTimeout: 30000,
	};

	const retryWithBackoff = async ({
		fn,
		retries = retryConfig.maxRetries,
		delay = retryConfig.initialDelayMs,
	}: {
		fn: () => Promise<any>;
		retries?: number;
		delay?: number;
	}): Promise<any> => {
		try {
			return await fn();
		} catch (error) {
			if (retries <= 0) {
				throw error;
			}
			logger.warn(
				`Prometheus request failed, retrying in ${delay}ms. Error: ${error.message}`
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
			const nextDelay = Math.min(delay * retryConfig.backoffFactor, retryConfig.maxDelayMs);
			return retryWithBackoff({ fn, retries: retries - 1, delay: nextDelay });
		}
	};

	const fetchRangeData = async ({
		query,
		start,
		end,
		step,
	}: PrometheusRangeQueryParams): Promise<Array<[number, string]>> => {
		const url = `${baseUrl}/api/v1/query_range?query=${escape(
			query
		)}&start=${start}&end=${end}&step=${step}`;

		try {
			return retryWithBackoff({
				fn: async () => {
					const { statusCode, body } = await request(url, {
						method: 'GET',
						...httpConfig,
					});

					if (statusCode !== 200) {
						const errorText = await body.text();
						throw new Error(`Prometheus API returned ${statusCode}: ${errorText}`);
					}

					const jsonResponse = (await body.json()) as PrometheusRangeQueryResponse;

					if (jsonResponse.status === 'error') {
						throw new Error(
							`Prometheus error: ${jsonResponse.error || 'Unknown error'}`
						);
					}

					return (
						jsonResponse.data?.result[0]?.values?.map((val) =>
							val[1]?.includes('e') ? [val[0], '0'] : val
						) ?? []
					);
				},
			});
		} catch (error) {
			logger.error(`Error fetching Prometheus range data: ${error.message}`);
			throw error;
		}
	};

	return {
		fetchRangeData,
	};
};
