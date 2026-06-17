export interface PrometheusResponse<T> {
	status: 'success' | 'error';
	data?: T;
	errorType?: string;
	error?: string;
	warnings?: string[];
}

export interface InstantQueryData {
	resultType: 'vector' | 'scalar' | 'matrix' | 'string';
	result: InstantQueryResult[];
}

export interface InstantQueryResult {
	metric: {
		[key: string]: string;
	};
	value: [number, string];
}

export interface RangeQueryData {
	resultType: 'matrix';
	result: RangeQueryResult[];
}

export interface RangeQueryResult {
	metric: {
		[key: string]: string;
	};
	values: Array<[number, string]>;
}

export type PrometheusInstantQueryResponse = PrometheusResponse<InstantQueryData>;
export type PrometheusRangeQueryResponse = PrometheusResponse<RangeQueryData>;

export interface PrometheusBaseParams {
	query: string;
}

export interface PrometheusTimeRangeParams extends PrometheusBaseParams {
	start: number;
	end: number;
}

export interface PrometheusRangeQueryParams extends PrometheusTimeRangeParams {
	step: number;
}

export interface PrometheusInstantQueryParams extends PrometheusBaseParams {
	timestamp: number;
}

export interface PrometheusAutoStepParams extends PrometheusTimeRangeParams {
	samples?: number;
}
