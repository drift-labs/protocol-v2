import { precisionTransform } from '../transforms/precisions';

export const applyPrecisions = (obj: any): any => {
	if (Array.isArray(obj)) {
		return obj.map((item) => {
			if (typeof item === 'object') return applyPrecisions(item);
			return item;
		});
	}
	const result = { ...obj };
	for (const key in obj) {
		const rule = precisionTransform.rules[0];
		if (rule.fields.includes(key)) {
			result[key] = rule.transform(obj[key], { field: key, ...obj });
		}
	}
	for (const key in result) {
		if (typeof result[key] === 'object' && result[key] !== null) {
			result[key] = applyPrecisions(result[key]);
		}
	}
	return result;
};
