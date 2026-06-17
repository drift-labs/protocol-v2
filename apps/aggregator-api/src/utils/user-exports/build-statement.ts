import { EntityTypes, RecordTypes } from '@backend/common';
import {
	DepositRepository,
	FundingPaymentRepository,
	FundingRateRepository,
	InsuranceFundStakeRepository,
	LiquidationRepository,
	LPRepository,
	RewardRepository,
	SettlePnlRepository,
	SwapRepository,
	TradeRepository,
} from '@backend/dynamodb';
import { Parser } from 'json2csv';
import { promisify } from 'util';
import { gzip } from 'zlib';
import { fetchArchiveData } from '../fetch-archive-data';
import { ExportFileType, ExportMode } from './types';

const gzipAsync = promisify(gzip);

const MAX_CONCURRENT_FETCHES = 1;

type Granularity = 'monthly' | 'daily';

type BetweenFetcher = (args: {
	id: string;
	startTs: number;
	endTs: number;
	entity?: EntityTypes;
	page?: Record<string, any>;
}) => Promise<{ records: any[]; meta: { nextPage: Record<string, any> | null } }>;

type Binding = {
	recordType: RecordTypes;
	entity: EntityTypes;
	granularity: Granularity;
	idsFrom: 'userPublicKeys' | 'market' | 'authority';
	getLatestRecords: BetweenFetcher;
};

const bindings = (): Record<ExportFileType, Binding> => ({
	[ExportFileType.Trades]: {
		recordType: RecordTypes.TradeRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: TradeRepository().getTradeRecordsBetweenTimestamps,
	},
	[ExportFileType.MarketTrades]: {
		recordType: RecordTypes.TradeRecord,
		entity: EntityTypes.Market,
		granularity: 'daily',
		idsFrom: 'market',
		getLatestRecords: TradeRepository().getTradeRecordsBetweenTimestamps,
	},
	[ExportFileType.FundingRates]: {
		recordType: RecordTypes.FundingRateRecord,
		entity: EntityTypes.Market,
		granularity: 'daily',
		idsFrom: 'market',
		getLatestRecords: FundingRateRepository().getFundingRateRecordsBetweenTimestamps,
	},
	[ExportFileType.FundingPayments]: {
		recordType: RecordTypes.FundingPaymentRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: FundingPaymentRepository().getFundingPaymentRecordsBetweenTimestamps,
	},
	[ExportFileType.Deposits]: {
		recordType: RecordTypes.DepositRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: DepositRepository().getDepositRecordsBetweenTimestamps,
	},
	[ExportFileType.Liquidations]: {
		recordType: RecordTypes.LiquidationRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: LiquidationRepository().getLiquidationRecordsBetweenTimestamps,
	},
	[ExportFileType.SettlePnlRecords]: {
		recordType: RecordTypes.SettlePnlRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: SettlePnlRepository().getSettlePnlRecordsBetweenTimestamps,
	},
	[ExportFileType.LpRecords]: {
		recordType: RecordTypes.LPRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: LPRepository().getLPRecordsBetweenTimestamps,
	},
	[ExportFileType.IfStakeRecords]: {
		recordType: RecordTypes.InsuranceFundStakeRecord,
		entity: EntityTypes.Authority,
		granularity: 'monthly',
		idsFrom: 'authority',
		getLatestRecords:
			InsuranceFundStakeRepository().getInsuranceFundStakeRecordsBetweenTimestamps,
	},
	[ExportFileType.SwapRecords]: {
		recordType: RecordTypes.SwapRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: SwapRepository().getSwapRecordsBetweenTimestamps,
	},
	[ExportFileType.Rewards]: {
		recordType: RecordTypes.RewardRecord,
		entity: EntityTypes.User,
		granularity: 'monthly',
		idsFrom: 'userPublicKeys',
		getLatestRecords: RewardRepository().getRewardRecordsBetweenTimestamps,
	},
});

type FetchSlot = { id: string; year: number; month: number; day?: number };

const enumerateSlots = (
	ids: string[],
	from: number,
	to: number,
	granularity: Granularity
): FetchSlot[] => {
	const startDate = new Date(from * 1000);
	const endDate = new Date(to * 1000);
	const slots: FetchSlot[] = [];

	if (granularity === 'monthly') {
		const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
		const endAnchor = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
		while (cursor.getTime() <= endAnchor.getTime()) {
			const year = cursor.getUTCFullYear();
			const month = cursor.getUTCMonth() + 1;
			for (const id of ids) {
				slots.push({ id, year, month });
			}
			cursor.setUTCMonth(cursor.getUTCMonth() + 1);
		}
	} else {
		const cursor = new Date(
			Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
		);
		const endAnchor = new Date(
			Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
		);
		while (cursor.getTime() <= endAnchor.getTime()) {
			const year = cursor.getUTCFullYear();
			const month = cursor.getUTCMonth() + 1;
			const day = cursor.getUTCDate();
			for (const id of ids) {
				slots.push({ id, year, month, day });
			}
			cursor.setUTCDate(cursor.getUTCDate() + 1);
		}
	}

	return slots;
};

