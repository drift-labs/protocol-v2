/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/token_faucet.json`.
 */
export type TokenFaucet = {
	address: 'V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB';
	metadata: {
		name: 'tokenFaucet';
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
					name: 'faucetConfig';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									102,
									97,
									117,
									99,
									101,
									116,
									95,
									99,
									111,
									110,
									102,
									105,
									103,
								];
							},
							{
								kind: 'account';
								path: 'mintAccount';
							},
						];
					};
				},
				{
					name: 'admin';
					writable: true;
					signer: true;
				},
				{
					name: 'mintAccount';
					writable: true;
				},
				{
					name: 'rent';
					address: 'SysvarRent111111111111111111111111111111111';
				},
				{
					name: 'systemProgram';
					address: '11111111111111111111111111111111';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [];
		},
		{
			name: 'mintToUser';
			discriminator: [75, 194, 44, 77, 10, 65, 232, 85];
			accounts: [
				{
					name: 'faucetConfig';
				},
				{
					name: 'mintAccount';
					writable: true;
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'mintAuthority';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'amount';
					type: 'u64';
				},
			];
		},
		{
			name: 'transferMintAuthority';
			discriminator: [87, 237, 187, 84, 168, 175, 241, 75];
			accounts: [
				{
					name: 'faucetConfig';
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									102,
									97,
									117,
									99,
									101,
									116,
									95,
									99,
									111,
									110,
									102,
									105,
									103,
								];
							},
							{
								kind: 'account';
								path: 'mintAccount';
							},
						];
					};
				},
				{
					name: 'admin';
					writable: true;
					signer: true;
					relations: ['faucetConfig'];
				},
				{
					name: 'mintAccount';
					writable: true;
				},
				{
					name: 'mintAuthority';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [];
		},
	];
	accounts: [
		{
			name: 'faucetConfig';
			discriminator: [216, 31, 49, 154, 106, 125, 143, 142];
		},
	];
	errors: [
		{
			code: 6000;
			name: 'invalidMintAccountAuthority';
			msg: 'Program not mint authority';
		},
	];
	types: [
		{
			name: 'faucetConfig';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'admin';
						type: 'pubkey';
					},
					{
						name: 'mint';
						type: 'pubkey';
					},
					{
						name: 'mintAuthority';
						type: 'pubkey';
					},
					{
						name: 'mintAuthorityNonce';
						type: 'u8';
					},
				];
			};
		},
	];
};
