/**
 * Example script demonstrating how to use the Athena integration
 *
 * Usage:
 *   ts-node src/athena/example.ts
 *
 * Make sure to set the following environment variables:
 *   - AWS_REGION (optional, defaults to us-east-1)
 *   - AWS_ACCESS_KEY_ID
 *   - AWS_SECRET_ACCESS_KEY
 *   - ATHENA_DATABASE (optional, defaults to staging-archive)
 *   - ATHENA_OUTPUT_BUCKET (optional, defaults to staging-data-ingestion-bucket)
 */

import { FillQualityAnalyticsRepository } from './repositories/fillQualityAnalytics';
import { Athena } from './client';

require('dotenv').config();

async function exampleBasicQuery() {
	console.log('\n=== Example 1: Basic Query ===\n');

	const { query } = Athena();

	// Simple query to get recent trades
	const results = await query(`
		SELECT 
			ts,
			markettype,
			marketindex,
			action,
			taker,
			maker
		FROM eventtype_traderecord
		WHERE year = '2024' 
		  AND month = '10'
		  AND day = '19'
		  AND markettype = 'perp'
		  AND marketindex = 0
		LIMIT 10
	`);

	console.log('Results:', JSON.stringify(results, null, 2));
	console.log(`Found ${results.length} trades`);
}

async function exampleFillQualityAnalytics() {
	console.log('\n=== Example 2: Fill Quality Analytics ===\n');

	const repository = FillQualityAnalyticsRepository();

	// Get taker fill vs oracle bps for ALL perp markets
	// Last 24 hours
	const filterMarket = '15';
	const smoothingMinutes = 60;
	const nowMs = Date.now();
	const yesterdayMs = nowMs - 24 * (smoothingMinutes * 60 * 1000);

	console.log(
		`Querying from ${new Date(yesterdayMs).toISOString()} to ${new Date(
			nowMs
		).toISOString()}`
	);

	const results = await repository.getTakerFillVsOracleBps(
		yesterdayMs, // from (milliseconds)
		nowMs, // to (milliseconds)
		9, // baseDecimals
		smoothingMinutes // smoothingMinutes
	);

	console.log(`Retrieved ${results.length} data points across all markets`);

	// Group by market to show summary
	const marketGroups = results.reduce((acc, result) => {
		const market = result.MarketIndex;
		if (!acc[market]) acc[market] = [];
		acc[market].push(result);
		return acc;
	}, {} as Record<string, typeof results>);

	console.log(`\nFound data for ${Object.keys(marketGroups).length} markets`);

	// Show last few results for the first market (last results have full rolling window data)
	if (results.length > 0) {
		// const firstMarket = Object.keys(marketGroups)[0];
		// const firstMarketData = marketGroups[firstMarket];
		// console.log(`\nLast 3 results for Market ${firstMarket} (total: ${firstMarketData.length} rows):`);
		// firstMarketData.slice(-3).forEach((result, i) => {
		// 	console.log(`\n[${firstMarketData.length - 2 + i}] Time: ${result.Time}, Market: ${result.MarketIndex}`);
		// 	console.log(`  Buy BPS ($0-1k): ${result.TakerBuyBpsFromOracle_1e0}`);
		// 	console.log(`  Buy BPS (>$1M): ${result.TakerBuyBpsFromOracle_1e6}`);
		// 	console.log(`  Sell BPS ($0-1k): ${result.TakerSellBpsFromOracle_1e0}`);
		// 	console.log(`  Sell BPS (>$1M): ${result.TakerSellBpsFromOracle_1e6}`);
		// });

		// Find and show some non-null results
		console.log('\n--- Looking for non-null results ---');
		const nonNullResults = results.filter(
			(r) =>
				(r.TakerBuyBpsFromOracle_1e0 !== null ||
					r.TakerSellBpsFromOracle_1e0 !== null ||
					r.TakerBuyBpsFromOracle_1e3 !== null ||
					r.TakerSellBpsFromOracle_1e3 !== null ||
					r.TakerBuyBpsFromOracle_1e4 !== null ||
					r.TakerSellBpsFromOracle_1e4 !== null ||
					r.TakerBuyBpsFromOracle_1e5 !== null ||
					r.TakerSellBpsFromOracle_1e5 !== null ||
					r.TakerBuyBpsFromOracle_1e6 !== null ||
					r.TakerSellBpsFromOracle_1e6 !== null ||
					r.TakerBuyBpsFromOracle_ALL !== null ||
					r.TakerSellBpsFromOracle_ALL !== null) &&
				r.MarketIndex === filterMarket
		);
		console.log(
			`Found ${nonNullResults.length} rows with non-null BPS values (${(
				(nonNullResults.length / results.length) *
				100
			).toFixed(1)}% of total)`
		);
		// console.log(results.filter(r => r.MarketIndex === filterMarket));

		const uniqueMarketIndexes = [
			...new Set(results.map((r) => Number(r.MarketIndex))),
		].sort((a, b) => a - b);
		console.log(
			`Unique market indexes (total: ${
				uniqueMarketIndexes.length
			}): ${uniqueMarketIndexes.join(', ')}`
		);

		if (nonNullResults.length > 0) {
			console.log('\nLatest non-null result for Market 0:');
			const sample = nonNullResults[nonNullResults.length - 1];
			console.log(`Time: ${sample.Time}, Market: ${sample.MarketIndex}`);
			console.log(
				`  Buy BPS ($0-1k):      ${sample.TakerBuyBpsFromOracle_1e0}`
			);
			console.log(
				`  Buy BPS ($1k-10k):    ${sample.TakerBuyBpsFromOracle_1e3}`
			);
			console.log(
				`  Buy BPS ($10k-100k):  ${sample.TakerBuyBpsFromOracle_1e4}`
			);
			console.log(
				`  Buy BPS ($100k-1M):   ${sample.TakerBuyBpsFromOracle_1e5}`
			);
			console.log(
				`  Buy BPS (>$1M):       ${sample.TakerBuyBpsFromOracle_1e6}`
			);
			console.log(
				`  Buy BPS (ALL):        ${sample.TakerBuyBpsFromOracle_ALL}`
			);
			console.log(
				`  Sell BPS ($0-1k):     ${sample.TakerSellBpsFromOracle_1e0}`
			);
			console.log(
				`  Sell BPS ($1k-10k):   ${sample.TakerSellBpsFromOracle_1e3}`
			);
			console.log(
				`  Sell BPS ($10k-100k): ${sample.TakerSellBpsFromOracle_1e4}`
			);
			console.log(
				`  Sell BPS ($100k-1M):  ${sample.TakerSellBpsFromOracle_1e5}`
			);
			console.log(
				`  Sell BPS (>$1M):      ${sample.TakerSellBpsFromOracle_1e6}`
			);
			console.log(
				`  Sell BPS (ALL):       ${sample.TakerSellBpsFromOracle_ALL}`
			);
		} else {
			console.log(
				'\n⚠️  WARNING: No non-null BPS values found in any results!'
			);
			console.log('   This might indicate:');
			console.log('   - No trade data in the time range');
			console.log('   - Orders/trades not joining properly');
			console.log('   - Issue with the query logic');
		}
	}
	console.log(
		`Took ${Date.now() - nowMs}ms to run exampleFillQualityAnalytics`
	);
}

