import { createHash } from 'crypto';

export function digest(data: Buffer): Buffer {
	const hash = createHash('sha256');
	hash.update(data);
	return hash.digest();
}
