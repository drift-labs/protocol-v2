export type MarinadeFinance = {
	version: '0.1.0';
	name: 'marinade_finance';
	instructions: [
		{
			name: 'initialize';
			accounts: [
				{
					name: 'creatorAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'reservePda';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'msolMint';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'operationalSolAccount';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'liqPool';
					accounts: [
						{
							name: 'lpMint';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'solLegPda';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'msolLeg';
							isMut: false;
							isSigner: false;
						},
					];
				},
				{
					name: 'treasuryMsolAccount';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'rent';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'data';
					type: {
						defined: 'InitializeData';
					};
				},
			];
		},
		{
			name: 'changeAuthority';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'adminAuthority';
					isMut: false;
					isSigner: true;
				},
			];
			args: [
				{
					name: 'data';
					type: {
						defined: 'ChangeAuthorityData';
					};
				},
			];
		},
		{
			name: 'addValidator';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'managerAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorVote';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'duplicationFlag';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'rentPayer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'rent';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'score';
					type: 'u32';
				},
			];
		},
		{
			name: 'removeValidator';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'managerAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'duplicationFlag';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'operationalSolAccount';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'index';
					type: 'u32';
				},
				{
					name: 'validatorVote';
					type: 'publicKey';
				},
			];
		},
		{
			name: 'setValidatorScore';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'managerAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'index';
					type: 'u32';
				},
				{
					name: 'validatorVote';
					type: 'publicKey';
				},
				{
					name: 'score';
					type: 'u32';
				},
			];
		},
		{
			name: 'configValidatorSystem';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'managerAuthority';
					isMut: false;
					isSigner: true;
				},
			];
			args: [
				{
					name: 'extraRuns';
					type: 'u32';
				},
			];
		},
		{
			name: 'deposit';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'msolMint';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolSolLegPda';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolMsolLeg';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolMsolLegAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'reservePda';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'transferFrom';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'mintTo';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'msolMintAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'tokenProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'lamports';
					type: 'u64';
				},
			];
		},
		{
			name: 'depositStakeAccount';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'duplicationFlag';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'rentPayer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'msolMint';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'mintTo';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'msolMintAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'rent';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'tokenProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'validatorIndex';
					type: 'u32';
				},
			];
		},
		{
			name: 'liquidUnstake';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'msolMint';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolSolLegPda';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolMsolLeg';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'treasuryMsolAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'getMsolFrom';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'getMsolFromAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'transferSolTo';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'tokenProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'msolAmount';
					type: 'u64';
				},
			];
		},
		{
			name: 'addLiquidity';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'lpMint';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'lpMintAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'liqPoolMsolLeg';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'liqPoolSolLegPda';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'transferFrom';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'mintTo';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'tokenProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'lamports';
					type: 'u64';
				},
			];
		},
		{
			name: 'removeLiquidity';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'lpMint';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'burnFrom';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'burnFromAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'transferSolTo';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'transferMsolTo';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolSolLegPda';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolMsolLeg';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'liqPoolMsolLegAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'tokenProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'tokens';
					type: 'u64';
				},
			];
		},
		{
			name: 'configLp';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'adminAuthority';
					isMut: false;
					isSigner: true;
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: 'ConfigLpParams';
					};
				},
			];
		},
		{
			name: 'configMarinade';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'adminAuthority';
					isMut: false;
					isSigner: true;
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: 'ConfigMarinadeParams';
					};
				},
			];
		},
		{
			name: 'orderUnstake';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'msolMint';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'burnMsolFrom';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'burnMsolAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'newTicketAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'rent';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'tokenProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'msolAmount';
					type: 'u64';
				},
			];
		},
		{
			name: 'claim';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'reservePda';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'ticketAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'transferSolTo';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [];
		},
		{
			name: 'stakeReserve';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorVote';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'reservePda';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeDepositAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'epochSchedule';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'rent';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeHistory';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeConfig';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'validatorIndex';
					type: 'u32';
				},
			];
		},
		{
			name: 'updateActive';
			accounts: [
				{
					name: 'common';
					accounts: [
						{
							name: 'state';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'stakeList';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'stakeAccount';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'stakeWithdrawAuthority';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'reservePda';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'msolMint';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'msolMintAuthority';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'treasuryMsolAccount';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'clock';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'stakeHistory';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'stakeProgram';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'tokenProgram';
							isMut: false;
							isSigner: false;
						},
					];
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'stakeIndex';
					type: 'u32';
				},
				{
					name: 'validatorIndex';
					type: 'u32';
				},
			];
		},
		{
			name: 'updateDeactivated';
			accounts: [
				{
					name: 'common';
					accounts: [
						{
							name: 'state';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'stakeList';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'stakeAccount';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'stakeWithdrawAuthority';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'reservePda';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'msolMint';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'msolMintAuthority';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'treasuryMsolAccount';
							isMut: true;
							isSigner: false;
						},
						{
							name: 'clock';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'stakeHistory';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'stakeProgram';
							isMut: false;
							isSigner: false;
						},
						{
							name: 'tokenProgram';
							isMut: false;
							isSigner: false;
						},
					];
				},
				{
					name: 'operationalSolAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'stakeIndex';
					type: 'u32';
				},
			];
		},
		{
			name: 'deactivateStake';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'reservePda';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeDepositAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'splitStakeAccount';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'splitStakeRentPayer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'rent';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'epochSchedule';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeHistory';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'stakeIndex';
					type: 'u32';
				},
				{
					name: 'validatorIndex';
					type: 'u32';
				},
			];
		},
		{
			name: 'emergencyUnstake';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorManagerAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeDepositAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'stakeIndex';
					type: 'u32';
				},
				{
					name: 'validatorIndex';
					type: 'u32';
				},
			];
		},
		{
			name: 'partialUnstake';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorManagerAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeDepositAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'reservePda';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'splitStakeAccount';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'splitStakeRentPayer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'rent';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeHistory';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'stakeIndex';
					type: 'u32';
				},
				{
					name: 'validatorIndex';
					type: 'u32';
				},
				{
					name: 'desiredUnstakeAmount';
					type: 'u64';
				},
			];
		},
		{
			name: 'mergeStakes';
			accounts: [
				{
					name: 'state';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'validatorList';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'destinationStake';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'sourceStake';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'stakeDepositAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeWithdrawAuthority';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'operationalSolAccount';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'clock';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeHistory';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'stakeProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'destinationStakeIndex';
					type: 'u32';
				},
				{
					name: 'sourceStakeIndex';
					type: 'u32';
				},
				{
					name: 'validatorIndex';
					type: 'u32';
				},
			];
		},
	];
	accounts: [
		{
			name: 'state';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'msolMint';
						type: 'publicKey';
					},
					{
						name: 'adminAuthority';
						type: 'publicKey';
					},
					{
						name: 'operationalSolAccount';
						type: 'publicKey';
					},
					{
						name: 'treasuryMsolAccount';
						type: 'publicKey';
					},
					{
						name: 'reserveBumpSeed';
						type: 'u8';
					},
					{
						name: 'msolMintAuthorityBumpSeed';
						type: 'u8';
					},
					{
						name: 'rentExemptForTokenAcc';
						type: 'u64';
					},
					{
						name: 'rewardFee';
						type: {
							defined: 'Fee';
						};
					},
					{
						name: 'stakeSystem';
						type: {
							defined: 'StakeSystem';
						};
					},
					{
						name: 'validatorSystem';
						type: {
							defined: 'ValidatorSystem';
						};
					},
					{
						name: 'liqPool';
						type: {
							defined: 'LiqPool';
						};
					},
					{
						name: 'availableReserveBalance';
						type: 'u64';
					},
					{
						name: 'msolSupply';
						type: 'u64';
					},
					{
						name: 'msolPrice';
						type: 'u64';
					},
					{
						name: 'circulatingTicketCount';
						docs: ['count tickets for delayed-unstake'];
						type: 'u64';
					},
					{
						name: 'circulatingTicketBalance';
						docs: [
							'total lamports amount of generated and not claimed yet tickets',
						];
						type: 'u64';
					},
					{
						name: 'lentFromReserve';
						type: 'u64';
					},
					{
						name: 'minDeposit';
						type: 'u64';
					},
					{
						name: 'minWithdraw';
						type: 'u64';
					},
					{
						name: 'stakingSolCap';
						type: 'u64';
					},
					{
						name: 'emergencyCoolingDown';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'ticketAccountData';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'stateAddress';
						type: 'publicKey';
					},
					{
						name: 'beneficiary';
						type: 'publicKey';
					},
					{
						name: 'lamportsAmount';
						type: 'u64';
					},
					{
						name: 'createdEpoch';
						type: 'u64';
					},
				];
			};
		},
	];
	types: [
		{
			name: 'LiqPool';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'lpMint';
						type: 'publicKey';
					},
					{
						name: 'lpMintAuthorityBumpSeed';
						type: 'u8';
					},
					{
						name: 'solLegBumpSeed';
						type: 'u8';
					},
					{
						name: 'msolLegAuthorityBumpSeed';
						type: 'u8';
					},
					{
						name: 'msolLeg';
						type: 'publicKey';
					},
					{
						name: 'lpLiquidityTarget';
						docs: [
							'Liquidity target. If the Liquidity reach this amount, the fee reaches lp_min_discount_fee',
						];
						type: 'u64';
					},
					{
						name: 'lpMaxFee';
						docs: ['Liquidity pool max fee'];
						type: {
							defined: 'Fee';
						};
					},
					{
						name: 'lpMinFee';
						docs: ['SOL/mSOL Liquidity pool min fee'];
						type: {
							defined: 'Fee';
						};
					},
					{
						name: 'treasuryCut';
						docs: ['Treasury cut'];
						type: {
							defined: 'Fee';
						};
					},
					{
						name: 'lpSupply';
						type: 'u64';
					},
					{
						name: 'lentFromSolLeg';
						type: 'u64';
					},
					{
						name: 'liquiditySolCap';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'List';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'account';
						type: 'publicKey';
					},
					{
						name: 'itemSize';
						type: 'u32';
					},
					{
						name: 'count';
						type: 'u32';
					},
					{
						name: 'newAccount';
						type: 'publicKey';
					},
					{
						name: 'copiedCount';
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'StakeRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'stakeAccount';
						type: 'publicKey';
					},
					{
						name: 'lastUpdateDelegatedLamports';
						type: 'u64';
					},
					{
						name: 'lastUpdateEpoch';
						type: 'u64';
					},
					{
						name: 'isEmergencyUnstaking';
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'StakeSystem';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'stakeList';
						type: {
							defined: 'List';
						};
					},
					{
						name: 'delayedUnstakeCoolingDown';
						type: 'u64';
					},
					{
						name: 'stakeDepositBumpSeed';
						type: 'u8';
					},
					{
						name: 'stakeWithdrawBumpSeed';
						type: 'u8';
					},
					{
						name: 'slotsForStakeDelta';
						docs: [
							'set by admin, how much slots before the end of the epoch, stake-delta can start',
						];
						type: 'u64';
					},
					{
						name: 'lastStakeDeltaEpoch';
						docs: [
							'Marks the start of stake-delta operations, meaning that if somebody starts a delayed-unstake ticket',
							'after this var is set with epoch_num the ticket will have epoch_created = current_epoch+1',
							'(the user must wait one more epoch, because their unstake-delta will be execute in this epoch)',
						];
						type: 'u64';
					},
					{
						name: 'minStake';
						type: 'u64';
					},
					{
						name: 'extraStakeDeltaRuns';
						docs: [
							'can be set by validator-manager-auth to allow a second run of stake-delta to stake late stakers in the last minute of the epoch',
							"so we maximize user's rewards",
						];
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'ValidatorRecord';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'validatorAccount';
						docs: ['Validator vote pubkey'];
						type: 'publicKey';
					},
					{
						name: 'activeBalance';
						docs: ['Validator total balance in lamports'];
						type: 'u64';
					},
					{
						name: 'score';
						type: 'u32';
					},
					{
						name: 'lastStakeDeltaEpoch';
						type: 'u64';
					},
					{
						name: 'duplicationFlagBumpSeed';
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'ValidatorSystem';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'validatorList';
						type: {
							defined: 'List';
						};
					},
					{
						name: 'managerAuthority';
						type: 'publicKey';
					},
					{
						name: 'totalValidatorScore';
						type: 'u32';
					},
					{
						name: 'totalActiveBalance';
						docs: ['sum of all active lamports staked'];
						type: 'u64';
					},
					{
						name: 'autoAddValidatorEnabled';
						docs: [
							'allow & auto-add validator when a user deposits a stake-account of a non-listed validator',
						];
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'Fee';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'basisPoints';
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'InitializeData';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'adminAuthority';
						type: 'publicKey';
					},
					{
						name: 'validatorManagerAuthority';
						type: 'publicKey';
					},
					{
						name: 'minStake';
						type: 'u64';
					},
					{
						name: 'rewardFee';
						type: {
							defined: 'Fee';
						};
					},
					{
						name: 'liqPool';
						type: {
							defined: 'LiqPoolInitializeData';
						};
					},
					{
						name: 'additionalStakeRecordSpace';
						type: 'u32';
					},
					{
						name: 'additionalValidatorRecordSpace';
						type: 'u32';
					},
					{
						name: 'slotsForStakeDelta';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'LiqPoolInitializeData';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'lpLiquidityTarget';
						type: 'u64';
					},
					{
						name: 'lpMaxFee';
						type: {
							defined: 'Fee';
						};
					},
					{
						name: 'lpMinFee';
						type: {
							defined: 'Fee';
						};
					},
					{
						name: 'lpTreasuryCut';
						type: {
							defined: 'Fee';
						};
					},
				];
			};
		},
		{
			name: 'ChangeAuthorityData';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'admin';
						type: {
							option: 'publicKey';
						};
					},
					{
						name: 'validatorManager';
						type: {
							option: 'publicKey';
						};
					},
					{
						name: 'operationalSolAccount';
						type: {
							option: 'publicKey';
						};
					},
					{
						name: 'treasuryMsolAccount';
						type: {
							option: 'publicKey';
						};
					},
				];
			};
		},
		{
			name: 'ConfigLpParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'minFee';
						type: {
							option: {
								defined: 'Fee';
							};
						};
					},
					{
						name: 'maxFee';
						type: {
							option: {
								defined: 'Fee';
							};
						};
					},
					{
						name: 'liquidityTarget';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'treasuryCut';
						type: {
							option: {
								defined: 'Fee';
							};
						};
					},
				];
			};
		},
		{
			name: 'ConfigMarinadeParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'rewardsFee';
						type: {
							option: {
								defined: 'Fee';
							};
						};
					},
					{
						name: 'slotsForStakeDelta';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'minStake';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'minDeposit';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'minWithdraw';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'stakingSolCap';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'liquiditySolCap';
						type: {
							option: 'u64';
						};
					},
					{
						name: 'autoAddValidatorEnabled';
						type: {
							option: 'bool';
						};
					},
				];
			};
		},
		{
			name: 'CommonError';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'WrongReserveOwner';
					},
					{
						name: 'NonEmptyReserveData';
					},
					{
						name: 'InvalidInitialReserveLamports';
					},
					{
						name: 'ZeroValidatorChunkSize';
					},
					{
						name: 'TooBigValidatorChunkSize';
					},
					{
						name: 'ZeroCreditChunkSize';
					},
					{
						name: 'TooBigCreditChunkSize';
					},
					{
						name: 'TooLowCreditFee';
					},
					{
						name: 'InvalidMintAuthority';
					},
					{
						name: 'MintHasInitialSupply';
					},
					{
						name: 'InvalidOwnerFeeState';
					},
					{
						name: 'InvalidProgramId';
					},
					{
						name: 'UnexpectedAccount';
					},
					{
						name: 'CalculationFailure';
					},
					{
						name: 'AccountWithLockup';
					},
					{
						name: 'NumberTooLow';
					},
					{
						name: 'NumberTooHigh';
					},
					{
						name: 'FeeTooHigh';
					},
					{
						name: 'FeesWrongWayRound';
					},
					{
						name: 'LiquidityTargetTooLow';
					},
					{
						name: 'TicketNotDue';
					},
					{
						name: 'TicketNotReady';
					},
					{
						name: 'WrongBeneficiary';
					},
					{
						name: 'StakeAccountNotUpdatedYet';
					},
					{
						name: 'StakeNotDelegated';
					},
					{
						name: 'StakeAccountIsEmergencyUnstaking';
					},
					{
						name: 'InsufficientLiquidity';
					},
					{
						name: 'InvalidValidator';
					},
				];
			};
		},
	];
};