async function exampleBatchQuery() {
	console.log('\n=== Example 3: Batch Query ===\n');

	const { batchQuery } = Athena();

	// Run multiple queries in parallel
	const { results, errors } = await batchQuery({
		queries: [
			{
				query: `
					SELECT COUNT(*) as trade_count
					FROM eventtype_traderecord
					WHERE year = '2024' AND month = '10' AND day = '19'
					  AND markettype = 'perp' AND marketindex = 0
				`,
			},
			{
				query: `
					SELECT COUNT(*) as order_count
					FROM eventtype_orderrecord
					WHERE year = '2024' AND month = '10' AND day = '19'
					  AND "order".markettype = 'perp' AND "order".marketindex = 0
				`,
			},
		],
	});

	console.log('Trade count:', results[0]?.[0]?.trade_count || 'N/A');
	console.log('Order count:', results[1]?.[0]?.order_count || 'N/A');

	if (errors.length > 0) {
		console.log('Errors:', errors);
	}
}

async function main() {
	console.log('Athena Integration Examples');
	console.log('===========================');

	try {
		// Run examples
		// await exampleBasicQuery();
		await exampleFillQualityAnalytics();
		// await exampleBatchQuery();

		console.log('\n✅ All examples completed successfully!');
	} catch (error) {
		console.error('\n❌ Error:', error);
		process.exit(1);
	}
}

// Run if executed directly
if (require.main === module) {
	main();
}
