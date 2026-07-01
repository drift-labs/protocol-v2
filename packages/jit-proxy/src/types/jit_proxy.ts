/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/jit_proxy.json`.
 */
export type JitProxy = {
	address: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP';
	metadata: {
		name: 'jitProxy';
		version: '0.21.0';
		spec: '0.1.0';
	};
	instructions: [
		{
			name: 'jit';
			discriminator: [99, 42, 97, 140, 152, 62, 167, 234];
			accounts: [
				{
					name: 'state';
				},
				{
					name: 'user';
					writable: true;
				},
				{
					name: 'userStats';
					writable: true;
				},
				{
					name: 'taker';
					writable: true;
				},
				{
					name: 'takerStats';
					writable: true;
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'driftProgram';
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'jitParams';
						};
					};
				},
			];
		},
		{
			name: 'jitSignedMsg';
			discriminator: [134, 130, 156, 72, 37, 120, 153, 21];
			accounts: [
				{
					name: 'state';
				},
				{
					name: 'user';
					writable: true;
				},
				{
					name: 'userStats';
					writable: true;
				},
				{
					name: 'taker';
					writable: true;
				},
				{
					name: 'takerStats';
					writable: true;
				},
				{
					name: 'takerSignedMsgUserOrders';
					writable: true;
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'driftProgram';
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: {
							name: 'jitSignedMsgParams';
						};
					};
				},
			];
		},
		{
			name: 'checkOrderConstraints';
			discriminator: [183, 174, 142, 245, 5, 29, 207, 2];
			accounts: [
				{
					name: 'user';
				},
			];
			args: [
				{
					name: 'constraints';
					type: {
						vec: {
							defined: {
								name: 'orderConstraint';
							};
						};
					};
				},
			];
		},
		{
			name: 'arbPerp';
			discriminator: [116, 105, 138, 99, 28, 171, 39, 225];
			accounts: [
				{
					name: 'state';
				},
				{
					name: 'user';
					writable: true;
				},
				{
					name: 'userStats';
					writable: true;
				},
				{
					name: 'authority';
					signer: true;
				},
				{
					name: 'driftProgram';
				},
			];
			args: [
				{
					name: 'marketIndex';
					type: 'u16';
				},
			];
		},
	];
	errors: [
		{
			code: 6000;
			name: 'bidNotCrossed';
			msg: 'bidNotCrossed';
		},
		{
			code: 6001;
			name: 'askNotCrossed';
			msg: 'askNotCrossed';
		},
		{
			code: 6002;
			name: 'takerOrderNotFound';
			msg: 'takerOrderNotFound';
		},
		{
			code: 6003;
			name: 'orderSizeBreached';
			msg: 'orderSizeBreached';
		},
		{
			code: 6004;
			name: 'noBestBid';
			msg: 'noBestBid';
		},
		{
			code: 6005;
			name: 'noBestAsk';
			msg: 'noBestAsk';
		},
		{
			code: 6006;
			name: 'noArbOpportunity';
			msg: 'noArbOpportunity';
		},
		{
			code: 6007;
			name: 'unprofitableArb';
			msg: 'unprofitableArb';
		},
		{
			code: 6008;
			name: 'positionLimitBreached';
			msg: 'positionLimitBreached';
		},
		{
			code: 6009;
			name: 'noFill';
			msg: 'noFill';
		},
		{
			code: 6010;
			name: 'signedMsgOrderDoesNotExist';
			msg: 'signedMsgOrderDoesNotExist';
		},
	];
	types: [
		{
			name: 'orderConstraint';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'maxPosition';
						type: 'i64';
					},
					{
						name: 'minPosition';
						type: 'i64';
					},
					{
						name: 'marketIndex';
						type: 'u16';
					},
					{
						name: 'marketType';
						type: {
							defined: {
								name: 'marketType';
							};
						};
					},
				];
			};
		},
		{
			name: 'jitParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'takerOrderId';
						type: 'u32';
					},
					{
						name: 'maxPosition';
						type: 'i64';
					},
					{
						name: 'minPosition';
						type: 'i64';
					},
					{
						name: 'bid';
						type: 'i64';
					},
					{
						name: 'ask';
						type: 'i64';
					},
					{
						name: 'priceType';
						type: {
							defined: {
								name: 'priceType';
							};
						};
					},
					{
						name: 'postOnly';
						type: {
							option: {
								defined: {
									name: 'postOnlyParam';
								};
							};
						};
					},
				];
			};
		},
		{
			name: 'jitSignedMsgParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'signedMsgOrderUuid';
						type: {
							array: ['u8', 8];
						};
					},
					{
						name: 'maxPosition';
						type: 'i64';
					},
					{
						name: 'minPosition';
						type: 'i64';
					},
					{
						name: 'bid';
						type: 'i64';
					},
					{
						name: 'ask';
						type: 'i64';
					},
					{
						name: 'priceType';
						type: {
							defined: {
								name: 'priceType';
							};
						};
					},
					{
						name: 'postOnly';
						type: {
							option: {
								defined: {
									name: 'postOnlyParam';
								};
							};
						};
					},
				];
			};
		},
		{
			name: 'postOnlyParam';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'none';
					},
					{
						name: 'mustPostOnly';
					},
					{
						name: 'tryPostOnly';
					},
					{
						name: 'slide';
					},
				];
			};
		},
		{
			name: 'priceType';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'limit';
					},
					{
						name: 'oracle';
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
						name: 'perp';
					},
					{
						name: 'spot';
					},
				];
			};
		},
	];
};
