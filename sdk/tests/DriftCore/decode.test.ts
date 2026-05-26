import { describe, expect, test } from 'bun:test';
import { VelocityCore } from '../../src/core/VelocityCore';
import { userAccountBufferStrings } from '../decode/userAccountBufferStrings';

describe('DriftCore decoding', () => {
	test('can decode User account from fixture buffer', () => {
		const s = userAccountBufferStrings[0];
		const buf = Buffer.from(s, 'base64');
		const decoded = VelocityCore.decodeUserAccount(buf);

		expect(decoded).toBeTruthy();
		expect(decoded.authority).toBeTruthy();
		expect(decoded.delegate).toBeTruthy();
		expect(decoded.name).toBeTruthy();
	});
});
