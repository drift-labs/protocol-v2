import { Athena, getTimePartition } from '@backend/athena';
import { isFeatureEnabled, logger } from '@backend/common';
import { ClaimRepository } from '@backend/dynamodb';
import Bottleneck from 'bottleneck';
import { Scheduler } from '../services/scheduler';

const { query } = Athena();

const limiter = new Bottleneck({
	maxConcurrent: 5,
});

const isClaimsDryRunEnabled = () => process.env.CLAIMS_DRY_RUN?.toLowerCase() !== 'false';
const getClaimTaskEnv = () => process.env.ENV ?? 'devnet';

export interface AccrualClaimCampaignConfig {
	campaignId: string;
	query: string;
	campaignStartTs: number;
	campaignEndTs: number;
	authorityField: string;
	feesField: string;
	amount: number;
	progressCap: number;
	assetSymbol: string;
	schedule: string;
}

export const buildOpeningPositionFeesQuery = ({
	campaignStartTs,
	campaignEndTs,
	env = getClaimTaskEnv(),
}: Pick<AccrualClaimCampaignConfig, 'campaignStartTs' | 'campaignEndTs'> & {
	env?: string;
}) => {
	return `
	${getTimePartition(campaignStartTs, campaignEndTs)},
	claim_source_events AS (
		SELECT DISTINCT
			TRIM(NULLIF(json_extract_scalar(data, '$.event.properties.authority'), '')) AS authorityId,
			TRY_CAST(NULLIF(json_extract_scalar(data, '$.event.properties.next_order_id'), '') AS BIGINT) - 1 AS orderId
		FROM "staging-archive".eventtype_posthogevent
		CROSS JOIN time_range
		WHERE eventname = 'trade_placed'
			AND CAST(ts AS BIGINT) BETWEEN time_range.from_ts AND time_range.to_ts
			AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
			AND
				NULLIF(json_extract_scalar(data, '$.event.properties.platform'), '')
			 = 'web'
			AND
				NULLIF(json_extract_scalar(data, '$.event.properties.env'), '')
			= '${env.replace(/'/g, "''")}'
	),
	taker_fills AS (
		SELECT
			events.authorityId AS authorityId,
			GREATEST(COALESCE(trades.takerfee, 0), 0) AS feesPaid
		FROM claim_source_events events
		JOIN analytics_clean_trades_with_authority trades
			ON trades.taker_authority = events.authorityId
			AND trades.takerorderid = events.orderId
		CROSS JOIN time_range
		WHERE events.authorityId IS NOT NULL
			AND events.orderId IS NOT NULL
			AND CAST(trades.ts AS BIGINT) BETWEEN time_range.from_ts AND time_range.to_ts
			AND trades.dt BETWEEN DATE_FORMAT(from_unixtime(time_range.from_ts), '%Y-%m-%d')
				AND DATE_FORMAT(from_unixtime(time_range.to_ts), '%Y-%m-%d')
	)
	SELECT
		authorityId,
		CAST(SUM(feesPaid) AS DOUBLE) AS feesPaid
	FROM taker_fills
	GROUP BY authorityId
`;
};

export const ACCRUAL_CLAIM_CAMPAIGNS: AccrualClaimCampaignConfig[] = [
	{
		campaignId: 'fe51bb98-b4ef-4129-a100-d9d2a8f029ad',
		campaignStartTs: 1774483200,
		campaignEndTs: 1806019200,
		authorityField: 'authorityId',
		feesField: 'feesPaid',
		amount: 10,
		progressCap: 10,
		assetSymbol: 'USDC',
		schedule: '*/15 * * * *',
		query: buildOpeningPositionFeesQuery({
			campaignStartTs: 1774483200,
			campaignEndTs: 1806019200,
			env: getClaimTaskEnv(),
		}),
	},
];

const getAuthorityId = (row: Record<string, any>, authorityField: string) => {
	const rawValue = row[authorityField];
	if (typeof rawValue !== 'string') {
		return null;
	}

	const authorityId = rawValue.trim();
	return authorityId.length > 0 ? authorityId : null;
};

