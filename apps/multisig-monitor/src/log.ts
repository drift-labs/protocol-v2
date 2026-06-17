export type LogLevel = 'error' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
	error: 0,
	info: 1,
	debug: 2,
};

let currentLevel: LogLevel = 'error';

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

export function parseLogLevel(value: string | undefined): LogLevel {
	const v = value?.toLowerCase();
	if (v === 'info' || v === 'debug' || v === 'error') return v;
	return 'error';
}

interface LogEntry {
	readonly level: LogLevel;
	readonly msg: string;
	readonly [key: string]: unknown;
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

export function logError(msg: string, fields?: Record<string, unknown>): void {
	if (!shouldLog('error')) return;
	const entry: LogEntry = { level: 'error', msg, ...fields };
	console.error(JSON.stringify(entry));
}

export function logInfo(msg: string, fields?: Record<string, unknown>): void {
	if (!shouldLog('info')) return;
	const entry: LogEntry = { level: 'info', msg, ...fields };
	console.log(JSON.stringify(entry));
}

export function logDebug(msg: string, fields?: Record<string, unknown>): void {
	if (!shouldLog('debug')) return;
	const entry: LogEntry = { level: 'debug', msg, ...fields };
	console.log(JSON.stringify(entry));
}
