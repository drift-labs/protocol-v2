export type JitProxy = {
	version: '0.9.0';
	name: 'jit_proxy';
	instructions: [
		{
			name: 'jit';
			accounts: [
				{
					name: 'state';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'user';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'userStats';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'taker';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'takerStats';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'authority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'driftProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: 'JitParams';
					};
				},
			];
		},
		{
			name: 'checkOrderConstraints';
			accounts: [
				{
					name: 'user';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'constraints';
					type: {
						vec: {
							defined: 'OrderConstraint';
						};
					};
				},
			];
		},
	];
	types: [
		{
			name: 'JitParams';
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
							defined: 'PriceType';
						};
					},
					{
						name: 'postOnly';
						type: {
							option: {
								defined: 'PostOnlyParam';
							};
						};
					},
				];
			};
		},
		{
			name: 'OrderConstraint';
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
							defined: 'MarketType';
						};
					},
				];
			};
		},
		{
			name: 'PostOnlyParam';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'None';
					},
					{
						name: 'MustPostOnly';
					},
					{
						name: 'TryPostOnly';
					},
				];
			};
		},
		{
			name: 'PriceType';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Limit';
					},
					{
						name: 'Oracle';
					},
				];
			};
		},
		{
			name: 'MarketType';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Perp';
					},
					{
						name: 'Spot';
					},
				];
			};
		},
	];
	errors: [
		{
			code: 6000;
			name: 'BidNotCrossed';
			msg: 'BidNotCrossed';
		},
		{
			code: 6001;
			name: 'AskNotCrossed';
			msg: 'AskNotCrossed';
		},
		{
			code: 6002;
			name: 'TakerOrderNotFound';
			msg: 'TakerOrderNotFound';
		},
		{
			code: 6003;
			name: 'OrderSizeBreached';
			msg: 'OrderSizeBreached';
		},
	];
};

export const IDL: JitProxy = {
	version: '0.9.0',
	name: 'jit_proxy',
	instructions: [
		{
			name: 'jit',
			accounts: [
				{
					name: 'state',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'user',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'userStats',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'taker',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'takerStats',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'authority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'driftProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'params',
					type: {
						defined: 'JitParams',
					},
				},
			],
		},
		{
			name: 'checkOrderConstraints',
			accounts: [
				{
					name: 'user',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'constraints',
					type: {
						vec: {
							defined: 'OrderConstraint',
						},
					},
				},
			],
		},
	],
	types: [
		{
			name: 'JitParams',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'takerOrderId',
						type: 'u32',
					},
					{
						name: 'maxPosition',
						type: 'i64',
					},
					{
						name: 'minPosition',
						type: 'i64',
					},
					{
						name: 'bid',
						type: 'i64',
					},
					{
						name: 'ask',
						type: 'i64',
					},
					{
						name: 'priceType',
						type: {
							defined: 'PriceType',
						},
					},
					{
						name: 'postOnly',
						type: {
							option: {
								defined: 'PostOnlyParam',
							},
						},
					},
				],
			},
		},
		{
			name: 'OrderConstraint',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'maxPosition',
						type: 'i64',
					},
					{
						name: 'minPosition',
						type: 'i64',
					},
					{
						name: 'marketIndex',
						type: 'u16',
					},
					{
						name: 'marketType',
						type: {
							defined: 'MarketType',
						},
					},
				],
			},
		},
		{
			name: 'PostOnlyParam',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'None',
					},
					{
						name: 'MustPostOnly',
					},
					{
						name: 'TryPostOnly',
					},
				],
			},
		},
		{
			name: 'PriceType',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Limit',
					},
					{
						name: 'Oracle',
					},
				],
			},
		},
		{
			name: 'MarketType',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Perp',
					},
					{
						name: 'Spot',
					},
				],
			},
		},
	],
	errors: [
		{
			code: 6000,
			name: 'BidNotCrossed',
			msg: 'BidNotCrossed',
		},
		{
			code: 6001,
			name: 'AskNotCrossed',
			msg: 'AskNotCrossed',
		},
		{
			code: 6002,
			name: 'TakerOrderNotFound',
			msg: 'TakerOrderNotFound',
		},
		{
			code: 6003,
			name: 'OrderSizeBreached',
			msg: 'OrderSizeBreached',
		},
	],
};
