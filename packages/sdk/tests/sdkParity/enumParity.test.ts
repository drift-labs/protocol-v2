import velocityIDL from '../../src/idl/velocity.json';
import {
	OracleSource,
	ContractType,
	PerpOperation,
	OrderBitFlag,
} from '../../src';
import { assert } from 'chai';

type IdlEnumVariant = { name: string };
type IdlEnumType = {
	name: string;
	type: { kind: 'enum'; variants: IdlEnumVariant[] };
};

function idlVariantNames(typeName: string): string[] {
	const idlType = (velocityIDL as { types: IdlEnumType[] }).types.find(
		(t) => t.name === typeName
	);
	if (!idlType) {
		throw new Error(`IDL type '${typeName}' not found`);
	}
	return idlType.type.variants.map((v) => v.name);
}

// Anchor's TS coder lowercases the first letter of a PascalCase Rust variant
// name (e.g. `DeprecatedSwitchboard` -> `deprecatedSwitchboard`).
function toCamelCase(pascalCase: string): string {
	return pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1);
}

function variantKeysOf(values: unknown[]): string[] {
	return values.map((v) => Object.keys(v as Record<string, unknown>)[0]);
}

describe('SDK enum parity with IDL', () => {
	it('OracleSource variant keys match every IDL variant, including the deprecated switchboard renames', () => {
		const expectedKeys = idlVariantNames('OracleSource').map(toCamelCase);
		const sdkKeys = variantKeysOf(Object.values(OracleSource));

		for (const expected of expectedKeys) {
			assert.include(
				sdkKeys,
				expected,
				`OracleSource is missing IDL variant '${expected}'`
			);
		}

		// The program renamed these discriminants; the SDK must key on the new
		// names, or decode throws 'Invalid oracle source' for any market still
		// wired to a switchboard oracle.
		assert.notInclude(sdkKeys, 'switchboard');
		assert.notInclude(sdkKeys, 'switchboardOnDemand');
		assert.include(sdkKeys, 'deprecatedSwitchboard');
		assert.include(sdkKeys, 'deprecatedSwitchboardOnDemand');
	});

	it('ContractType variant keys match the IDL exactly', () => {
		const expectedKeys = idlVariantNames('ContractType').map(toCamelCase);
		const sdkKeys = variantKeysOf(Object.values(ContractType));

		assert.sameMembers(sdkKeys, expectedKeys);
	});

	it('PerpOperation bit flags match the on-chain 8-bit layout', () => {
		assert.equal(PerpOperation.UPDATE_FUNDING, 1);
		assert.equal(PerpOperation.AMM_FILL, 2);
		assert.equal(PerpOperation.FILL, 4);
		assert.equal(PerpOperation.SETTLE_PNL, 8);
		assert.equal(PerpOperation.SETTLE_PNL_WITH_POSITION, 16);
		assert.equal(PerpOperation.LIQUIDATION, 32);
		assert.equal(PerpOperation.AMM_IMMEDIATE_FILL, 64);
		assert.equal(PerpOperation.SETTLE_REV_POOL, 128);
	});

	it('OrderBitFlag values match the on-chain 6-bit layout', () => {
		assert.equal(OrderBitFlag.SignedMessage, 1);
		assert.equal(OrderBitFlag.OracleTriggerMarket, 2);
		assert.equal(OrderBitFlag.SafeTriggerOrder, 4);
		assert.equal(OrderBitFlag.NewTriggerReduceOnly, 8);
		assert.equal(OrderBitFlag.HasBuilder, 16);
		assert.equal(OrderBitFlag.IsIsolatedPosition, 32);
	});
});