const getFeesPaid = (row: Record<string, any>, feesField: string) => {
	const value = Number(row[feesField]);
	return Number.isFinite(value) && value >= 0 ? value : null;
};

export const aggregateClaimRows = ({
	rows,
	authorityField,
	feesField,
	campaignId,
}: {
	rows: Record<string, any>[];
	authorityField: string;
	feesField: string;
	campaignId: string;
}) => {
	const aggregatedRows = new Map<string, number>();

	for (const row of rows) {
		const authorityId = getAuthorityId(row, authorityField);
		if (!authorityId) {
			logger.warn(
				`[CLAIM_SYNC:${campaignId}] Skipping row without authority field "${authorityField}"`
			);
			continue;
		}

		const feesPaid = getFeesPaid(row, feesField);
		if (feesPaid === null) {
			logger.warn(
				`[CLAIM_SYNC:${campaignId}] Skipping row for authority ${authorityId} with invalid fees field "${feesField}"`
			);
			continue;
		}

		aggregatedRows.set(authorityId, (aggregatedRows.get(authorityId) ?? 0) + feesPaid);
	}

	return aggregatedRows;
};

export const syncAccrualClaimCampaign = async (campaign: AccrualClaimCampaignConfig) => {
	const rows = await query(campaign.query);
	const aggregatedRows = aggregateClaimRows({
		rows,
		authorityField: campaign.authorityField,
		feesField: campaign.feesField,
		campaignId: campaign.campaignId,
	});

	if (isClaimsDryRunEnabled()) {
		const dryRunRecords = Array.from(aggregatedRows.entries()).map(
			([authorityId, progressAmount]) => ({
				authorityId,
				progressAmount,
			})
		);

		logger.info(
			`[CLAIM_SYNC:${campaign.campaignId}] Dry run enabled; would upsert ${aggregatedRows.size} claim records`
		);
		logger.info(
			`[CLAIM_SYNC:${campaign.campaignId}] Dry run claim records: ${JSON.stringify(
				dryRunRecords
			)}`
		);
		return;
	}

	const { upsertAccrualClaimProgress } = ClaimRepository();

	const results = await Promise.allSettled(
		Array.from(aggregatedRows.entries()).map(([authorityId, progressAmount]) =>
			limiter.schedule(() =>
				upsertAccrualClaimProgress({
					authorityId,
					campaignId: campaign.campaignId,
					amount: campaign.amount,
					assetSymbol: campaign.assetSymbol,
					campaignStartTs: campaign.campaignStartTs,
					campaignEndTs: campaign.campaignEndTs,
					progressAmount,
					progressCap: campaign.progressCap,
				})
			)
		)
	);

	const successCount = results.filter((result) => result.status === 'fulfilled').length;
	const failedResults = results.filter((result) => result.status === 'rejected');

	if (failedResults.length > 0) {
		for (const failedResult of failedResults) {
			logger.error(
				`[CLAIM_SYNC:${campaign.campaignId}] Failed claim upsert: ${
					(failedResult.reason as Error)?.message ?? String(failedResult.reason)
				}`
			);
		}

		throw new Error(
			`[CLAIM_SYNC:${campaign.campaignId}] Failed ${failedResults.length} of ${results.length} claim upserts`
		);
	}

	logger.info(`[CLAIM_SYNC:${campaign.campaignId}] Synced ${successCount} claim records`);
};

export const setupClaimTasks = ({ scheduler }: { scheduler: ReturnType<typeof Scheduler> }) => {
	if (!isFeatureEnabled('FEE_ACCRUAL_CLAIM', false)) {
		logger.info(`[CLAIM_SYNC] Claim tasks disabled because flag is not set`);
		return;
	}

	for (const campaign of ACCRUAL_CLAIM_CAMPAIGNS) {
		scheduler.scheduleTask(
			`claim-accrual-sync-${campaign.campaignId}`,
			campaign.schedule,
			async () => {
				await syncAccrualClaimCampaign(campaign);
			},
			{
				runImmediately: true,
			}
		);
	}
};