export const IDL: MarinadeFinance = {
	version: '0.1.0',
	name: 'marinade_finance',
	instructions: [
		{
			name: 'initialize',
			accounts: [
				{
					name: 'creatorAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'reservePda',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'msolMint',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'operationalSolAccount',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'liqPool',
					accounts: [
						{
							name: 'lpMint',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'solLegPda',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'msolLeg',
							isMut: false,
							isSigner: false,
						},
					],
				},
				{
					name: 'treasuryMsolAccount',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'rent',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'data',
					type: {
						defined: 'InitializeData',
					},
				},
			],
		},
		{
			name: 'changeAuthority',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'adminAuthority',
					isMut: false,
					isSigner: true,
				},
			],
			args: [
				{
					name: 'data',
					type: {
						defined: 'ChangeAuthorityData',
					},
				},
			],
		},
		{
			name: 'addValidator',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'managerAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorVote',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'duplicationFlag',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'rentPayer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'rent',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'score',
					type: 'u32',
				},
			],
		},
		{
			name: 'removeValidator',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'managerAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'duplicationFlag',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'operationalSolAccount',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'index',
					type: 'u32',
				},
				{
					name: 'validatorVote',
					type: 'publicKey',
				},
			],
		},
		{
			name: 'setValidatorScore',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'managerAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'index',
					type: 'u32',
				},
				{
					name: 'validatorVote',
					type: 'publicKey',
				},
				{
					name: 'score',
					type: 'u32',
				},
			],
		},
		{
			name: 'configValidatorSystem',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'managerAuthority',
					isMut: false,
					isSigner: true,
				},
			],
			args: [
				{
					name: 'extraRuns',
					type: 'u32',
				},
			],
		},
		{
			name: 'deposit',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'msolMint',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolSolLegPda',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolMsolLeg',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolMsolLegAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'reservePda',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'transferFrom',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'mintTo',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'msolMintAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'tokenProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'lamports',
					type: 'u64',
				},
			],
		},
		{
			name: 'depositStakeAccount',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'duplicationFlag',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'rentPayer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'msolMint',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'mintTo',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'msolMintAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'rent',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'tokenProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'validatorIndex',
					type: 'u32',
				},
			],
		},
		{
			name: 'liquidUnstake',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'msolMint',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolSolLegPda',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolMsolLeg',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'treasuryMsolAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'getMsolFrom',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'getMsolFromAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'transferSolTo',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'tokenProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'msolAmount',
					type: 'u64',
				},
			],
		},
		{
			name: 'addLiquidity',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'lpMint',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'lpMintAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'liqPoolMsolLeg',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'liqPoolSolLegPda',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'transferFrom',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'mintTo',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'tokenProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'lamports',
					type: 'u64',
				},
			],
		},
		{
			name: 'removeLiquidity',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'lpMint',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'burnFrom',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'burnFromAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'transferSolTo',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'transferMsolTo',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolSolLegPda',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolMsolLeg',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'liqPoolMsolLegAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'tokenProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'tokens',
					type: 'u64',
				},
			],
		},
		{
			name: 'configLp',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'adminAuthority',
					isMut: false,
					isSigner: true,
				},
			],
			args: [
				{
					name: 'params',
					type: {
						defined: 'ConfigLpParams',
					},
				},
			],
		},
		{
			name: 'configMarinade',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'adminAuthority',
					isMut: false,
					isSigner: true,
				},
			],
			args: [
				{
					name: 'params',
					type: {
						defined: 'ConfigMarinadeParams',
					},
				},
			],
		},
		{
			name: 'orderUnstake',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'msolMint',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'burnMsolFrom',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'burnMsolAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'newTicketAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'rent',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'tokenProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'msolAmount',
					type: 'u64',
				},
			],
		},
		{
			name: 'claim',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'reservePda',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'ticketAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'transferSolTo',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [],
		},
		{
			name: 'stakeReserve',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorVote',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'reservePda',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeDepositAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'epochSchedule',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'rent',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeHistory',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeConfig',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'validatorIndex',
					type: 'u32',
				},
			],
		},
		{
			name: 'updateActive',
			accounts: [
				{
					name: 'common',
					accounts: [
						{
							name: 'state',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'stakeList',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'stakeAccount',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'stakeWithdrawAuthority',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'reservePda',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'msolMint',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'msolMintAuthority',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'treasuryMsolAccount',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'clock',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'stakeHistory',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'stakeProgram',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'tokenProgram',
							isMut: false,
							isSigner: false,
						},
					],
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'stakeIndex',
					type: 'u32',
				},
				{
					name: 'validatorIndex',
					type: 'u32',
				},
			],
		},
		{
			name: 'updateDeactivated',
			accounts: [
				{
					name: 'common',
					accounts: [
						{
							name: 'state',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'stakeList',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'stakeAccount',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'stakeWithdrawAuthority',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'reservePda',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'msolMint',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'msolMintAuthority',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'treasuryMsolAccount',
							isMut: true,
							isSigner: false,
						},
						{
							name: 'clock',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'stakeHistory',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'stakeProgram',
							isMut: false,
							isSigner: false,
						},
						{
							name: 'tokenProgram',
							isMut: false,
							isSigner: false,
						},
					],
				},
				{
					name: 'operationalSolAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'stakeIndex',
					type: 'u32',
				},
			],
		},
		{
			name: 'deactivateStake',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'reservePda',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeDepositAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'splitStakeAccount',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'splitStakeRentPayer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'rent',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'epochSchedule',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeHistory',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'stakeIndex',
					type: 'u32',
				},
				{
					name: 'validatorIndex',
					type: 'u32',
				},
			],
		},
		{
			name: 'emergencyUnstake',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorManagerAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeDepositAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'stakeIndex',
					type: 'u32',
				},
				{
					name: 'validatorIndex',
					type: 'u32',
				},
			],
		},
		{
			name: 'partialUnstake',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorManagerAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeDepositAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'reservePda',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'splitStakeAccount',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'splitStakeRentPayer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'rent',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeHistory',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'stakeIndex',
					type: 'u32',
				},
				{
					name: 'validatorIndex',
					type: 'u32',
				},
				{
					name: 'desiredUnstakeAmount',
					type: 'u64',
				},
			],
		},
		{
			name: 'mergeStakes',
			accounts: [
				{
					name: 'state',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'validatorList',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'destinationStake',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'sourceStake',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'stakeDepositAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeWithdrawAuthority',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'operationalSolAccount',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'clock',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeHistory',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'stakeProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'destinationStakeIndex',
					type: 'u32',
				},
				{
					name: 'sourceStakeIndex',
					type: 'u32',
				},
				{
					name: 'validatorIndex',
					type: 'u32',
				},
			],
		},
	],
	accounts: [
		{
			name: 'state',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'msolMint',
						type: 'publicKey',
					},
					{
						name: 'adminAuthority',
						type: 'publicKey',
					},
					{
						name: 'operationalSolAccount',
						type: 'publicKey',
					},
					{
						name: 'treasuryMsolAccount',
						type: 'publicKey',
					},
					{
						name: 'reserveBumpSeed',
						type: 'u8',
					},
					{
						name: 'msolMintAuthorityBumpSeed',
						type: 'u8',
					},
					{
						name: 'rentExemptForTokenAcc',
						type: 'u64',
					},
					{
						name: 'rewardFee',
						type: {
							defined: 'Fee',
						},
					},
					{
						name: 'stakeSystem',
						type: {
							defined: 'StakeSystem',
						},
					},
					{
						name: 'validatorSystem',
						type: {
							defined: 'ValidatorSystem',
						},
					},
					{
						name: 'liqPool',
						type: {
							defined: 'LiqPool',
						},
					},
					{
						name: 'availableReserveBalance',
						type: 'u64',
					},
					{
						name: 'msolSupply',
						type: 'u64',
					},
					{
						name: 'msolPrice',
						type: 'u64',
					},
					{
						name: 'circulatingTicketCount',
						docs: ['count tickets for delayed-unstake'],
						type: 'u64',
					},
					{
						name: 'circulatingTicketBalance',
						docs: [
							'total lamports amount of generated and not claimed yet tickets',
						],
						type: 'u64',
					},
					{
						name: 'lentFromReserve',
						type: 'u64',
					},
					{
						name: 'minDeposit',
						type: 'u64',
					},
					{
						name: 'minWithdraw',
						type: 'u64',
					},
					{
						name: 'stakingSolCap',
						type: 'u64',
					},
					{
						name: 'emergencyCoolingDown',
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'ticketAccountData',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'stateAddress',
						type: 'publicKey',
					},
					{
						name: 'beneficiary',
						type: 'publicKey',
					},
					{
						name: 'lamportsAmount',
						type: 'u64',
					},
					{
						name: 'createdEpoch',
						type: 'u64',
					},
				],
			},
		},
	],
	types: [
		{
			name: 'LiqPool',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'lpMint',
						type: 'publicKey',
					},
					{
						name: 'lpMintAuthorityBumpSeed',
						type: 'u8',
					},
					{
						name: 'solLegBumpSeed',
						type: 'u8',
					},
					{
						name: 'msolLegAuthorityBumpSeed',
						type: 'u8',
					},
					{
						name: 'msolLeg',
						type: 'publicKey',
					},
					{
						name: 'lpLiquidityTarget',
						docs: [
							'Liquidity target. If the Liquidity reach this amount, the fee reaches lp_min_discount_fee',
						],
						type: 'u64',
					},
					{
						name: 'lpMaxFee',
						docs: ['Liquidity pool max fee'],
						type: {
							defined: 'Fee',
						},
					},
					{
						name: 'lpMinFee',
						docs: ['SOL/mSOL Liquidity pool min fee'],
						type: {
							defined: 'Fee',
						},
					},
					{
						name: 'treasuryCut',
						docs: ['Treasury cut'],
						type: {
							defined: 'Fee',
						},
					},
					{
						name: 'lpSupply',
						type: 'u64',
					},
					{
						name: 'lentFromSolLeg',
						type: 'u64',
					},
					{
						name: 'liquiditySolCap',
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'List',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'account',
						type: 'publicKey',
					},
					{
						name: 'itemSize',
						type: 'u32',
					},
					{
						name: 'count',
						type: 'u32',
					},
					{
						name: 'newAccount',
						type: 'publicKey',
					},
					{
						name: 'copiedCount',
						type: 'u32',
					},
				],
			},
		},
		{
			name: 'StakeRecord',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'stakeAccount',
						type: 'publicKey',
					},
					{
						name: 'lastUpdateDelegatedLamports',
						type: 'u64',
					},
					{
						name: 'lastUpdateEpoch',
						type: 'u64',
					},
					{
						name: 'isEmergencyUnstaking',
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'StakeSystem',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'stakeList',
						type: {
							defined: 'List',
						},
					},
					{
						name: 'delayedUnstakeCoolingDown',
						type: 'u64',
					},
					{
						name: 'stakeDepositBumpSeed',
						type: 'u8',
					},
					{
						name: 'stakeWithdrawBumpSeed',
						type: 'u8',
					},
					{
						name: 'slotsForStakeDelta',
						docs: [
							'set by admin, how much slots before the end of the epoch, stake-delta can start',
						],
						type: 'u64',
					},
					{
						name: 'lastStakeDeltaEpoch',
						docs: [
							'Marks the start of stake-delta operations, meaning that if somebody starts a delayed-unstake ticket',
							'after this var is set with epoch_num the ticket will have epoch_created = current_epoch+1',
							'(the user must wait one more epoch, because their unstake-delta will be execute in this epoch)',
						],
						type: 'u64',
					},
					{
						name: 'minStake',
						type: 'u64',
					},
					{
						name: 'extraStakeDeltaRuns',
						docs: [
							'can be set by validator-manager-auth to allow a second run of stake-delta to stake late stakers in the last minute of the epoch',
							"so we maximize user's rewards",
						],
						type: 'u32',
					},
				],
			},
		},
		{
			name: 'ValidatorRecord',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'validatorAccount',
						docs: ['Validator vote pubkey'],
						type: 'publicKey',
					},
					{
						name: 'activeBalance',
						docs: ['Validator total balance in lamports'],
						type: 'u64',
					},
					{
						name: 'score',
						type: 'u32',
					},
					{
						name: 'lastStakeDeltaEpoch',
						type: 'u64',
					},
					{
						name: 'duplicationFlagBumpSeed',
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'ValidatorSystem',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'validatorList',
						type: {
							defined: 'List',
						},
					},
					{
						name: 'managerAuthority',
						type: 'publicKey',
					},
					{
						name: 'totalValidatorScore',
						type: 'u32',
					},
					{
						name: 'totalActiveBalance',
						docs: ['sum of all active lamports staked'],
						type: 'u64',
					},
					{
						name: 'autoAddValidatorEnabled',
						docs: [
							'allow & auto-add validator when a user deposits a stake-account of a non-listed validator',
						],
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'Fee',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'basisPoints',
						type: 'u32',
					},
				],
			},
		},
		{
			name: 'InitializeData',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'adminAuthority',
						type: 'publicKey',
					},
					{
						name: 'validatorManagerAuthority',
						type: 'publicKey',
					},
					{
						name: 'minStake',
						type: 'u64',
					},
					{
						name: 'rewardFee',
						type: {
							defined: 'Fee',
						},
					},
					{
						name: 'liqPool',
						type: {
							defined: 'LiqPoolInitializeData',
						},
					},
					{
						name: 'additionalStakeRecordSpace',
						type: 'u32',
					},
					{
						name: 'additionalValidatorRecordSpace',
						type: 'u32',
					},
					{
						name: 'slotsForStakeDelta',
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'LiqPoolInitializeData',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'lpLiquidityTarget',
						type: 'u64',
					},
					{
						name: 'lpMaxFee',
						type: {
							defined: 'Fee',
						},
					},
					{
						name: 'lpMinFee',
						type: {
							defined: 'Fee',
						},
					},
					{
						name: 'lpTreasuryCut',
						type: {
							defined: 'Fee',
						},
					},
				],
			},
		},
		{
			name: 'ChangeAuthorityData',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'admin',
						type: {
							option: 'publicKey',
						},
					},
					{
						name: 'validatorManager',
						type: {
							option: 'publicKey',
						},
					},
					{
						name: 'operationalSolAccount',
						type: {
							option: 'publicKey',
						},
					},
					{
						name: 'treasuryMsolAccount',
						type: {
							option: 'publicKey',
						},
					},
				],
			},
		},
		{
			name: 'ConfigLpParams',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'minFee',
						type: {
							option: {
								defined: 'Fee',
							},
						},
					},
					{
						name: 'maxFee',
						type: {
							option: {
								defined: 'Fee',
							},
						},
					},
					{
						name: 'liquidityTarget',
						type: {
							option: 'u64',
						},
					},
					{
						name: 'treasuryCut',
						type: {
							option: {
								defined: 'Fee',
							},
						},
					},
				],
			},
		},
		{
			name: 'ConfigMarinadeParams',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'rewardsFee',
						type: {
							option: {
								defined: 'Fee',
							},
						},
					},
					{
						name: 'slotsForStakeDelta',
						type: {
							option: 'u64',
						},
					},
					{
						name: 'minStake',
						type: {
							option: 'u64',
						},
					},
					{
						name: 'minDeposit',
						type: {
							option: 'u64',
						},
					},
					{
						name: 'minWithdraw',
						type: {
							option: 'u64',
						},
					},
					{
						name: 'stakingSolCap',
						type: {
							option: 'u64',
						},
					},
					{
						name: 'liquiditySolCap',
						type: {
							option: 'u64',
						},
					},
					{
						name: 'autoAddValidatorEnabled',
						type: {
							option: 'bool',
						},
					},
				],
			},
		},
		{
			name: 'CommonError',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'WrongReserveOwner',
					},
					{
						name: 'NonEmptyReserveData',
					},
					{
						name: 'InvalidInitialReserveLamports',
					},
					{
						name: 'ZeroValidatorChunkSize',
					},
					{
						name: 'TooBigValidatorChunkSize',
					},
					{
						name: 'ZeroCreditChunkSize',
					},
					{
						name: 'TooBigCreditChunkSize',
					},
					{
						name: 'TooLowCreditFee',
					},
					{
						name: 'InvalidMintAuthority',
					},
					{
						name: 'MintHasInitialSupply',
					},
					{
						name: 'InvalidOwnerFeeState',
					},
					{
						name: 'InvalidProgramId',
					},
					{
						name: 'UnexpectedAccount',
					},
					{
						name: 'CalculationFailure',
					},
					{
						name: 'AccountWithLockup',
					},
					{
						name: 'NumberTooLow',
					},
					{
						name: 'NumberTooHigh',
					},
					{
						name: 'FeeTooHigh',
					},
					{
						name: 'FeesWrongWayRound',
					},
					{
						name: 'LiquidityTargetTooLow',
					},
					{
						name: 'TicketNotDue',
					},
					{
						name: 'TicketNotReady',
					},
					{
						name: 'WrongBeneficiary',
					},
					{
						name: 'StakeAccountNotUpdatedYet',
					},
					{
						name: 'StakeNotDelegated',
					},
					{
						name: 'StakeAccountIsEmergencyUnstaking',
					},
					{
						name: 'InsufficientLiquidity',
					},
					{
						name: 'InvalidValidator',
					},
				],
			},
		},
	],
};
