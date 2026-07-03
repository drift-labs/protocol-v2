import {
	getUserStatsIsReferredFilter,
	getUserStatsIsReferredOrReferrerFilter,
} from '../../src/memcmp';
import velocityIDL from '../../src/idl/velocity.json';
import { assert } from 'chai';
import bs58 from 'bs58';

const ANCHOR_DISCRIMINATOR_SIZE = 8;

type IdlField = { name: string; type: unknown };
type IdlStructType = {
	name: string;
	type: { kind: 'struct'; fields: IdlField[] };
};

function findIdlStruct(typeName: string): IdlStructType {
	const idlType = (velocityIDL as { types: IdlStructType[] }).types.find(
		(t) => t.name === typeName
	);
	if (!idlType) {
		throw new Error(`IDL type '${typeName}' not found`);
	}
	return idlType;
}

// Byte size of a single IDL field type. Covers exactly the primitive/defined
// types that appear in `UserStats` ahead of `referrer_status`. Throws on any
// type it doesn't recognize so a future layout change with a new field type
// fails loudly instead of silently computing a wrong offset.
function idlTypeSize(type: unknown): number {
	if (typeof type === 'string') {
		switch (type) {
			case 'pubkey':
				return 32;
			case 'u64':
			case 'i64':
				return 8;
			case 'u32':
			case 'i32':
				return 4;
			case 'u16':
			case 'i16':
				return 2;
			case 'u8':
			case 'i8':
			case 'bool':
				return 1;
			default:
				throw new Error(`Unrecognized primitive IDL type '${type}'`);
		}
	}

	if (type && typeof type === 'object') {
		const obj = type as Record<string, unknown>;

		if ('array' in obj) {
			const [elemType, len] = obj.array as [unknown, number];
			return idlTypeSize(elemType) * len;
		}

		if ('defined' in obj) {
			const defined = obj.defined as { name: string } | string;
			const typeName = typeof defined === 'string' ? defined : defined.name;
			const definedStruct = findIdlStruct(typeName);
			return definedStruct.type.fields.reduce(
				(sum, field) => sum + idlTypeSize(field.type),
				0
			);
		}
	}

	throw new Error(`Unrecognized IDL type shape: ${JSON.stringify(type)}`);
}

// Computes the byte offset (including the 8-byte Anchor discriminator) of
// `fieldName` within the given IDL struct, by summing the sizes of all
// fields declared before it.
function deriveFieldOffset(structTypeName: string, fieldName: string): number {
	const struct = findIdlStruct(structTypeName);
	let offset = ANCHOR_DISCRIMINATOR_SIZE;

	for (const field of struct.type.fields) {
		if (field.name === fieldName) {
			return offset;
		}
		offset += idlTypeSize(field.type);
	}

	throw new Error(
		`Field '${fieldName}' not found in IDL type '${structTypeName}'`
	);
}

const REFERRER_STATUS_OFFSET = deriveFieldOffset(
	'UserStats',
	'referrer_status'
);

// Sanity check: this offset is also asserted as a literal in
// `USER_STATS_REFERRER_STATUS_OFFSET` (packages/sdk/src/memcmp.ts). If the IDL
// ever disagrees with that literal, the `it` blocks below will fail and
// surface the discrepancy rather than silently passing.
const USER_STATS_SIZE = 240; // includes the 8-byte discriminator

function buildSyntheticUserStatsBuffer(referrerStatus: number): Buffer {
	const buffer = Buffer.alloc(USER_STATS_SIZE);
	buffer.writeUInt8(referrerStatus, REFERRER_STATUS_OFFSET);
	return buffer;
}

describe('UserStats memcmp offsets', () => {
	it('getUserStatsIsReferredFilter targets the IDL-derived referrer_status offset, not the stale 188', () => {
		const filter = getUserStatsIsReferredFilter();

		assert.equal(filter.memcmp.offset, REFERRER_STATUS_OFFSET);
		assert.notEqual(filter.memcmp.offset, 188);
		assert.equal(bs58.decode(filter.memcmp.bytes as string)[0], 2);
	});

	it('getUserStatsIsReferredOrReferrerFilter targets the IDL-derived referrer_status offset, not the stale 188', () => {
		const filter = getUserStatsIsReferredOrReferrerFilter();

		assert.equal(filter.memcmp.offset, REFERRER_STATUS_OFFSET);
		assert.notEqual(filter.memcmp.offset, 188);
		assert.equal(bs58.decode(filter.memcmp.bytes as string)[0], 3);
	});

	it('a synthetic UserStats buffer with referrer_status=2 (IsReferred) matches only at the corrected offset', () => {
		const buffer = buildSyntheticUserStatsBuffer(2);
		const filter = getUserStatsIsReferredFilter();
		const expectedByte = bs58.decode(filter.memcmp.bytes as string)[0];

		assert.equal(buffer[filter.memcmp.offset as number], expectedByte);
		// The old hardcoded offset (188) lands on a zeroed padding byte, which is
		// exactly why the filter previously matched zero accounts.
		assert.equal(buffer[188], 0);
	});
});
