/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pyth.json`.
 */
export type Pyth = {
	address: 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH';
	metadata: {
		name: 'pyth';
		version: '0.1.0';
		spec: '0.1.0';
		description: 'Created with Anchor';
	};
	instructions: [
		{
			name: 'initialize';
			discriminator: [175, 175, 109, 31, 13, 152, 155, 237];
			accounts: [
				{
					name: 'price';
					writable: true;
				},
			];
			args: [
				{
					name: 'price';
					type: 'i64';
				},
				{
					name: 'expo';
					type: 'i32';
				},
				{
					name: 'conf';
					type: 'u64';
				},
			];
		},
		{
			name: 'setPrice';
			discriminator: [16, 19, 182, 8, 149, 83, 72, 181];
			accounts: [
				{
					name: 'price';
					writable: true;
				},
			];
			args: [
				{
					name: 'price';
					type: 'i64';
				},
			];
		},
		{
			name: 'setPriceInfo';
			discriminator: [52, 225, 243, 132, 19, 89, 254, 181];
			accounts: [
				{
					name: 'price';
					writable: true;
				},
			];
			args: [
				{
					name: 'price';
					type: 'i64';
				},
				{
					name: 'conf';
					type: 'u64';
				},
				{
					name: 'slot';
					type: 'u64';
				},
			];
		},
		{
			name: 'setTwap';
			discriminator: [10, 194, 43, 204, 120, 214, 177, 206];
			accounts: [
				{
					name: 'price';
					writable: true;
				},
			];
			args: [
				{
					name: 'twap';
					type: 'i64';
				},
			];
		},
	];
};
