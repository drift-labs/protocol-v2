import { PublicKey } from '@solana/web3.js';
import { BN } from 'bn.js';

// TODO add types
export const simpleSerialize = (value: any): any => {
	if (value instanceof BN) {
		return value.toString(10);
	}

	if (value instanceof PublicKey) {
		return value.toString();
	}

	if (value === null) {
		return null;
	}

	if (Array.isArray(value)) {
		return value.map((item) => simpleSerialize(item));
	}

	if (typeof value === 'object') {
		if (value._bn !== undefined) {
			return new PublicKey(new BN(value._bn, 'le')).toBase58();
		}

		const keys = Object.keys(value);
		if (keys.length === 1 && Object.keys(value[keys[0]]).length === 0) {
			return keys[0];
		}

		const newObj: { [key: string]: any } = {};
		for (const [k, v] of Object.entries(value)) {
			newObj[k] = simpleSerialize(v);
		}
		return newObj;
	}

	return value;
};
