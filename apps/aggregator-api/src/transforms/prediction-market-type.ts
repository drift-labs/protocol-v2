import { SerializedMarketFilter } from '@backend/common';
import { TransformConfig } from '../types';

export const predictionMarketType: TransformConfig = {
	name: 'prediction-market-type',
	description: 'Fixes marketType of prediction for historical data',
	rules: [
		{
			condition: (record) => {
				return record.marketType === SerializedMarketFilter.PREDICTION;
			},
			transform: () => {
				return SerializedMarketFilter.PERP;
			},
			fields: ['marketType'],
		},
	],
};
