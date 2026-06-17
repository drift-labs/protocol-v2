import { isFeatureEnabled } from '@backend/common';
import type { OpenAPIV3 } from 'openapi-types';

export const swaggerConfig: Partial<OpenAPIV3.Document<any>> = {
	openapi: '3.0.0',
	info: {
		title: 'Velocity Data API',
		version: '1.0.0',
	},
	tags: [
		{ name: 'Notifications', description: 'Endpoints to handle user notifications' },
		{ name: 'User', description: 'Endpoints to fetch user records' },
		{ name: 'Authority', description: 'Endpoints to fetch authority records' },
		{ name: 'Market', description: 'Endpoints to fetch market data' },
		{ name: 'Stats', description: 'Endpoints to fetch statistics' },
		{
			name: 'AMM',
			description:
				'Endpoints to fetch historical AMM data. For all AMM endpoints, the step size between data points is calculated automatically based on the requested number of `samples` (default = 11_000 max), with a minimum step size being 20 seconds. Thus the maximum queryable duration to still get a 20 second step size is about 220,000 seconds (approximately 2.54 days).',
		},
		{ name: 'WebSocket', description: 'Real-time WebSocket connections' },
		...(isFeatureEnabled('ONCHAIN_ENDPOINTS')
			? [
					{
						name: 'Transactions',
						description:
							'Endpoints for building transactions to interact with the protocol',
					},
			  ]
			: []),
	],
	externalDocs: {
		url: 'https://drift-labs.github.io/v2-teacher',
		description: 'Find more information here',
	},
	paths: {
		'/ws': {
			get: {
				tags: ['WebSocket'],
				description: `<p>Establish a WebSocket connection to receive real-time market data updates from Velocity protocol.</p>
						<div>
							<h2>Candle Subscription</h2>
							<code>
								{
									"type": "subscribe",
									"channelType": "candle",
									"symbol": "SOL-PERP",
									"resolution": "1"
								}
							</code>
							<h2>Market Subscription</h2>
							<code>
								{
									"type": "subscribe",
									"channelType": "markets"
								}
							</code>
							<h2>Pricing Subscription</h2>
							<code>
								{
									"type": "subscribe",
									"channelType": "pricing"
								}
							</code>
							<h2>Orderbook Subscription</h2>
							<code>
								{
									"type": "subscribe",
									"channelType": "orderbook",
									"symbol":"&lt;symbol&gt;"
								}
							</code>
							<h2>User Subscription</h2>
							<code>
								{
									"type": "subscribe",
									"channelType": "user",
									"accountId": "&lt;accountId&gt;"		
								}
							</code>
							<h2>Notifications Subscription</h2>
							<code>
								{
									"type": "subscribe",
									"channelType": "notifications",
									"authority": "&lt;authorityId&gt;"		
								}
							</code>
						</div>`,
				responses: {
					'101': {
						description: 'Websocket subscription',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										type: {
											type: 'string',
											enum: ['init', 'create', 'update'],
										},
										channel: {
											type: 'string',
										},
										channelType: {
											type: 'string',
										},
										data: {
											oneOf: [
												{
													type: 'object',
												},
												{
													type: 'array',
													items: {
														type: 'object',
													},
												},
											],
										},
										symbol: {
											type: 'string',
										},
										resolution: {
											type: 'string',
										},
										candle: {
											type: 'object',
										},
										trades: {
											type: 'array',
											items: {
												type: 'object',
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/amm/position': {
			get: {
				tags: ['AMM'],
				description: "Fetch the AMM's position (inventory) over a specified time period.",
				parameters: [
					{
						name: 'marketName',
						in: 'query',
						required: true,
						schema: {
							type: 'string',
							example: 'SOL-PERP',
						},
						description:
							'The name of the market to get position data for (e.g., SOL-PERP)',
					},
					{
						name: 'start',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description: 'Start timestamp in seconds (must be less than end timestamp)',
					},
					{
						name: 'end',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description:
							'End timestamp in seconds (must be greater than start timestamp)',
					},
					{
						name: 'samples',
						in: 'query',
						required: false,
						schema: {
							type: 'integer',
							default: 11000,
							maximum: 11000,
						},
						description:
							'Number of data points to return. The API will automatically calculate the appropriate step size between points. Maximum value is 11,000.',
					},
				],
				responses: {
					'200': {
						description: 'AMM position data',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: true,
										},
										data: {
											type: 'array',
											items: {
												type: 'array',
												items: {
													oneOf: [
														{
															type: 'integer',
															description: 'Timestamp in seconds',
														},
														{
															type: 'string',
															description:
																"Position value, in the market's base units",
														},
													],
												},
											},
										},
									},
									example: {
										success: true,
										data: [
											[1744173151, '7512.174273741'],
											[1744777951, '-2396.800914929'],
										],
									},
								},
							},
						},
					},
					'400': {
						description: 'Bad request',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
										message: {
											type: 'string',
										},
									},
								},
							},
						},
					},
					'500': {
						description: 'Internal server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/amm/bidAskPrice': {
			get: {
				tags: ['AMM'],
				description: "Fetch the AMM's bid and ask prices over a specified time period.",
				parameters: [
					{
						name: 'marketName',
						in: 'query',
						required: true,
						schema: {
							type: 'string',
							example: 'SOL-PERP',
						},
						description:
							'The name of the market to get bid-ask price data for (e.g., SOL-PERP)',
					},
					{
						name: 'start',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description: 'Start timestamp in seconds (must be less than end timestamp)',
					},
					{
						name: 'end',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description:
							'End timestamp in seconds (must be greater than start timestamp)',
					},
					{
						name: 'samples',
						in: 'query',
						required: false,
						schema: {
							type: 'integer',
							default: 11000,
							maximum: 11000,
						},
						description:
							'Number of data points to return. The API will automatically calculate the appropriate step size between points. Maximum value is 11,000.',
					},
				],
				responses: {
					'200': {
						description: 'AMM bid-ask price data',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: true,
										},
										data: {
											type: 'array',
											items: {
												type: 'array',
												items: {
													oneOf: [
														{
															type: 'integer',
															description: 'Timestamp in seconds',
														},
														{
															type: 'string',
															description: 'Bid price',
														},
														{
															type: 'string',
															description: 'Ask price',
														},
													],
												},
											},
										},
									},
									example: {
										success: true,
										data: [
											[1744173151, '121.54', '122.87'],
											[1744777951, '123.45', '124.56'],
										],
									},
								},
							},
						},
					},
					'400': {
						description: 'Bad request',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
										message: {
											type: 'string',
										},
									},
								},
							},
						},
					},
					'500': {
						description: 'Internal server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/amm/oraclePrice': {
			get: {
				tags: ['AMM'],
				description:
					'Fetch the oracle price data for a market over a specified time period.',
				parameters: [
					{
						name: 'marketName',
						in: 'query',
						required: true,
						schema: {
							type: 'string',
							example: 'SOL-PERP',
						},
						description:
							'The name of the market to get oracle price data for (e.g., SOL-PERP)',
					},
					{
						name: 'start',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description: 'Start timestamp in seconds (must be less than end timestamp)',
					},
					{
						name: 'end',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description:
							'End timestamp in seconds (must be greater than start timestamp)',
					},
					{
						name: 'samples',
						in: 'query',
						required: false,
						schema: {
							type: 'integer',
							default: 11000,
							maximum: 11000,
						},
						description:
							'Number of data points to return. The API will automatically calculate the appropriate step size between points. Maximum value is 11,000.',
					},
				],
				responses: {
					'200': {
						description: 'Oracle price data',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: true,
										},
										data: {
											type: 'array',
											items: {
												type: 'array',
												items: {
													oneOf: [
														{
															type: 'integer',
															description: 'Timestamp in seconds',
														},
														{
															type: 'string',
															description: 'Oracle price',
														},
													],
												},
											},
										},
									},
									example: {
										success: true,
										data: [
											[1744173151, '122.15'],
											[1744777951, '123.98'],
										],
									},
								},
							},
						},
					},
					'400': {
						description: 'Bad request',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
										message: {
											type: 'string',
										},
									},
								},
							},
						},
					},
					'500': {
						description: 'Internal server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/amm/spreads': {
			get: {
				tags: ['AMM'],
				description:
					'Fetch the long and short spread data for an AMM over a specified time period.',
				parameters: [
					{
						name: 'marketName',
						in: 'query',
						required: true,
						schema: {
							type: 'string',
							example: 'SOL-PERP',
						},
						description:
							'The name of the market to get spread data for (e.g., SOL-PERP)',
					},
					{
						name: 'start',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description: 'Start timestamp in seconds (must be less than end timestamp)',
					},
					{
						name: 'end',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description:
							'End timestamp in seconds (must be greater than start timestamp)',
					},
					{
						name: 'samples',
						in: 'query',
						required: false,
						schema: {
							type: 'integer',
							default: 11000,
							maximum: 11000,
						},
						description:
							'Number of data points to return. The API will automatically calculate the appropriate step size between points. Maximum value is 11,000.',
					},
				],
				responses: {
					'200': {
						description: 'AMM spread data',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: true,
										},
										data: {
											type: 'array',
											items: {
												type: 'array',
												items: {
													oneOf: [
														{
															type: 'integer',
															description: 'Timestamp in seconds',
														},
														{
															type: 'string',
															description:
																'Long spread, in percentage',
														},
														{
															type: 'string',
															description:
																'Short spread, in percentage',
														},
													],
												},
											},
										},
									},
									example: {
										success: true,
										data: [
											[1744173151, '0.05', '0.06'],
											[1744777951, '0.04', '0.05'],
										],
									},
								},
							},
						},
					},
					'400': {
						description: 'Bad request',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
										message: {
											type: 'string',
										},
									},
								},
							},
						},
					},
					'500': {
						description: 'Internal server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/amm/openInterest': {
			get: {
				tags: ['AMM'],
				description:
					'Fetch the open interest data for a market over a specified time period.',
				parameters: [
					{
						name: 'marketName',
						in: 'query',
						required: true,
						schema: {
							type: 'string',
							example: 'SOL-PERP',
						},
						description:
							'The name of the market to get open interest data for (e.g., SOL-PERP)',
					},
					{
						name: 'start',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description: 'Start timestamp in seconds (must be less than end timestamp)',
					},
					{
						name: 'end',
						in: 'query',
						required: true,
						schema: {
							type: 'integer',
							format: 'int64',
						},
						description:
							'End timestamp in seconds (must be greater than start timestamp)',
					},
					{
						name: 'samples',
						in: 'query',
						required: false,
						schema: {
							type: 'integer',
							default: 11000,
							maximum: 11000,
						},
						description:
							'Number of data points to return. The API will automatically calculate the appropriate step size between points. Maximum value is 11,000.',
					},
				],
				responses: {
					'200': {
						description: 'Open interest data',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: true,
										},
										data: {
											type: 'array',
											items: {
												type: 'array',
												items: {
													oneOf: [
														{
															type: 'integer',
															description: 'Timestamp in seconds',
														},
														{
															type: 'string',
															description:
																"Open interest value, in the market's base units",
														},
													],
												},
											},
										},
									},
									example: {
										success: true,
										data: [
											[1744173151, '1250000.45'],
											[1744777951, '1345721.87'],
										],
									},
								},
							},
						},
					},
					'400': {
						description: 'Bad request',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
										message: {
											type: 'string',
										},
									},
								},
							},
						},
					},
					'500': {
						description: 'Internal server error',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										success: {
											type: 'boolean',
											example: false,
										},
									},
								},
							},
						},
					},
				},
			},
		},
	},
};
