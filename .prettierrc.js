module.exports = {
	semi: true,
	trailingComma: 'es5',
	singleQuote: true,
	printWidth: 80,
	tabWidth: 2,
	useTabs: true,
	bracketSameLine: false,
	endOfLine: 'auto',
	// The @backend/* libs and the infra-v3-origin apps were authored against
	// infrastructure-v3's prettier config (100-wide / 4-tab). Preserve that style
	// for those paths rather than reflowing the whole subtree to the 80/2 default,
	// which would destroy git blame for no behavioral gain. New packages outside
	// this list inherit the 80/2 default above.
	overrides: [
		{
			files: [
				'packages/{athena,common,dynamodb,kinesis,prometheus,redis,s3,sns,sqs}/**/*.ts',
				'apps/{aggregator-api,candles,market-data,multisig-monitor,notification-engine,realtime-archiver}/**/*.ts',
			],
			options: {
				printWidth: 100,
				tabWidth: 4,
			},
		},
	],
};
