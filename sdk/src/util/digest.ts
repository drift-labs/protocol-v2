import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

export function digest(data: Buffer): Buffer {
	const hash = createHash('sha256');
	hash.update(data);
	return hash.digest();
}

export function digestSignature(signature: Uint8Array): string {
	return createHash('sha256').update(signature).digest('base64');
}

export function generateSwiftUuid(): Uint8Array {
	return Uint8Array.from(Buffer.from(nanoid(8)));
}
