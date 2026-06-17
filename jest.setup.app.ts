// Global test helpers for the apps/* suites, ported from infrastructure-v3's
// jest.setup.ts. Some suites (e.g. notification-engine) call `genMockKey()` to
// fabricate base58 pubkeys without importing a helper.
import bs58 from 'bs58';
import { randomBytes } from 'crypto';

(global as any).genMockKey = () => {
	return bs58.encode(randomBytes(32));
};