type ArchivePageResult = {
	success: boolean;
	records: Record<string, any>[];
	meta: { nextPage: number | null | Record<string, any>; [k: string]: any };
};

// Drift is frozen: the velocity DDB tables don't carry drift records, so we
// must skip the current-period DB-tail merge in fetchArchiveData.
const NO_LATEST: BetweenFetcher = async () => ({
	records: [],
	meta: { nextPage: null },
});

const sourceBucketForMode = (mode: ExportMode): string => {
	// Worker context: prefixed envs; API context: unprefixed S3_BUCKET (the
	// API Lambda only ever runs in one mode and already has S3_BUCKET set).
	const env = process.env[`${mode.toUpperCase()}_S3_BUCKET`] ?? process.env.S3_BUCKET;
	if (!env) {
		throw new Error(`Source archive bucket env not set for mode=${mode}`);
	}
	return env;
};

const fetchAllPages = async (
	mode: ExportMode,
	binding: Binding,
	slot: FetchSlot
): Promise<Record<string, any>[]> => {
	const out: Record<string, any>[] = [];
	let page: number | null = 1;
	const bucket = sourceBucketForMode(mode);
	const getLatestRecords = mode === 'drift' ? NO_LATEST : binding.getLatestRecords;
	while (page !== null) {
		const result = (await fetchArchiveData<Record<string, any>>({
			id: slot.id,
			year: slot.year,
			month: slot.month,
			day: slot.day,
			page,
			recordType: binding.recordType,
			entity: binding.entity,
			bucket,
			getLatestRecords,
		})) as ArchivePageResult;
		if (result.records.length) {
			out.push(...result.records);
		}
		const next = result.meta.nextPage;
		if (next == null) {
			page = null;
		} else {
			const parsed = Number(next);
			page = Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
		}
	}
	return out;
};

const runWithConcurrency = async <T, U>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<U>
): Promise<U[]> => {
	const results: U[] = new Array(items.length);
	let cursor = 0;
	const next = async (): Promise<void> => {
		for (;;) {
			const idx = cursor++;
			if (idx >= items.length) return;
			results[idx] = await worker(items[idx]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
	return results;
};

const INTERNAL_KEYS = new Set(['pk', 'sk', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK']);

const stripKeys = (records: Record<string, any>[]) =>
	records.map((r) => {
		const out: Record<string, any> = {};
		for (const k of Object.keys(r)) {
			if (!INTERNAL_KEYS.has(k)) {
				out[k] = r[k];
			}
		}
		return out;
	});

export const buildStatement = async (args: {
	mode: ExportMode;
	fileType: ExportFileType;
	authority: string;
	userPublicKeys: string[];
	from: number;
	to: number;
	market?: string;
}): Promise<{ gzipped: Buffer; recordCount: number; isEmpty: boolean }> => {
	const binding = bindings()[args.fileType];
	if (!binding) {
		throw new Error(`Unsupported fileType: ${args.fileType}`);
	}

	let ids: string[];
	switch (binding.idsFrom) {
		case 'userPublicKeys':
			ids = args.userPublicKeys;
			break;
		case 'market':
			if (!args.market) {
				throw new Error(`fileType ${args.fileType} requires \`market\` parameter`);
			}
			ids = [args.market];
			break;
		case 'authority':
			ids = [args.authority];
			break;
	}

	const slots = enumerateSlots(ids, args.from, args.to, binding.granularity);

	const perSlot = await runWithConcurrency(slots, MAX_CONCURRENT_FETCHES, (slot) =>
		fetchAllPages(args.mode, binding, slot)
	);

	let records = perSlot.flat();

	// Clip to the exact [from, to] range — page files are bucketed by
	// day/month so the edges include records outside the requested window.
	records = records.filter((r) => {
		const ts = r.ts;
		return typeof ts === 'number' && ts >= args.from && ts <= args.to;
	});

	// Optional client-side market filter for user-entity exports.
	if (binding.idsFrom === 'userPublicKeys' && args.market) {
		records = records.filter((r) => r.marketSymbol === args.market || r.symbol === args.market);
	}

	records.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

	const recordCount = records.length;
	if (recordCount === 0) {
		return { gzipped: Buffer.alloc(0), recordCount: 0, isEmpty: true };
	}

	const stripped = stripKeys(records);
	const fields = Object.keys(stripped[0]);
	const csv = new Parser({ fields }).parse(stripped);
	const gzipped = await gzipAsync(Buffer.from(csv, 'utf8'));

	return { gzipped, recordCount, isEmpty: false };
};
