import { NotificationFilter, parseCommaList, validateFilter } from './filter';
import { type LogLevel, parseLogLevel } from './log';
import type { DisplayConfig } from './slack';

export interface FumaroleConfig {
	readonly endpoint: string;
	readonly xToken: string;
	readonly subscriberName: string;
	readonly maxSlotDifference: number;
	readonly startFromTip: boolean;
	readonly fromSlot: bigint | undefined;
}

export interface StateConfig {
	readonly tableName: string;
	readonly signatureTtlSeconds: number;
}

export interface Config {
	readonly multisigAddresses: readonly string[];
	readonly signerAddresses: readonly string[];
	readonly slackWebhookUrl: string;
	readonly filter: NotificationFilter;
	readonly display: DisplayConfig;
	readonly logLevel: LogLevel;
	readonly routes: ReadonlyMap<string, string>;
	/** Optional Solana RPC URL. When set, enables layer-2 CPI decoding. */
	readonly rpcUrl: string | null;
	readonly fumarole: FumaroleConfig;
	readonly state: StateConfig;
	readonly healthPort: number;
}

function parseBool(value: string | undefined): boolean {
	return value?.toLowerCase() === 'true';
}

function parseRoutes(raw: string): Map<string, string> {
	const routes = new Map<string, string>();
	if (!raw) return routes;
	for (const entry of raw.split(',')) {
		const sep = entry.indexOf(':');
		if (sep === -1) continue;
		const addr = entry.slice(0, sep).trim();
		const url = entry.slice(sep + 1).trim();
		if (addr && url) routes.set(addr, url);
	}
	return routes;
}

export function resolveWebhookUrl(config: Config, multisig: string): string {
	return config.routes.get(multisig) ?? config.slackWebhookUrl;
}

export function loadConfig(): Config {
	const multisigAddresses = parseCommaList(process.env.MULTISIG_ADDRESSES ?? '');
	if (multisigAddresses.length === 0) {
		throw new Error('MULTISIG_ADDRESSES is required');
	}

	const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
	if (!slackWebhookUrl) {
		throw new Error('SLACK_WEBHOOK_URL is required');
	}

	const fumaroleEndpoint = process.env.FUMAROLE_ENDPOINT ?? 'https://ams.rpcpool.com';
	const fumaroleXToken = process.env.FUMAROLE_X_TOKEN;
	if (!fumaroleXToken) {
		throw new Error('FUMAROLE_X_TOKEN is required');
	}

	const stage = process.env.APP_STAGE ?? 'local';
	const subscriberName = process.env.FUMAROLE_SUBSCRIBER_NAME ?? `multisig-monitor-${stage}`;

	const filter: NotificationFilter = {
		instructionTypes: parseCommaList(process.env.INSTRUCTION_TYPES ?? ''),
		configTypes: parseCommaList(process.env.CONFIG_TYPES ?? ''),
	};
	validateFilter(filter);

	const display: DisplayConfig = {
		showPermissions: parseBool(process.env.SHOW_PERMISSIONS),
		showTimestamps: parseBool(process.env.SHOW_TIMESTAMPS),
		truncateAddresses: parseBool(process.env.TRUNCATE_ADDRESSES),
	};

	const fromSlot = process.env.FROM_SLOT ? BigInt(process.env.FROM_SLOT) : undefined;
	const maxSlotDifference = process.env.MAX_SLOT_DIFFERENCE
		? parseInt(process.env.MAX_SLOT_DIFFERENCE, 10)
		: 500;

	const stateTableName = process.env.STATE_TABLE ?? `${stage}-multisig-monitor-state`;
	const signatureTtlSeconds = process.env.SEEN_SIGNATURE_TTL_HOURS
		? parseInt(process.env.SEEN_SIGNATURE_TTL_HOURS, 10) * 3600
		: 24 * 3600;

	return {
		multisigAddresses,
		signerAddresses: parseCommaList(process.env.SIGNER_ADDRESSES ?? ''),
		slackWebhookUrl,
		filter,
		display,
		logLevel: parseLogLevel(process.env.LOG_LEVEL),
		routes: parseRoutes(process.env.MULTISIG_ROUTES ?? ''),
		rpcUrl: process.env.RPC_URL && process.env.RPC_URL.length > 0 ? process.env.RPC_URL : null,
		fumarole: {
			endpoint: fumaroleEndpoint,
			xToken: fumaroleXToken,
			subscriberName,
			maxSlotDifference,
			startFromTip: parseBool(process.env.START_FROM_TIP),
			fromSlot,
		},
		state: {
			tableName: stateTableName,
			signatureTtlSeconds,
		},
		healthPort: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
	};
}
