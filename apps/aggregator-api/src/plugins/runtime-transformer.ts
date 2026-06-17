import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { precisionTransform } from '../transforms/precisions';
import { predictionMarketType } from '../transforms/prediction-market-type';
import { TransformConfig } from '../types';

const TRANSFORMS: TransformConfig[] = [precisionTransform, predictionMarketType];

const runtimeTransformer: FastifyPluginAsync = async (fastify) => {
	const applyTransforms = (record: any) => {
		const transformed = { ...record };

		for (const config of TRANSFORMS) {
			for (const rule of config.rules) {
				if (rule.condition(record)) {
					for (const field of rule.fields) {
						if (field in record && record[field] !== null) {
							transformed[field] = rule.transform(record[field], {
								...record,
								field,
							});
						}
					}
				}
			}
		}

		return transformed;
	};

	fastify.addHook('preSerialization', async (_, __, payload) => {
		if (!payload || typeof payload !== 'object' || !('records' in payload)) {
			return payload;
		}

		const isArray = Array.isArray(payload.records);
		const records = isArray ? (payload.records as any[]) : [payload.records];
		const transformedRecords = records.map(applyTransforms);

		const finalRecords = isArray ? transformedRecords : transformedRecords[0];

		return {
			...payload,
			records: finalRecords,
		};
	});
};

export default fp(runtimeTransformer);
