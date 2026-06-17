/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/vaults.json`.
 */
export type Vaults = {
	address: 'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR';
	metadata: {
		name: 'vaults';
		version: '0.11.0';
		spec: '0.1.0';
		description: 'Created with Anchor';
	};
	instructions: [
		{
			name: 'addInsuranceFundStake';
			discriminator: [251, 144, 115, 11, 222, 47, 62, 236];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					writable: true;
					signer: true;
				},
				{
					name: 'driftSpotMarket';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [115, 112, 111, 116, 95, 109, 97, 114, 107, 101, 116];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									115,
									112,
									111,
									116,
									95,
									109,
									97,
									114,
									107,
									101,
									116,
									95,
									118,
									97,
									117,
									108,
									116,
								];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundStake';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									115,
									116,
									97,
									107,
									101,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundVault';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									118,
									97,
									117,
									108,
									116,
								];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'managerTokenAccount';
					writable: true;
				},
				{
					name: 'vaultIfTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'marketIndex';
					type: 'u16';
				},
				{
					name: 'amount';
					type: 'u64';
				},
			];
		},
		{
			name: 'adminDeleteFeeUpdate';
			discriminator: [189, 83, 182, 110, 132, 133, 77, 36];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'admin';
					writable: true;
					signer: true;
				},
				{
					name: 'feeUpdate';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [102, 101, 101, 95, 117, 112, 100, 97, 116, 101];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
			];
			args: [];
		},
		{
			name: 'adminInitFeeUpdate';
			discriminator: [39, 31, 253, 244, 241, 5, 72, 152];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'admin';
					writable: true;
					signer: true;
				},
				{
					name: 'feeUpdate';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [102, 101, 101, 95, 117, 112, 100, 97, 116, 101];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'systemProgram';
					address: '11111111111111111111111111111111';
				},
			];
			args: [];
		},
		{
			name: 'adminUpdateVaultClass';
			discriminator: [103, 11, 101, 120, 92, 136, 230, 215];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'admin';
					writable: true;
					signer: true;
				},
				{
					name: 'systemProgram';
					address: '11111111111111111111111111111111';
				},
			];
			args: [
				{
					name: 'newVaultClass';
					type: 'u8';
				},
			];
		},
		{
			name: 'applyProfitShare';
			discriminator: [112, 235, 54, 165, 178, 81, 25, 10];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [];
		},
		{
			name: 'applyRebase';
			discriminator: [161, 115, 9, 131, 136, 29, 147, 155];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
			];
			args: [];
		},
		{
			name: 'applyRebaseTokenizedDepositor';
			discriminator: [218, 169, 190, 71, 150, 184, 77, 166];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'tokenizedVaultDepositor';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
			];
			args: [];
		},
		{
			name: 'cancelRequestRemoveInsuranceFundStake';
			discriminator: [97, 235, 78, 62, 212, 42, 241, 127];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftSpotMarket';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [115, 112, 111, 116, 95, 109, 97, 114, 107, 101, 116];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundStake';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									115,
									116,
									97,
									107,
									101,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundVault';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									118,
									97,
									117,
									108,
									116,
								];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [
				{
					name: 'marketIndex';
					type: 'u16';
				},
			];
		},
		{
			name: 'cancelRequestWithdraw';
			discriminator: [26, 109, 1, 81, 102, 15, 6, 106];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'driftUserStats';
				},
				{
					name: 'driftUser';
				},
			];
			args: [];
		},
		{
			name: 'deposit';
			discriminator: [242, 35, 198, 137, 82, 225, 242, 182];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
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
			name: 'forceWithdraw';
			discriminator: [106, 41, 34, 48, 17, 177, 59, 255];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [];
		},
		{
			name: 'initializeInsuranceFundStake';
			discriminator: [187, 179, 243, 70, 248, 90, 92, 147];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'payer';
					writable: true;
					signer: true;
				},
				{
					name: 'rent';
					address: 'SysvarRent111111111111111111111111111111111';
				},
				{
					name: 'driftSpotMarket';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [115, 112, 111, 116, 95, 109, 97, 114, 107, 101, 116];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'driftSpotMarketMint';
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
					};
				},
				{
					name: 'insuranceFundStake';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									115,
									116,
									97,
									107,
									101,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
				{
					name: 'systemProgram';
					address: '11111111111111111111111111111111';
				},
			];
			args: [
				{
					name: 'marketIndex';
					type: 'u16';
				},
			];
		},
		{
			name: 'initializeTokenizedVaultDepositor';
			discriminator: [50, 183, 239, 21, 59, 150, 51, 227];
			accounts: [
				{
					name: 'vault';
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									116,
									111,
									107,
									101,
									110,
									105,
									122,
									101,
									100,
									95,
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'mintAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [109, 105, 110, 116];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'metadataAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [109, 101, 116, 97, 100, 97, 116, 97];
							},
							{
								kind: 'account';
								path: 'tokenMetadataProgram';
							},
							{
								kind: 'account';
								path: 'mintAccount';
							},
						];
						program: {
							kind: 'account';
							path: 'tokenMetadataProgram';
						};
					};
				},
				{
					name: 'payer';
					writable: true;
					signer: true;
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
				{
					name: 'tokenMetadataProgram';
					address: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
				},
				{
					name: 'rent';
					address: 'SysvarRent111111111111111111111111111111111';
				},
				{
					name: 'systemProgram';
					address: '11111111111111111111111111111111';
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'initializeTokenizedVaultDepositorParams';
						};
					};
				},
			];
		},
		{
			name: 'initializeVault';
			discriminator: [48, 191, 163, 44, 71, 129, 63, 164];
			accounts: [
				{
					name: 'vault';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [118, 97, 117, 108, 116];
							},
							{
								kind: 'arg';
								path: 'params.name';
							},
						];
					};
				},
				{
					name: 'tokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
					writable: true;
				},
				{
					name: 'driftSpotMarket';
				},
				{
					name: 'driftSpotMarketMint';
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'payer';
					writable: true;
					signer: true;
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
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'vaultParams';
						};
					};
				},
			];
		},
		{
			name: 'initializeVaultDepositor';
			discriminator: [112, 174, 162, 232, 89, 92, 205, 168];
			accounts: [
				{
					name: 'vault';
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
				},
				{
					name: 'payer';
					writable: true;
					signer: true;
				},
				{
					name: 'rent';
					address: 'SysvarRent111111111111111111111111111111111';
				},
				{
					name: 'systemProgram';
					address: '11111111111111111111111111111111';
				},
			];
			args: [];
		},
		{
			name: 'initializeVaultWithProtocol';
			discriminator: [176, 2, 248, 66, 116, 82, 52, 112];
			accounts: [
				{
					name: 'vault';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [118, 97, 117, 108, 116];
							},
							{
								kind: 'arg';
								path: 'params.name';
							},
						];
					};
				},
				{
					name: 'vaultProtocol';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									112,
									114,
									111,
									116,
									111,
									99,
									111,
									108,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'tokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
					writable: true;
				},
				{
					name: 'driftSpotMarket';
				},
				{
					name: 'driftSpotMarketMint';
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'payer';
					writable: true;
					signer: true;
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
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'vaultWithProtocolParams';
						};
					};
				},
			];
		},
		{
			name: 'liquidate';
			discriminator: [223, 179, 226, 125, 48, 46, 39, 74];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
				},
				{
					name: 'admin';
					writable: true;
					signer: true;
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [];
		},
		{
			name: 'managerBorrow';
			discriminator: [176, 237, 83, 189, 102, 73, 14, 153];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'borrowSpotMarketIndex';
					type: 'u16';
				},
				{
					name: 'borrowAmount';
					type: 'u64';
				},
			];
		},
		{
			name: 'managerCancelFeeUpdate';
			discriminator: [176, 204, 109, 177, 90, 244, 69, 156];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'feeUpdate';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [102, 101, 101, 95, 117, 112, 100, 97, 116, 101];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
			];
			args: [];
		},
		{
			name: 'managerDeposit';
			discriminator: [73, 3, 16, 168, 143, 226, 201, 254];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
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
			name: 'managerRepay';
			discriminator: [202, 56, 50, 3, 1, 40, 93, 128];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'repaySpotMarketIndex';
					type: 'u16';
				},
				{
					name: 'repayAmount';
					type: 'u64';
				},
				{
					name: 'repayValue';
					type: {
						option: 'u64';
					};
				},
			];
		},
		{
			name: 'managerRequestWithdraw';
			discriminator: [10, 238, 194, 232, 76, 55, 68, 4];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUserStats';
				},
				{
					name: 'driftUser';
				},
			];
			args: [
				{
					name: 'withdrawAmount';
					type: 'u64';
				},
				{
					name: 'withdrawUnit';
					type: {
						defined: {
							name: 'withdrawUnit';
						};
					};
				},
			];
		},
		{
			name: 'managerUpdateBorrow';
			discriminator: [193, 183, 210, 205, 223, 11, 240, 138];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
			];
			args: [
				{
					name: 'newBorrowValue';
					type: 'u64';
				},
			];
		},
		{
			name: 'managerUpdateFees';
			discriminator: [205, 156, 240, 90, 150, 60, 144, 53];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'feeUpdate';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [102, 101, 101, 95, 117, 112, 100, 97, 116, 101];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'managerUpdateFeesParams';
						};
					};
				},
			];
		},
		{
			name: 'managerWithdraw';
			discriminator: [201, 248, 190, 143, 86, 43, 183, 254];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [];
		},
		{
			name: 'mangerCancelWithdrawRequest';
			discriminator: [235, 253, 32, 176, 145, 94, 162, 244];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUserStats';
				},
				{
					name: 'driftUser';
				},
			];
			args: [];
		},
		{
			name: 'protocolCancelWithdrawRequest';
			discriminator: [194, 217, 171, 94, 56, 253, 179, 242];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultProtocol';
					writable: true;
				},
				{
					name: 'protocol';
					signer: true;
				},
				{
					name: 'driftUserStats';
				},
				{
					name: 'driftUser';
				},
			];
			args: [];
		},
		{
			name: 'protocolRequestWithdraw';
			discriminator: [189, 46, 14, 31, 7, 254, 150, 132];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultProtocol';
					writable: true;
				},
				{
					name: 'protocol';
					signer: true;
				},
				{
					name: 'driftUserStats';
				},
				{
					name: 'driftUser';
				},
			];
			args: [
				{
					name: 'withdrawAmount';
					type: 'u64';
				},
				{
					name: 'withdrawUnit';
					type: {
						defined: {
							name: 'withdrawUnit';
						};
					};
				},
			];
		},
		{
			name: 'protocolWithdraw';
			discriminator: [166, 24, 188, 209, 21, 251, 63, 199];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultProtocol';
					writable: true;
				},
				{
					name: 'protocol';
					signer: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [];
		},
		{
			name: 'redeemTokens';
			discriminator: [246, 98, 134, 41, 152, 33, 120, 69];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'tokenizedVaultDepositor';
					writable: true;
				},
				{
					name: 'mint';
					writable: true;
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'tokensToBurn';
					type: 'u64';
				},
			];
		},
		{
			name: 'removeInsuranceFundStake';
			discriminator: [128, 166, 142, 9, 254, 187, 143, 174];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftSpotMarket';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [115, 112, 111, 116, 95, 109, 97, 114, 107, 101, 116];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundStake';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									115,
									116,
									97,
									107,
									101,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundVault';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									118,
									97,
									117,
									108,
									116,
								];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'managerTokenAccount';
					writable: true;
				},
				{
					name: 'vaultIfTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
				{
					name: 'tokenProgram';
					address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
				},
			];
			args: [
				{
					name: 'marketIndex';
					type: 'u16';
				},
			];
		},
		{
			name: 'requestRemoveInsuranceFundStake';
			discriminator: [142, 70, 204, 92, 73, 106, 180, 52];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftSpotMarket';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [115, 112, 111, 116, 95, 109, 97, 114, 107, 101, 116];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundStake';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									115,
									116,
									97,
									107,
									101,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'insuranceFundVault';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									105,
									110,
									115,
									117,
									114,
									97,
									110,
									99,
									101,
									95,
									102,
									117,
									110,
									100,
									95,
									118,
									97,
									117,
									108,
									116,
								];
							},
							{
								kind: 'arg';
								path: 'marketIndex';
							},
						];
						program: {
							kind: 'account';
							path: 'driftProgram';
						};
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [
				{
					name: 'marketIndex';
					type: 'u16';
				},
				{
					name: 'amount';
					type: 'u64';
				},
			];
		},
		{
			name: 'requestWithdraw';
			discriminator: [137, 95, 187, 96, 250, 138, 31, 182];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'driftUserStats';
				},
				{
					name: 'driftUser';
				},
			];
			args: [
				{
					name: 'withdrawAmount';
					type: 'u64';
				},
				{
					name: 'withdrawUnit';
					type: {
						defined: {
							name: 'withdrawUnit';
						};
					};
				},
			];
		},
		{
			name: 'resetDelegate';
			discriminator: [204, 13, 61, 153, 97, 83, 146, 98];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [];
		},
		{
			name: 'tokenizeShares';
			discriminator: [166, 4, 14, 227, 21, 161, 121, 122];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'tokenizedVaultDepositor';
					writable: true;
				},
				{
					name: 'mint';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [109, 105, 110, 116];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'userTokenAccount';
				},
				{
					name: 'driftUser';
					writable: true;
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
				{
					name: 'unit';
					type: {
						defined: {
							name: 'withdrawUnit';
						};
					};
				},
			];
		},
		{
			name: 'transferVaultDepositorShares';
			discriminator: [94, 208, 177, 250, 120, 51, 112, 235];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'toVaultDepositor';
					writable: true;
				},
				{
					name: 'driftUser';
				},
			];
			args: [
				{
					name: 'amount';
					type: 'u64';
				},
				{
					name: 'withdrawUnit';
					type: {
						defined: {
							name: 'withdrawUnit';
						};
					};
				},
			];
		},
		{
			name: 'updateDelegate';
			discriminator: [190, 202, 103, 138, 167, 197, 25, 9];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [
				{
					name: 'delegate';
					type: 'pubkey';
				},
			];
		},
		{
			name: 'updateMarginTradingEnabled';
			discriminator: [244, 34, 229, 140, 91, 65, 200, 67];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [
				{
					name: 'enabled';
					type: 'bool';
				},
			];
		},
		{
			name: 'updateUserPoolId';
			discriminator: [219, 86, 73, 106, 56, 218, 128, 109];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
				},
			];
			args: [
				{
					name: 'poolId';
					type: 'u8';
				},
			];
		},
		{
			name: 'updateVault';
			discriminator: [67, 229, 185, 188, 226, 11, 210, 60];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'updateVaultParams';
						};
					};
				},
			];
		},
		{
			name: 'updateVaultManager';
			discriminator: [246, 80, 162, 207, 228, 28, 133, 170];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'manager';
					signer: true;
				},
			];
			args: [
				{
					name: 'manager';
					type: 'pubkey';
				},
			];
		},
		{
			name: 'updateVaultProtocol';
			discriminator: [205, 248, 117, 191, 35, 252, 172, 133];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'protocol';
					signer: true;
				},
				{
					name: 'vaultProtocol';
					writable: true;
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'updateVaultProtocolParams';
						};
					};
				},
			];
		},
		{
			name: 'withdraw';
			discriminator: [183, 18, 70, 156, 148, 109, 161, 34];
			accounts: [
				{
					name: 'vault';
					writable: true;
				},
				{
					name: 'vaultDepositor';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									100,
									101,
									112,
									111,
									115,
									105,
									116,
									111,
									114,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
							{
								kind: 'account';
								path: 'authority';
							},
						];
					};
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'vaultTokenAccount';
					writable: true;
					pda: {
						seeds: [
							{
								kind: 'const';
								value: [
									118,
									97,
									117,
									108,
									116,
									95,
									116,
									111,
									107,
									101,
									110,
									95,
									97,
									99,
									99,
									111,
									117,
									110,
									116,
								];
							},
							{
								kind: 'account';
								path: 'vault';
							},
						];
					};
				},
				{
					name: 'driftUserStats';
					writable: true;
				},
				{
					name: 'driftUser';
					writable: true;
				},
				{
					name: 'driftState';
				},
				{
					name: 'driftSpotMarketVault';
					writable: true;
				},
				{
					name: 'driftSigner';
				},
				{
					name: 'userTokenAccount';
					writable: true;
				},
				{
					name: 'driftProgram';
					address: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
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
			name: 'feeUpdate';
			discriminator: [118, 79, 140, 36, 102, 217, 40, 52];
		},
		{
			name: 'tokenizedVaultDepositor';
			discriminator: [75, 23, 253, 123, 121, 93, 29, 130];
		},
		{
			name: 'vault';
			discriminator: [211, 8, 232, 43, 2, 152, 117, 119];
		},
		{
			name: 'vaultDepositor';
			discriminator: [87, 109, 182, 106, 87, 96, 63, 211];
		},
		{
			name: 'vaultProtocol';
			discriminator: [106, 130, 5, 195, 126, 82, 249, 53];
		},
	];
	events: [
		{
			name: 'feeUpdateRecord';
			discriminator: [30, 88, 241, 188, 216, 141, 47, 1];
		},
		{
			name: 'managerBorrowRecord';
			discriminator: [147, 180, 112, 14, 60, 116, 7, 193];
		},
		{
			name: 'managerRepayRecord';
			discriminator: [220, 139, 37, 15, 27, 74, 67, 64];
		},
		{
			name: 'managerUpdateBorrowRecord';
			discriminator: [203, 63, 88, 107, 38, 234, 53, 148];
		},
		{
			name: 'shareTransferRecord';
			discriminator: [154, 130, 10, 212, 173, 104, 154, 183];
		},
		{
			name: 'vaultDepositorRecord';
			discriminator: [177, 172, 11, 74, 19, 216, 149, 11];
		},
		{
			name: 'vaultDepositorV1Record';
			discriminator: [36, 53, 222, 7, 105, 74, 6, 76];
		},
		{
			name: 'vaultRecord';
			discriminator: [38, 129, 21, 139, 164, 170, 16, 134];
		},
	];
	errors: [
		{
			code: 6000;
			name: 'default';
			msg: 'default';
		},
		{
			code: 6001;
			name: 'invalidVaultRebase';
			msg: 'invalidVaultRebase';
		},
		{
			code: 6002;
			name: 'invalidVaultSharesDetected';
			msg: 'invalidVaultSharesDetected';
		},
		{
			code: 6003;
			name: 'cannotWithdrawBeforeRedeemPeriodEnd';
			msg: 'cannotWithdrawBeforeRedeemPeriodEnd';
		},
		{
			code: 6004;
			name: 'invalidVaultWithdraw';
			msg: 'invalidVaultWithdraw';
		},
		{
			code: 6005;
			name: 'insufficientVaultShares';
			msg: 'insufficientVaultShares';
		},
		{
			code: 6006;
			name: 'invalidVaultWithdrawSize';
			msg: 'invalidVaultWithdrawSize';
		},
		{
			code: 6007;
			name: 'invalidVaultForNewDepositors';
			msg: 'invalidVaultForNewDepositors';
		},
		{
			code: 6008;
			name: 'vaultWithdrawRequestInProgress';
			msg: 'vaultWithdrawRequestInProgress';
		},
		{
			code: 6009;
			name: 'vaultIsAtCapacity';
			msg: 'vaultIsAtCapacity';
		},
		{
			code: 6010;
			name: 'invalidVaultDepositorInitialization';
			msg: 'invalidVaultDepositorInitialization';
		},
		{
			code: 6011;
			name: 'delegateNotAvailableForLiquidation';
			msg: 'delegateNotAvailableForLiquidation';
		},
		{
			code: 6012;
			name: 'invalidEquityValue';
			msg: 'invalidEquityValue';
		},
		{
			code: 6013;
			name: 'vaultInLiquidation';
			msg: 'vaultInLiquidation';
		},
		{
			code: 6014;
			name: 'driftError';
			msg: 'driftError';
		},
		{
			code: 6015;
			name: 'invalidVaultInitialization';
			msg: 'invalidVaultInitialization';
		},
		{
			code: 6016;
			name: 'invalidVaultUpdate';
			msg: 'invalidVaultUpdate';
		},
		{
			code: 6017;
			name: 'permissionedVault';
			msg: 'permissionedVault';
		},
		{
			code: 6018;
			name: 'withdrawInProgress';
			msg: 'withdrawInProgress';
		},
		{
			code: 6019;
			name: 'sharesPercentTooLarge';
			msg: 'sharesPercentTooLarge';
		},
		{
			code: 6020;
			name: 'invalidVaultDeposit';
			msg: 'invalidVaultDeposit';
		},
		{
			code: 6021;
			name: 'ongoingLiquidation';
			msg: 'ongoingLiquidation';
		},
		{
			code: 6022;
			name: 'vaultProtocolMissing';
			msg: 'vaultProtocolMissing';
		},
		{
			code: 6023;
			name: 'invalidTokenization';
			msg: 'invalidTokenization';
		},
		{
			code: 6024;
			name: 'feeUpdateMissing';
			msg: 'feeUpdateMissing';
		},
		{
			code: 6025;
			name: 'invalidFeeUpdateStatus';
			msg: 'invalidFeeUpdateStatus';
		},
		{
			code: 6026;
			name: 'invalidVaultClass';
			msg: 'invalidVaultClass';
		},
		{
			code: 6027;
			name: 'invalidBorrowAmount';
			msg: 'invalidBorrowAmount';
		},
		{
			code: 6028;
			name: 'invalidRepayAmount';
			msg: 'invalidRepayAmount';
		},
	];
	types: [
		{
			name: 'assetTier';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'collateral';
					},
					{
						name: 'protected';
					},
					{
						name: 'cross';
					},
					{
						name: 'isolated';
					},
					{
						name: 'unlisted';
					},
				];
			};
		},
		{
			name: 'feeUpdate';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'padding';
						type: {
							array: ['u128', 10];
						};
					},
					{
						name: 'incomingUpdateTs';
						type: 'i64';
					},
					{
						name: 'incomingManagementFee';
						type: 'i64';
					},
					{
						name: 'incomingProfitShare';
						type: 'u32';
					},
					{
						name: 'incomingHurdleRate';
						type: 'u32';
					},
					{
						name: 'padding2';
						type: {
							array: ['u8', 8];
						};
					},
				];
			};
		},
		{
			name: 'feeUpdateAction';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'pending';
					},
					{
						name: 'applied';
					},
					{
						name: 'cancelled';
					},
				];
			};
		},
		{
			name: 'feeUpdateRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'action';
						type: {
							defined: {
								name: 'feeUpdateAction';
							};
						};
					},
					{
						name: 'timelockEndTs';
						type: 'i64';
					},
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'oldManagementFee';
						type: 'i64';
					},
					{
						name: 'oldProfitShare';
						type: 'u32';
					},
					{
						name: 'oldHurdleRate';
						type: 'u32';
					},
					{
						name: 'newManagementFee';
						type: 'i64';
					},
					{
						name: 'newProfitShare';
						type: 'u32';
					},
					{
						name: 'newHurdleRate';
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'historicalIndexData';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'lastIndexBidPrice';
						docs: ['precision: PRICE_PRECISION'];
						type: 'u64';
					},
					{
						name: 'lastIndexAskPrice';
						docs: ['precision: PRICE_PRECISION'];
						type: 'u64';
					},
					{
						name: 'lastIndexPriceTwap';
						docs: ['precision: PRICE_PRECISION'];
						type: 'u64';
					},
					{
						name: 'lastIndexPriceTwap5min';
						docs: ['precision: PRICE_PRECISION'];
						type: 'u64';
					},
					{
						name: 'lastIndexPriceTwapTs';
						docs: ['unix_timestamp of last snapshot'];
						type: 'i64';
					},
				];
			};
		},
		{
			name: 'historicalOracleData';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'lastOraclePrice';
						docs: ['precision: PRICE_PRECISION'];
						type: 'i64';
					},
					{
						name: 'lastOracleConf';
						docs: ['precision: PRICE_PRECISION'];
						type: 'u64';
					},
					{
						name: 'lastOracleDelay';
						docs: ['number of slots since last update'];
						type: 'i64';
					},
					{
						name: 'lastOraclePriceTwap';
						docs: ['precision: PRICE_PRECISION'];
						type: 'i64';
					},
					{
						name: 'lastOraclePriceTwap5min';
						docs: ['precision: PRICE_PRECISION'];
						type: 'i64';
					},
					{
						name: 'lastOraclePriceTwapTs';
						docs: ['unix_timestamp of last snapshot'];
						type: 'i64';
					},
				];
			};
		},
		{
			name: 'initializeTokenizedVaultDepositorParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'tokenName';
						type: 'string';
					},
					{
						name: 'tokenSymbol';
						type: 'string';
					},
					{
						name: 'tokenUri';
						type: 'string';
					},
					{
						name: 'decimals';
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'insuranceFund';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'totalShares';
						type: 'u128';
					},
					{
						name: 'userShares';
						type: 'u128';
					},
					{
						name: 'sharesBase';
						type: 'u128';
					},
					{
						name: 'unstakingPeriod';
						type: 'i64';
					},
					{
						name: 'lastRevenueSettleTs';
						type: 'i64';
					},
					{
						name: 'revenueSettlePeriod';
						type: 'i64';
					},
					{
						name: 'totalFactor';
						type: 'u32';
					},
					{
						name: 'userFactor';
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'insuranceFundStake';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'authority';
						type: 'pubkey';
					},
					{
						name: 'ifShares';
						type: 'u128';
					},
					{
						name: 'lastWithdrawRequestShares';
						type: 'u128';
					},
					{
						name: 'ifBase';
						type: 'u128';
					},
					{
						name: 'lastValidTs';
						type: 'i64';
					},
					{
						name: 'lastWithdrawRequestValue';
						type: 'u64';
					},
					{
						name: 'lastWithdrawRequestTs';
						type: 'i64';
					},
					{
						name: 'costBasis';
						type: 'i64';
					},
					{
						name: 'marketIndex';
						type: 'u16';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 14];
						};
					},
				];
			};
		},
		{
			name: 'managerBorrowRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'manager';
						type: 'pubkey';
					},
					{
						name: 'borrowAmount';
						type: 'u64';
					},
					{
						name: 'borrowValue';
						type: 'u64';
					},
					{
						name: 'borrowSpotMarketIndex';
						type: 'u16';
					},
					{
						name: 'borrowOraclePrice';
						type: 'i64';
					},
					{
						name: 'depositSpotMarketIndex';
						type: 'u16';
					},
					{
						name: 'depositOraclePrice';
						type: 'i64';
					},
					{
						name: 'vaultEquity';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'managerRepayRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'manager';
						type: 'pubkey';
					},
					{
						name: 'repayAmount';
						type: 'u64';
					},
					{
						name: 'repayValue';
						type: 'u64';
					},
					{
						name: 'repaySpotMarketIndex';
						type: 'u16';
					},
					{
						name: 'repayOraclePrice';
						type: 'i64';
					},
					{
						name: 'depositSpotMarketIndex';
						type: 'u16';
					},
					{
						name: 'depositOraclePrice';
						type: 'i64';
					},
					{
						name: 'vaultEquityBefore';
						type: 'u64';
					},
					{
						name: 'vaultEquityAfter';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'managerUpdateBorrowRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'manager';
						type: 'pubkey';
					},
					{
						name: 'previousBorrowValue';
						type: 'u64';
					},
					{
						name: 'newBorrowValue';
						type: 'u64';
					},
					{
						name: 'vaultEquityBefore';
						type: 'u64';
					},
					{
						name: 'vaultEquityAfter';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'managerUpdateFeesParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'timelockDuration';
						type: 'i64';
					},
					{
						name: 'newManagementFee';
						type: {
							option: 'i64';
						};
					},
					{
						name: 'newProfitShare';
						type: {
							option: 'u32';
						};
					},
					{
						name: 'newHurdleRate';
						type: {
							option: 'u32';
						};
					},
				];
			};
		},
		{
			name: 'marketStatus';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'initialized';
					},
					{
						name: 'active';
					},
					{
						name: 'reduceOnly';
					},
					{
						name: 'settlement';
					},
					{
						name: 'delisted';
					},
				];
			};
		},
		{
			name: 'marketType';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'spot';
					},
					{
						name: 'perp';
					},
				];
			};
		},
		{
			name: 'oracleSource';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'pyth';
					},
					{
						name: 'deprecatedSwitchboard';
					},
					{
						name: 'quoteAsset';
					},
					{
						name: 'pyth1K';
					},
					{
						name: 'pyth1M';
					},
					{
						name: 'pythStableCoin';
					},
					{
						name: 'prelaunch';
					},
					{
						name: 'pythPull';
					},
					{
						name: 'pyth1KPull';
					},
					{
						name: 'pyth1MPull';
					},
					{
						name: 'pythStableCoinPull';
					},
					{
						name: 'deprecatedSwitchboardOnDemand';
					},
					{
						name: 'pythLazer';
					},
					{
						name: 'pythLazer1K';
					},
					{
						name: 'pythLazer1M';
					},
					{
						name: 'pythLazerStableCoin';
					},
				];
			};
		},
		{
			name: 'order';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'slot';
						docs: ['The slot the order was placed'];
						type: 'u64';
					},
					{
						name: 'price';
						docs: [
							'The limit price for the order (can be 0 for market orders)',
							"For orders with an auction, this price isn't used until the auction is complete",
							'precision: PRICE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'baseAssetAmount';
						docs: [
							'The size of the order',
							'precision for perps: BASE_PRECISION',
							'precision for spot: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'baseAssetAmountFilled';
						docs: [
							'The amount of the order filled',
							'precision for perps: BASE_PRECISION',
							'precision for spot: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'quoteAssetAmountFilled';
						docs: [
							'The amount of quote filled for the order',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'triggerPrice';
						docs: [
							'At what price the order will be triggered. Only relevant for trigger orders',
							'precision: PRICE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'auctionStartPrice';
						docs: [
							'The start price for the auction. Only relevant for market/oracle orders',
							'precision: PRICE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'auctionEndPrice';
						docs: [
							'The end price for the auction. Only relevant for market/oracle orders',
							'precision: PRICE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'maxTs';
						docs: ['The time when the order will expire'];
						type: 'i64';
					},
					{
						name: 'oraclePriceOffset';
						docs: [
							'If set, the order limit price is the oracle price + this offset',
							'precision: PRICE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'orderId';
						docs: [
							'The id for the order. Each users has their own order id space',
						];
						type: 'u32';
					},
					{
						name: 'marketIndex';
						docs: ['The perp/spot market index'];
						type: 'u16';
					},
					{
						name: 'status';
						docs: ['Whether the order is open or unused'];
						type: {
							defined: {
								name: 'orderStatus';
							};
						};
					},
					{
						name: 'orderType';
						docs: ['The type of order'];
						type: {
							defined: {
								name: 'orderType';
							};
						};
					},
					{
						name: 'marketType';
						docs: ['Whether market is spot or perp'];
						type: {
							defined: {
								name: 'marketType';
							};
						};
					},
					{
						name: 'userOrderId';
						docs: [
							'User generated order id. Can make it easier to place/cancel orders',
						];
						type: 'u8';
					},
					{
						name: 'existingPositionDirection';
						docs: ['What the users position was when the order was placed'];
						type: {
							defined: {
								name: 'positionDirection';
							};
						};
					},
					{
						name: 'direction';
						docs: [
							'Whether the user is going long or short. LONG = bid, SHORT = ask',
						];
						type: {
							defined: {
								name: 'positionDirection';
							};
						};
					},
					{
						name: 'reduceOnly';
						docs: ['Whether the order is allowed to only reduce position size'];
						type: 'bool';
					},
					{
						name: 'postOnly';
						docs: ['Whether the order must be a maker'];
						type: 'bool';
					},
					{
						name: 'immediateOrCancel';
						docs: [
							'Whether the order must be canceled the same slot it is placed',
						];
						type: 'bool';
					},
					{
						name: 'triggerCondition';
						docs: [
							'Whether the order is triggered above or below the trigger price. Only relevant for trigger orders',
						];
						type: {
							defined: {
								name: 'orderTriggerCondition';
							};
						};
					},
					{
						name: 'auctionDuration';
						docs: ['How many slots the auction lasts'];
						type: 'u8';
					},
					{
						name: 'postedSlotTail';
						docs: [
							'Last 8 bits of the slot the order was posted on-chain (not order slot for signed msg orders)',
						];
						type: 'u8';
					},
					{
						name: 'bitFlags';
						docs: [
							'Bitflags for further classification',
							'0: is_signed_message',
						];
						type: 'u8';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 5];
						};
					},
				];
			};
		},
		{
			name: 'orderStatus';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'init';
					},
					{
						name: 'open';
					},
					{
						name: 'filled';
					},
					{
						name: 'canceled';
					},
				];
			};
		},
		{
			name: 'orderTriggerCondition';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'above';
					},
					{
						name: 'below';
					},
					{
						name: 'triggeredAbove';
					},
					{
						name: 'triggeredBelow';
					},
				];
			};
		},
		{
			name: 'orderType';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'market';
					},
					{
						name: 'limit';
					},
					{
						name: 'triggerMarket';
					},
					{
						name: 'triggerLimit';
					},
					{
						name: 'oracle';
					},
				];
			};
		},
		{
			name: 'perpPosition';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'lastCumulativeFundingRate';
						docs: [
							"The perp market's last cumulative funding rate. Used to calculate the funding payment owed to user",
							'precision: FUNDING_RATE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'baseAssetAmount';
						docs: [
							'the size of the users perp position',
							'precision: BASE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'quoteAssetAmount';
						docs: [
							'Used to calculate the users pnl. Upon entry, is equal to base_asset_amount * avg entry price - fees',
							'Updated when the user open/closes position or settles pnl. Includes fees/funding',
							'precision: QUOTE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'quoteBreakEvenAmount';
						docs: [
							'The amount of quote the user would need to exit their position at to break even',
							'Updated when the user open/closes position or settles pnl. Includes fees/funding',
							'precision: QUOTE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'quoteEntryAmount';
						docs: [
							'The amount quote the user entered the position with. Equal to base asset amount * avg entry price',
							'Updated when the user open/closes position. Excludes fees/funding',
							'precision: QUOTE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'openBids';
						docs: [
							'The amount of non reduce only trigger orders the user has open',
							'precision: BASE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'openAsks';
						docs: [
							'The amount of non reduce only trigger orders the user has open',
							'precision: BASE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'settledPnl';
						docs: [
							'The amount of pnl settled in this market since opening the position',
							'precision: QUOTE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'isolatedPositionScaledBalance';
						docs: [
							'The scaled balance of the isolated position',
							'precision: SPOT_BALANCE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 2];
						};
					},
					{
						name: 'maxMarginRatio';
						type: 'u16';
					},
					{
						name: 'marketIndex';
						docs: ['The market index for the perp market'];
						type: 'u16';
					},
					{
						name: 'openOrders';
						docs: ['The number of open orders'];
						type: 'u8';
					},
					{
						name: 'positionFlag';
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'poolBalance';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'scaledBalance';
						docs: [
							"To get the pool's token amount, you must multiply the scaled balance by the market's cumulative",
							'deposit interest',
							'precision: SPOT_BALANCE_PRECISION',
						];
						type: 'u128';
					},
					{
						name: 'marketIndex';
						docs: ['The spot market the pool is for'];
						type: 'u16';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 14];
						};
					},
				];
			};
		},
		{
			name: 'positionDirection';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'long';
					},
					{
						name: 'short';
					},
				];
			};
		},
		{
			name: 'shareTransferRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'fromVaultDepositor';
						type: 'pubkey';
					},
					{
						name: 'toVaultDepositor';
						type: 'pubkey';
					},
					{
						name: 'shares';
						type: 'u128';
					},
					{
						name: 'value';
						type: 'u64';
					},
					{
						name: 'fromDepositorSharesBefore';
						type: 'u128';
					},
					{
						name: 'fromDepositorSharesAfter';
						type: 'u128';
					},
					{
						name: 'toDepositorSharesBefore';
						type: 'u128';
					},
					{
						name: 'toDepositorSharesAfter';
						type: 'u128';
					},
				];
			};
		},
		{
			name: 'spotBalanceType';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'deposit';
					},
					{
						name: 'borrow';
					},
				];
			};
		},
		{
			name: 'spotMarket';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'pubkey';
						docs: [
							'The address of the spot market. It is a pda of the market index',
						];
						type: 'pubkey';
					},
					{
						name: 'oracle';
						docs: ['The oracle used to price the markets deposits/borrows'];
						type: 'pubkey';
					},
					{
						name: 'mint';
						docs: ['The token mint of the market'];
						type: 'pubkey';
					},
					{
						name: 'vault';
						docs: [
							"The vault used to store the market's deposits",
							'The amount in the vault should be equal to or greater than deposits - borrows',
						];
						type: 'pubkey';
					},
					{
						name: 'name';
						docs: ['The encoded display name for the market e.g. SOL'];
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'insuranceFund';
						docs: [
							'Details on the insurance fund covering bankruptcies in this markets token',
							'Covers bankruptcies for borrows with this markets token and perps settling in this markets token',
						];
						type: {
							defined: {
								name: 'insuranceFund';
							};
						};
					},
					{
						name: 'totalSpotFee';
						docs: [
							'The total spot fees collected for this market',
							'precision: QUOTE_PRECISION',
						];
						type: 'u128';
					},
					{
						name: 'depositBalance';
						docs: [
							'The sum of the scaled balances for deposits across users and pool balances',
							'To convert to the deposit token amount, multiply by the cumulative deposit interest',
							'precision: SPOT_BALANCE_PRECISION',
						];
						type: 'u128';
					},
					{
						name: 'borrowBalance';
						docs: [
							'The sum of the scaled balances for borrows across users and pool balances',
							'To convert to the borrow token amount, multiply by the cumulative borrow interest',
							'precision: SPOT_BALANCE_PRECISION',
						];
						type: 'u128';
					},
					{
						name: 'cumulativeDepositInterest';
						docs: [
							'The cumulative interest earned by depositors',
							'Used to calculate the deposit token amount from the deposit balance',
							'precision: SPOT_CUMULATIVE_INTEREST_PRECISION',
						];
						type: 'u128';
					},
					{
						name: 'cumulativeBorrowInterest';
						docs: [
							'The cumulative interest earned by borrowers',
							'Used to calculate the borrow token amount from the borrow balance',
							'precision: SPOT_CUMULATIVE_INTEREST_PRECISION',
						];
						type: 'u128';
					},
					{
						name: 'totalSocialLoss';
						docs: [
							"The total socialized loss from borrows, in the mint's token",
							'precision: token mint precision',
						];
						type: 'u128';
					},
					{
						name: 'totalQuoteSocialLoss';
						docs: [
							"The total socialized loss from borrows, in the quote market's token",
							'preicision: QUOTE_PRECISION',
						];
						type: 'u128';
					},
					{
						name: 'revenuePool';
						docs: [
							'Revenue the protocol has collected in this markets token',
							'e.g. for SOL-PERP, funds can be settled in usdc and will flow into the USDC revenue pool',
						];
						type: {
							defined: {
								name: 'poolBalance';
							};
						};
					},
					{
						name: 'spotFeePool';
						docs: [
							'The fees collected from swaps between this market and the quote market',
							'Is settled to the quote markets revenue pool',
						];
						type: {
							defined: {
								name: 'poolBalance';
							};
						};
					},
					{
						name: 'historicalOracleData';
						type: {
							defined: {
								name: 'historicalOracleData';
							};
						};
					},
					{
						name: 'historicalIndexData';
						type: {
							defined: {
								name: 'historicalIndexData';
							};
						};
					},
					{
						name: 'withdrawGuardThreshold';
						docs: [
							'no withdraw limits/guards when deposits below this threshold',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'maxTokenDeposits';
						docs: [
							'The max amount of token deposits in this market',
							'0 if there is no limit',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'depositTokenTwap';
						docs: [
							'24hr average of deposit token amount',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'borrowTokenTwap';
						docs: [
							'24hr average of borrow token amount',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'utilizationTwap';
						docs: [
							'24hr average of utilization',
							'which is borrow amount over token amount',
							'precision: SPOT_UTILIZATION_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'lastInterestTs';
						docs: [
							'Last time the cumulative deposit and borrow interest was updated',
						];
						type: 'u64';
					},
					{
						name: 'lastTwapTs';
						docs: [
							'Last time the deposit/borrow/utilization averages were updated',
						];
						type: 'u64';
					},
					{
						name: 'expiryTs';
						docs: [
							'The time the market is set to expire. Only set if market is in reduce only mode',
						];
						type: 'i64';
					},
					{
						name: 'orderStepSize';
						docs: [
							'Spot orders must be a multiple of the step size',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'orderTickSize';
						docs: [
							'Spot orders must be a multiple of the tick size',
							'precision: PRICE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'minOrderSize';
						docs: ['The minimum order size', 'precision: token mint precision'];
						type: 'u64';
					},
					{
						name: 'maxPositionSize';
						docs: [
							'The maximum spot position size',
							'if the limit is 0, there is no limit',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'nextFillRecordId';
						docs: [
							'Every spot trade has a fill record id. This is the next id to use',
						];
						type: 'u64';
					},
					{
						name: 'nextDepositRecordId';
						docs: [
							'Every deposit has a deposit record id. This is the next id to use',
						];
						type: 'u64';
					},
					{
						name: 'initialAssetWeight';
						docs: [
							'The initial asset weight used to calculate a deposits contribution to a users initial total collateral',
							'e.g. if the asset weight is .8, $100 of deposits contributes $80 to the users initial total collateral',
							'precision: SPOT_WEIGHT_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'maintenanceAssetWeight';
						docs: [
							'The maintenance asset weight used to calculate a deposits contribution to a users maintenance total collateral',
							'e.g. if the asset weight is .9, $100 of deposits contributes $90 to the users maintenance total collateral',
							'precision: SPOT_WEIGHT_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'initialLiabilityWeight';
						docs: [
							'The initial liability weight used to calculate a borrows contribution to a users initial margin requirement',
							'e.g. if the liability weight is .9, $100 of borrows contributes $90 to the users initial margin requirement',
							'precision: SPOT_WEIGHT_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'maintenanceLiabilityWeight';
						docs: [
							'The maintenance liability weight used to calculate a borrows contribution to a users maintenance margin requirement',
							'e.g. if the liability weight is .8, $100 of borrows contributes $80 to the users maintenance margin requirement',
							'precision: SPOT_WEIGHT_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'imfFactor';
						docs: [
							'The initial margin fraction factor. Used to increase liability weight/decrease asset weight for large positions',
							'precision: MARGIN_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'liquidatorFee';
						docs: [
							'The fee the liquidator is paid for taking over borrow/deposit',
							'precision: LIQUIDATOR_FEE_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'ifLiquidationFee';
						docs: [
							'The fee the insurance fund receives from liquidation',
							'precision: LIQUIDATOR_FEE_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'optimalUtilization';
						docs: [
							'The optimal utilization rate for this market.',
							'Used to determine the markets borrow rate',
							'precision: SPOT_UTILIZATION_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'optimalBorrowRate';
						docs: [
							'The borrow rate for this market when the market has optimal utilization',
							'precision: SPOT_RATE_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'maxBorrowRate';
						docs: [
							'The borrow rate for this market when the market has 1000 utilization',
							'precision: SPOT_RATE_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'decimals';
						docs: [
							"The market's token mint's decimals. To from decimals to a precision, 10^decimals",
						];
						type: 'u32';
					},
					{
						name: 'marketIndex';
						type: 'u16';
					},
					{
						name: 'ordersEnabled';
						docs: ['Whether or not spot trading is enabled'];
						type: 'bool';
					},
					{
						name: 'oracleSource';
						type: {
							defined: {
								name: 'oracleSource';
							};
						};
					},
					{
						name: 'status';
						type: {
							defined: {
								name: 'marketStatus';
							};
						};
					},
					{
						name: 'assetTier';
						docs: [
							'The asset tier affects how a deposit can be used as collateral and the priority for a borrow being liquidated',
						];
						type: {
							defined: {
								name: 'assetTier';
							};
						};
					},
					{
						name: 'pausedOperations';
						type: 'u8';
					},
					{
						name: 'ifPausedOperations';
						type: 'u8';
					},
					{
						name: 'feeAdjustment';
						type: 'i16';
					},
					{
						name: 'maxTokenBorrowsFraction';
						docs: [
							'What fraction of max_token_deposits',
							'disabled when 0, 1 => 1/10000 => .01% of max_token_deposits',
							'precision: X/10000',
						];
						type: 'u16';
					},
					{
						name: 'flashLoanAmount';
						docs: [
							'For swaps, the amount of token loaned out in the begin_swap ix',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'flashLoanInitialTokenAmount';
						docs: [
							'For swaps, the amount in the users token account in the begin_swap ix',
							'Used to calculate how much of the token left the system in end_swap ix',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'totalSwapFee';
						docs: [
							'The total fees received from swaps',
							'precision: token mint precision',
						];
						type: 'u64';
					},
					{
						name: 'scaleInitialAssetWeightStart';
						docs: [
							'When to begin scaling down the initial asset weight',
							'disabled when 0',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'minBorrowRate';
						docs: [
							'The min borrow rate for this market when the market regardless of utilization',
							'1 => 1/200 => .5%',
							'precision: X/200',
						];
						type: 'u8';
					},
					{
						name: 'tokenProgramFlag';
						type: 'u8';
					},
					{
						name: 'poolId';
						type: 'u8';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 56];
						};
					},
				];
			};
		},
		{
			name: 'spotPosition';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'scaledBalance';
						docs: [
							'The scaled balance of the position. To get the token amount, multiply by the cumulative deposit/borrow',
							'interest of corresponding market.',
							'precision: SPOT_BALANCE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'openBids';
						docs: [
							'How many spot non reduce only trigger orders the user has open',
							'precision: token mint precision',
						];
						type: 'i64';
					},
					{
						name: 'openAsks';
						docs: [
							'How many spot non reduce only trigger orders the user has open',
							'precision: token mint precision',
						];
						type: 'i64';
					},
					{
						name: 'cumulativeDeposits';
						docs: [
							'The cumulative deposits/borrows a user has made into a market',
							'precision: token mint precision',
						];
						type: 'i64';
					},
					{
						name: 'marketIndex';
						docs: ['The market index of the corresponding spot market'];
						type: 'u16';
					},
					{
						name: 'balanceType';
						docs: ['Whether the position is deposit or borrow'];
						type: {
							defined: {
								name: 'spotBalanceType';
							};
						};
					},
					{
						name: 'openOrders';
						docs: ['Number of open orders'];
						type: 'u8';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 4];
						};
					},
				];
			};
		},
		{
			name: 'tokenizedVaultDepositor';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'vault';
						docs: ['The vault deposited into'];
						type: 'pubkey';
					},
					{
						name: 'pubkey';
						docs: [
							"The vault depositor account's pubkey. It is a pda of vault",
						];
						type: 'pubkey';
					},
					{
						name: 'mint';
						docs: [
							'The token mint for tokenized shares owned by this VaultDepositor',
						];
						type: 'pubkey';
					},
					{
						name: 'vaultShares';
						docs: [
							"share of vault owned by this depositor. vault_shares / vault.total_shares is depositor's ownership of vault_equity",
						];
						type: 'u128';
					},
					{
						name: 'lastVaultShares';
						docs: [
							'stores the vault_shares from the most recent liquidity event (redeem or issuance) before a spl token',
							'CPI is done, used to track invariants',
						];
						type: 'u128';
					},
					{
						name: 'lastValidTs';
						docs: ['creation ts of vault depositor'];
						type: 'i64';
					},
					{
						name: 'netDeposits';
						docs: ['lifetime net deposits of vault depositor for the vault'];
						type: 'i64';
					},
					{
						name: 'totalDeposits';
						docs: ['lifetime total deposits'];
						type: 'u64';
					},
					{
						name: 'totalWithdraws';
						docs: ['lifetime total withdraws'];
						type: 'u64';
					},
					{
						name: 'cumulativeProfitShareAmount';
						docs: [
							'the token amount of gains the vault depositor has paid performance fees on',
						];
						type: 'i64';
					},
					{
						name: 'profitShareFeePaid';
						type: 'u64';
					},
					{
						name: 'vaultSharesBase';
						docs: [
							'The exponent for vault_shares decimal places at the time the tokenized vault depositor was initialized.',
							'If the vault undergoes a rebase, this TokenizedVaultDepositor can no longer issue new tokens, only redeem',
							'is possible.',
						];
						type: 'u32';
					},
					{
						name: 'bump';
						docs: ['The bump for the vault pda'];
						type: 'u8';
					},
					{
						name: 'padding1';
						type: {
							array: ['u8', 3];
						};
					},
					{
						name: 'padding';
						type: {
							array: ['u64', 11];
						};
					},
				];
			};
		},
		{
			name: 'updateVaultParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'redeemPeriod';
						type: {
							option: 'i64';
						};
					},
					{
						name: 'maxTokens';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'managementFee';
						type: {
							option: 'i64';
						};
					},
					{
						name: 'minDepositAmount';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'profitShare';
						type: {
							option: 'u32';
						};
					},
					{
						name: 'hurdleRate';
						type: {
							option: 'u32';
						};
					},
					{
						name: 'permissioned';
						type: {
							option: 'bool';
						};
					},
				];
			};
		},
		{
			name: 'updateVaultProtocolParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'protocolFee';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'protocolProfitShare';
						type: {
							option: 'u32';
						};
					},
				];
			};
		},
		{
			name: 'user';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'authority';
						docs: ['The owner/authority of the account'];
						type: 'pubkey';
					},
					{
						name: 'delegate';
						docs: [
							"An addresses that can control the account on the authority's behalf. Has limited power, cant withdraw",
						];
						type: 'pubkey';
					},
					{
						name: 'name';
						docs: ['Encoded display name e.g. "toly"'];
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'spotPositions';
						docs: ["The user's spot positions"];
						type: {
							array: [
								{
									defined: {
										name: 'spotPosition';
									};
								},
								8,
							];
						};
					},
					{
						name: 'perpPositions';
						docs: ["The user's perp positions"];
						type: {
							array: [
								{
									defined: {
										name: 'perpPosition';
									};
								},
								8,
							];
						};
					},
					{
						name: 'orders';
						docs: ["The user's orders"];
						type: {
							array: [
								{
									defined: {
										name: 'order';
									};
								},
								32,
							];
						};
					},
					{
						name: 'totalDeposits';
						docs: [
							'The total values of deposits the user has made',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'totalWithdraws';
						docs: [
							'The total values of withdrawals the user has made',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'totalSocialLoss';
						docs: [
							'The total socialized loss the users has incurred upon the protocol',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'settledPerpPnl';
						docs: [
							'Fees (taker fees, maker rebate, referrer reward, filler reward) and pnl for perps',
							'precision: QUOTE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'cumulativeSpotFees';
						docs: [
							'Fees (taker fees, maker rebate, filler reward) for spot',
							'precision: QUOTE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'cumulativePerpFunding';
						docs: [
							'Cumulative funding paid/received for perps',
							'precision: QUOTE_PRECISION',
						];
						type: 'i64';
					},
					{
						name: 'liquidationMarginFreed';
						docs: [
							'The amount of margin freed during liquidation. Used to force the liquidation to occur over a period of time',
							'Defaults to zero when not being liquidated',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'lastActiveSlot';
						docs: [
							'The last slot a user was active. Used to determine if a user is idle',
						];
						type: 'u64';
					},
					{
						name: 'nextOrderId';
						docs: [
							'Every user order has an order id. This is the next order id to be used',
						];
						type: 'u32';
					},
					{
						name: 'maxMarginRatio';
						docs: ['Custom max initial margin ratio for the user'];
						type: 'u32';
					},
					{
						name: 'nextLiquidationId';
						docs: ['The next liquidation id to be used for user'];
						type: 'u16';
					},
					{
						name: 'subAccountId';
						docs: ['The sub account id for this user'];
						type: 'u16';
					},
					{
						name: 'status';
						docs: ['Whether the user is active, being liquidated or bankrupt'];
						type: 'u8';
					},
					{
						name: 'isMarginTradingEnabled';
						docs: ['Whether the user has enabled margin trading'];
						type: 'bool';
					},
					{
						name: 'idle';
						docs: [
							"User is idle if they haven't interacted with the protocol in 1 week and they have no orders, perp positions or borrows",
							'Off-chain keeper bots can ignore users that are idle',
						];
						type: 'bool';
					},
					{
						name: 'openOrders';
						docs: ['number of open orders'];
						type: 'u8';
					},
					{
						name: 'hasOpenOrder';
						docs: ['Whether or not user has open order'];
						type: 'bool';
					},
					{
						name: 'openAuctions';
						docs: ['number of open orders with auction'];
						type: 'u8';
					},
					{
						name: 'hasOpenAuction';
						docs: ['Whether or not user has open order with auction'];
						type: 'bool';
					},
					{
						name: 'poolId';
						type: 'u8';
					},
					{
						name: 'specialUserStatus';
						docs: ['Whether the user is a special user (vamm hedger, etc)'];
						type: 'u8';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 14];
						};
					},
				];
			};
		},
		{
			name: 'userFees';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'totalFeePaid';
						docs: ['Total taker fee paid', 'precision: QUOTE_PRECISION'];
						type: 'u64';
					},
					{
						name: 'totalFeeRebate';
						docs: ['Total maker fee rebate', 'precision: QUOTE_PRECISION'];
						type: 'u64';
					},
					{
						name: 'totalTokenDiscount';
						docs: [
							'Total discount from holding token',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'totalRefereeDiscount';
						docs: [
							'Total discount from being referred',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'userStats';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'authority';
						docs: ['The authority for all of a users sub accounts'];
						type: 'pubkey';
					},
					{
						name: 'referrer';
						docs: ['The address that referred this user'];
						type: 'pubkey';
					},
					{
						name: 'fees';
						docs: ['Stats on the fees paid by the user'];
						type: {
							defined: {
								name: 'userFees';
							};
						};
					},
					{
						name: 'makerVolume30d';
						docs: [
							'Rolling 30day maker volume for user',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'takerVolume30d';
						docs: [
							'Rolling 30day taker volume for user',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'fillerVolume30d';
						docs: [
							'Rolling 30day filler volume for user',
							'precision: QUOTE_PRECISION',
						];
						type: 'u64';
					},
					{
						name: 'lastMakerVolume30dTs';
						docs: ['last time the maker volume was updated'];
						type: 'i64';
					},
					{
						name: 'lastTakerVolume30dTs';
						docs: ['last time the taker volume was updated'];
						type: 'i64';
					},
					{
						name: 'lastFillerVolume30dTs';
						docs: ['last time the filler volume was updated'];
						type: 'i64';
					},
					{
						name: 'ifStakedQuoteAssetAmount';
						docs: ['The amount of tokens staked in the quote spot markets if'];
						type: 'u64';
					},
					{
						name: 'numberOfSubAccounts';
						docs: ['The current number of sub accounts'];
						type: 'u16';
					},
					{
						name: 'numberOfSubAccountsCreated';
						docs: [
							'The number of sub accounts created. Can be greater than the number of sub accounts if user',
							'has deleted sub accounts',
						];
						type: 'u16';
					},
					{
						name: 'referrerStatus';
						docs: [
							'Flags for referrer status:',
							'First bit (LSB): 1 if user is a referrer, 0 otherwise',
							'Second bit: 1 if user was referred, 0 otherwise',
						];
						type: 'u8';
					},
					{
						name: 'disableUpdatePerpBidAskTwap';
						type: 'u8';
					},
					{
						name: 'pausedOperations';
						type: 'u8';
					},
					{
						name: 'padding1';
						docs: [
							'9 bytes: 1 byte of former repr(C) alignment padding + the removed',
							'8-byte `if_staked_gov_token_amount` field (gov-token stake fee discount)',
						];
						type: {
							array: ['u8', 9];
						};
					},
					{
						name: 'delegatePermissions';
						docs: ['Delegate permissions across all sub accounts'];
						type: 'u8';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 63];
						};
					},
				];
			};
		},
		{
			name: 'vault';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'name';
						docs: [
							'The name of the vault. Vault pubkey is derived from this name.',
						];
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'pubkey';
						docs: [
							"The vault's pubkey. It is a pda of name and also used as the authority for drift user",
						];
						type: 'pubkey';
					},
					{
						name: 'manager';
						docs: [
							'The manager of the vault who has ability to update vault params',
						];
						type: 'pubkey';
					},
					{
						name: 'tokenAccount';
						docs: [
							'The vaults token account. Used to receive tokens between deposits and withdrawals',
						];
						type: 'pubkey';
					},
					{
						name: 'userStats';
						docs: ['The drift user stats account for the vault'];
						type: 'pubkey';
					},
					{
						name: 'user';
						docs: ['The drift user account for the vault'];
						type: 'pubkey';
					},
					{
						name: 'delegate';
						docs: [
							'The vaults designated delegate for drift user account',
							'can differ from actual user delegate if vault is in liquidation',
						];
						type: 'pubkey';
					},
					{
						name: 'liquidationDelegate';
						docs: ['The delegate handling liquidation for depositor'];
						type: 'pubkey';
					},
					{
						name: 'userShares';
						docs: [
							'The sum of all shares held by the users (vault depositors)',
						];
						type: 'u128';
					},
					{
						name: 'totalShares';
						docs: [
							'The sum of all shares: deposits from users, manager deposits, manager profit/fee, and protocol profit/fee.',
							'The manager deposits are total_shares - user_shares - protocol_profit_and_fee_shares.',
						];
						type: 'u128';
					},
					{
						name: 'lastManagerWithdrawRequest';
						type: {
							defined: {
								name: 'withdrawRequest';
							};
						};
					},
					{
						name: 'lastFeeUpdateTs';
						docs: ['Last fee update unix timestamp'];
						type: 'i64';
					},
					{
						name: 'liquidationStartTs';
						docs: ['When the liquidation starts'];
						type: 'i64';
					},
					{
						name: 'redeemPeriod';
						docs: [
							'The period (in seconds) that a vault depositor must wait after requesting a withdrawal to finalize withdrawal.',
							'Currently, the maximum is 90 days.',
						];
						type: 'i64';
					},
					{
						name: 'totalWithdrawRequested';
						docs: ['The sum of all outstanding withdraw requests'];
						type: 'u64';
					},
					{
						name: 'maxTokens';
						docs: [
							'Max token capacity, once hit/passed vault will reject new deposits (updatable)',
						];
						type: 'u64';
					},
					{
						name: 'managementFee';
						docs: [
							'The annual fee charged on deposits by the manager.',
							'Traditional funds typically charge 2% per year on assets under management.',
						];
						type: 'i64';
					},
					{
						name: 'initTs';
						docs: ['Timestamp vault initialized'];
						type: 'i64';
					},
					{
						name: 'netDeposits';
						docs: ['The net deposits for the vault'];
						type: 'i64';
					},
					{
						name: 'managerNetDeposits';
						docs: ['The net deposits for the manager'];
						type: 'i64';
					},
					{
						name: 'totalDeposits';
						docs: ['Total deposits'];
						type: 'u64';
					},
					{
						name: 'totalWithdraws';
						docs: ['Total withdraws'];
						type: 'u64';
					},
					{
						name: 'managerTotalDeposits';
						docs: ['Total deposits for the manager'];
						type: 'u64';
					},
					{
						name: 'managerTotalWithdraws';
						docs: ['Total withdraws for the manager'];
						type: 'u64';
					},
					{
						name: 'managerTotalFee';
						docs: ['Total management fee accrued by the manager'];
						type: 'i64';
					},
					{
						name: 'managerTotalProfitShare';
						docs: ['Total profit share accrued by the manager'];
						type: 'u64';
					},
					{
						name: 'minDepositAmount';
						docs: ['The minimum deposit amount'];
						type: 'u64';
					},
					{
						name: 'managerBorrowedValue';
						docs: [
							'The total value (in deposit asset) of borrows the manager has outstanding.',
							'Purely for informational purposes for assets that have left the vault that the manager',
							'is expected to return.',
						];
						type: 'u64';
					},
					{
						name: 'sharesBase';
						docs: [
							'The base 10 exponent of the shares (given massive share inflation can occur at near zero vault equity)',
						];
						type: 'u32';
					},
					{
						name: 'profitShare';
						docs: [
							'Percentage the manager charges on all profits realized by depositors: PERCENTAGE_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'hurdleRate';
						docs: [
							'Vault manager only collect incentive fees during periods when returns are higher than this amount: PERCENTAGE_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'spotMarketIndex';
						docs: [
							'The spot market index the vault deposits into/withdraws from',
						];
						type: 'u16';
					},
					{
						name: 'bump';
						docs: ['The bump for the vault pda'];
						type: 'u8';
					},
					{
						name: 'permissioned';
						docs: ['Whether anybody can be a depositor'];
						type: 'bool';
					},
					{
						name: 'vaultProtocol';
						docs: ['The optional [`VaultProtocol`] account.'];
						type: 'bool';
					},
					{
						name: 'feeUpdateStatus';
						docs: [
							'Whether the vault has a FeeUpdate account [`FeeUpdateStatus`]. Default is `FeeUpdateStatus::None`',
							'After a `FeeUpdate` account is created and the manager has staged a fee update, the status is set to `PendingFeeUpdate`.',
							'And instructsions that may finalize the fee update must include the `FeeUpdate` account with `remaining_accounts`.',
						];
						type: 'u8';
					},
					{
						name: 'vaultClass';
						docs: [
							'The class of the vault [`VaultClass`]. Default is `VaultClass::Normal`',
						];
						type: 'u8';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 5];
						};
					},
				];
			};
		},
		{
			name: 'vaultDepositor';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'vault';
						docs: ['The vault deposited into'];
						type: 'pubkey';
					},
					{
						name: 'pubkey';
						docs: [
							"The vault depositor account's pubkey. It is a pda of vault and authority",
						];
						type: 'pubkey';
					},
					{
						name: 'authority';
						docs: [
							'The authority is the address w permission to deposit/withdraw',
						];
						type: 'pubkey';
					},
					{
						name: 'vaultShares';
						docs: [
							"share of vault owned by this depositor. vault_shares / vault.total_shares is depositor's ownership of vault_equity",
						];
						type: 'u128';
					},
					{
						name: 'lastWithdrawRequest';
						docs: ['last withdraw request'];
						type: {
							defined: {
								name: 'withdrawRequest';
							};
						};
					},
					{
						name: 'lastValidTs';
						docs: ['creation ts of vault depositor'];
						type: 'i64';
					},
					{
						name: 'netDeposits';
						docs: ['lifetime net deposits of vault depositor for the vault'];
						type: 'i64';
					},
					{
						name: 'totalDeposits';
						docs: ['lifetime total deposits'];
						type: 'u64';
					},
					{
						name: 'totalWithdraws';
						docs: ['lifetime total withdraws'];
						type: 'u64';
					},
					{
						name: 'cumulativeProfitShareAmount';
						docs: [
							'the token amount of gains the vault depositor has paid performance fees on',
						];
						type: 'i64';
					},
					{
						name: 'profitShareFeePaid';
						type: 'u64';
					},
					{
						name: 'vaultSharesBase';
						docs: ['the exponent for vault_shares decimal places'];
						type: 'u32';
					},
					{
						name: 'paddingAlign';
						type: 'u32';
					},
					{
						name: 'padding';
						type: {
							array: ['u64', 5];
						};
					},
				];
			};
		},
		{
			name: 'vaultDepositorAction';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'deposit';
					},
					{
						name: 'withdrawRequest';
					},
					{
						name: 'cancelWithdrawRequest';
					},
					{
						name: 'withdraw';
					},
					{
						name: 'feePayment';
					},
					{
						name: 'tokenizeShares';
					},
					{
						name: 'redeemTokens';
					},
				];
			};
		},
		{
			name: 'vaultDepositorRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'depositorAuthority';
						type: 'pubkey';
					},
					{
						name: 'action';
						type: {
							defined: {
								name: 'vaultDepositorAction';
							};
						};
					},
					{
						name: 'amount';
						type: 'u64';
					},
					{
						name: 'spotMarketIndex';
						type: 'u16';
					},
					{
						name: 'vaultSharesBefore';
						type: 'u128';
					},
					{
						name: 'vaultSharesAfter';
						type: 'u128';
					},
					{
						name: 'vaultEquityBefore';
						type: 'u64';
					},
					{
						name: 'userVaultSharesBefore';
						type: 'u128';
					},
					{
						name: 'totalVaultSharesBefore';
						type: 'u128';
					},
					{
						name: 'userVaultSharesAfter';
						type: 'u128';
					},
					{
						name: 'totalVaultSharesAfter';
						type: 'u128';
					},
					{
						name: 'profitShare';
						type: 'u64';
					},
					{
						name: 'managementFee';
						type: 'i64';
					},
					{
						name: 'managementFeeShares';
						type: 'i64';
					},
					{
						name: 'depositOraclePrice';
						docs: ['precision: PRICE_PRECISION'];
						type: 'i64';
					},
				];
			};
		},
		{
			name: 'vaultDepositorV1Record';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'vault';
						type: 'pubkey';
					},
					{
						name: 'depositorAuthority';
						type: 'pubkey';
					},
					{
						name: 'action';
						type: {
							defined: {
								name: 'vaultDepositorAction';
							};
						};
					},
					{
						name: 'amount';
						type: 'u64';
					},
					{
						name: 'spotMarketIndex';
						type: 'u16';
					},
					{
						name: 'vaultSharesBefore';
						type: 'u128';
					},
					{
						name: 'vaultSharesAfter';
						type: 'u128';
					},
					{
						name: 'vaultEquityBefore';
						type: 'u64';
					},
					{
						name: 'userVaultSharesBefore';
						type: 'u128';
					},
					{
						name: 'totalVaultSharesBefore';
						type: 'u128';
					},
					{
						name: 'userVaultSharesAfter';
						type: 'u128';
					},
					{
						name: 'totalVaultSharesAfter';
						type: 'u128';
					},
					{
						name: 'protocolSharesBefore';
						type: 'u128';
					},
					{
						name: 'protocolSharesAfter';
						type: 'u128';
					},
					{
						name: 'protocolProfitShare';
						type: 'u64';
					},
					{
						name: 'protocolFee';
						type: 'i64';
					},
					{
						name: 'protocolFeeShares';
						type: 'i64';
					},
					{
						name: 'managerProfitShare';
						type: 'u64';
					},
					{
						name: 'managementFee';
						type: 'i64';
					},
					{
						name: 'managementFeeShares';
						type: 'i64';
					},
					{
						name: 'depositOraclePrice';
						docs: ['precision: PRICE_PRECISION'];
						type: 'i64';
					},
				];
			};
		},
		{
			name: 'vaultParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'name';
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'redeemPeriod';
						type: 'i64';
					},
					{
						name: 'maxTokens';
						type: 'u64';
					},
					{
						name: 'managementFee';
						type: 'i64';
					},
					{
						name: 'minDepositAmount';
						type: 'u64';
					},
					{
						name: 'profitShare';
						type: 'u32';
					},
					{
						name: 'hurdleRate';
						type: 'u32';
					},
					{
						name: 'spotMarketIndex';
						type: 'u16';
					},
					{
						name: 'permissioned';
						type: 'bool';
					},
				];
			};
		},
		{
			name: 'vaultProtocol';
			serialization: 'bytemuckunsafe';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'protocol';
						docs: [
							'The protocol, company, or entity that services the product using this vault.',
							'The protocol is not allowed to deposit into the vault but can profit share and collect annual fees just like the manager.',
						];
						type: 'pubkey';
					},
					{
						name: 'protocolProfitAndFeeShares';
						docs: [
							'The shares from profit share and annual fee unclaimed by the protocol.',
						];
						type: 'u128';
					},
					{
						name: 'protocolFee';
						docs: [
							'The annual fee charged on deposits by the protocol (traditional hedge funds typically charge 2% per year on assets under management).',
							"Unlike the management fee this can't be negative.",
						];
						type: 'u64';
					},
					{
						name: 'protocolTotalWithdraws';
						docs: ['Total withdraws for the protocol'];
						type: 'u64';
					},
					{
						name: 'protocolTotalFee';
						docs: [
							'Total fee charged by the protocol (annual management fee + profit share).',
							"Unlike the management fee this can't be negative.",
						];
						type: 'u64';
					},
					{
						name: 'protocolTotalProfitShare';
						docs: ['Total profit share charged by the protocol'];
						type: 'u64';
					},
					{
						name: 'lastProtocolWithdrawRequest';
						type: {
							defined: {
								name: 'withdrawRequest';
							};
						};
					},
					{
						name: 'protocolProfitShare';
						docs: [
							'Percentage the protocol charges on all profits realized by depositors: PERCENTAGE_PRECISION',
						];
						type: 'u32';
					},
					{
						name: 'bump';
						type: 'u8';
					},
					{
						name: 'version';
						type: 'u8';
					},
					{
						name: 'padding';
						type: {
							array: ['u8', 10];
						};
					},
				];
			};
		},
		{
			name: 'vaultProtocolParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'protocol';
						type: 'pubkey';
					},
					{
						name: 'protocolFee';
						type: 'u64';
					},
					{
						name: 'protocolProfitShare';
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'vaultRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'ts';
						type: 'i64';
					},
					{
						name: 'spotMarketIndex';
						type: 'u16';
					},
					{
						name: 'vaultEquityBefore';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'vaultWithProtocolParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'name';
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'redeemPeriod';
						type: 'i64';
					},
					{
						name: 'maxTokens';
						type: 'u64';
					},
					{
						name: 'managementFee';
						type: 'i64';
					},
					{
						name: 'minDepositAmount';
						type: 'u64';
					},
					{
						name: 'profitShare';
						type: 'u32';
					},
					{
						name: 'hurdleRate';
						type: 'u32';
					},
					{
						name: 'spotMarketIndex';
						type: 'u16';
					},
					{
						name: 'permissioned';
						type: 'bool';
					},
					{
						name: 'vaultProtocol';
						type: {
							defined: {
								name: 'vaultProtocolParams';
							};
						};
					},
				];
			};
		},
		{
			name: 'withdrawRequest';
			repr: {
				kind: 'c';
			};
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'shares';
						docs: ['request shares of vault withdraw'];
						type: 'u128';
					},
					{
						name: 'value';
						docs: [
							'requested value (in vault spot_market_index) of shares for withdraw',
						];
						type: 'u64';
					},
					{
						name: 'ts';
						docs: ['request ts of vault withdraw'];
						type: 'i64';
					},
				];
			};
		},
		{
			name: 'withdrawUnit';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'shares';
					},
					{
						name: 'token';
					},
					{
						name: 'sharesPercent';
					},
				];
			};
		},
	];
};
