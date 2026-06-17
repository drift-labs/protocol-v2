#!/usr/bin/env ts-node
/**
 * Replay a historical transaction through the multisig-monitor pipeline.
 *
 * Fetches the tx via RPC, runs it through the same extractOperations +
 * extractSignerEvents + layer-2-IDL-decode logic the live Fumarole consumer
 * runs, then either prints the would-be Slack payload (default) or POSTs
 * to Slack (with --send).
 *
 * Usage:
 *   yarn workspace @backend/multisig-monitor replay --signature <sig>
 *   yarn workspace @backend/multisig-monitor replay --signature <sig> --send
 *   yarn workspace @backend/multisig-monitor replay --signature <sig> --rpc-url <url>
 *
 * Required env (or CLI overrides):
 *   MULTISIG_ADDRESSES   comma-separated list of Squads multisig addresses
 *   SIGNER_ADDRESSES     comma-separated list of council signer addresses
 *   RPC_URL              Solana RPC endpoint (or pass --rpc-url)
 *   SLACK_WEBHOOK_URL    only required when using --send
 *
 * Exit codes:
 *   0  pipeline ran (with or without alerts)
 *   1  invalid args / config
 *   2  tx not found or RPC error
 *   3  slack delivery failed (--send only)
 */
import { Connection } from '@solana/web3.js';
import { parseCommaList } from '../src/filter';
import { extractSignerEvents } from '../src/signer/extractor';
import {
	buildBatchPayload,
	buildSignerBatchPayload,
	sendBatchNotification,
	sendSignerEvents,
	type DisplayConfig,
} from '../src/slack';
import { decodeOperations } from '../src/squads/cpi-decoder';
import { extractOperations } from '../src/squads';
import type { DetectedOperation } from '../src/squads/types';
import { rpcResponseToRawTransaction } from '../src/services/rpc-converter';

interface Args {
	signature: string;
	send: boolean;
	rpcUrl: string | undefined;
}

function parseArgs(argv: string[]): Args {
	let signature: string | undefined;
	let send = false;
	let rpcUrl: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--signature' || a === '-s') signature = argv[++i];
		else if (a === '--send') send = true;
		else if (a === '--dry-run') send = false;
		else if (a === '--rpc-url') rpcUrl = argv[++i];
		else if (a === '--help' || a === '-h') {
			printHelp();
			process.exit(0);
		} else {
			console.error(`unknown arg: ${a}`);
			printHelp();
			process.exit(1);
		}
	}
	if (!signature) {
		console.error('--signature is required');
		printHelp();
		process.exit(1);
	}
	return { signature, send, rpcUrl };
}

function printHelp(): void {
	console.log(
		`Usage: yarn replay --signature <sig> [--send] [--rpc-url <url>]

  --signature, -s   Solana transaction signature (base58)
  --send            POST the rendered Slack payload (default: dry-run, prints JSON)
  --dry-run         (default) print the rendered payload, don't POST
  --rpc-url         override RPC_URL env var
  --help, -h        show this message

Required env vars:
  MULTISIG_ADDRESSES  comma-separated multisig addresses
  SIGNER_ADDRESSES    comma-separated council signer addresses (may be empty)
  RPC_URL             Solana RPC endpoint (or use --rpc-url)
  SLACK_WEBHOOK_URL   required only with --send

Optional env vars:
  INSTRUCTION_TYPES   comma-separated Squads instruction allowlist
  CONFIG_TYPES        comma-separated config-action allowlist
  SHOW_PERMISSIONS, SHOW_TIMESTAMPS, TRUNCATE_ADDRESSES   "true" to enable`
	);
}

interface ReplayConfig {
	multisigAddresses: string[];
	signerAddresses: string[];
	rpcUrl: string;
	slackWebhookUrl: string | undefined;
	instructionTypes: string[];
	configTypes: string[];
	display: DisplayConfig;
}

function loadReplayConfig(args: Args): ReplayConfig {
	const multisigAddresses = parseCommaList(process.env.MULTISIG_ADDRESSES ?? '');
	if (multisigAddresses.length === 0) {
		console.error('MULTISIG_ADDRESSES is required');
		process.exit(1);
	}

	const rpcUrl = args.rpcUrl ?? process.env.RPC_URL;
	if (!rpcUrl) {
		console.error('--rpc-url or RPC_URL env var is required');
		process.exit(1);
	}

	if (args.send && !process.env.SLACK_WEBHOOK_URL) {
		console.error('SLACK_WEBHOOK_URL is required with --send');
		process.exit(1);
	}

	return {
		multisigAddresses,
		signerAddresses: parseCommaList(process.env.SIGNER_ADDRESSES ?? ''),
		rpcUrl,
		slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
		instructionTypes: parseCommaList(process.env.INSTRUCTION_TYPES ?? ''),
		configTypes: parseCommaList(process.env.CONFIG_TYPES ?? ''),
		display: {
			showPermissions: process.env.SHOW_PERMISSIONS?.toLowerCase() === 'true',
			showTimestamps: process.env.SHOW_TIMESTAMPS?.toLowerCase() === 'true',
			truncateAddresses: process.env.TRUNCATE_ADDRESSES?.toLowerCase() === 'true',
		},
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const config = loadReplayConfig(args);

	const mode = args.send ? 'SEND' : 'DRY-RUN';
	console.log(`[replay] mode=${mode} signature=${args.signature}`);
	console.log(`[replay] multisigs=[${config.multisigAddresses.join(', ')}]`);
	console.log(`[replay] signers=[${config.signerAddresses.join(', ')}]`);

	const connection = new Connection(config.rpcUrl, 'confirmed');
	const resp = await connection
		.getTransaction(args.signature, {
			maxSupportedTransactionVersion: 0,
			commitment: 'confirmed',
		})
		.catch((err) => {
			console.error(`[replay] RPC error: ${(err as Error).message}`);
			process.exit(2);
		});

	if (!resp) {
		console.error(`[replay] transaction not found at ${config.rpcUrl}`);
		process.exit(2);
	}

	console.log(
		`[replay] fetched: slot=${resp.slot} blockTime=${
			resp.blockTime ? new Date(resp.blockTime * 1000).toISOString() : 'null'
		} err=${resp.meta?.err ? JSON.stringify(resp.meta.err) : 'none'}`
	);

	const raw = rpcResponseToRawTransaction(args.signature, resp);

	const operations = await extractOperations([raw], config.multisigAddresses, {
		instructionTypes: config.instructionTypes,
		configTypes: config.configTypes,
	});
	const signerEvents = extractSignerEvents([raw], config.signerAddresses);

	console.log(
		`[replay] extracted: ${operations.length} multisig op(s), ${signerEvents.length} signer event(s)`
	);

	if (operations.length === 0 && signerEvents.length === 0) {
		console.log('[replay] nothing to alert on. exiting.');
		return;
	}

	if (operations.length > 0) {
		try {
			await decodeOperations(operations);
		} catch (err) {
			console.warn(`[replay] layer-2 decode failed: ${(err as Error).message}`);
		}
	}

	const opsByMultisig = new Map<string, DetectedOperation[]>();
	for (const op of operations) {
		const list = opsByMultisig.get(op.multisig) ?? [];
		list.push(op);
		opsByMultisig.set(op.multisig, list);
	}

	if (!args.send) {
		console.log('\n[replay] === would-be slack payloads (dry run) ===\n');
		for (const [multisig, ops] of opsByMultisig) {
			console.log(`-- multisig ${multisig} (${ops.length} op(s)) --`);
			const payloads = buildBatchPayload(ops, config.display);
			console.log(JSON.stringify(payloads, null, 2));
		}
		if (signerEvents.length > 0) {
			console.log(`-- signer events (${signerEvents.length}) --`);
			const payloads = buildSignerBatchPayload(signerEvents, config.display);
			console.log(JSON.stringify(payloads, null, 2));
		}
		console.log('\n[replay] dry run complete. re-run with --send to deliver to Slack.');
		return;
	}

	// Live send. Use the configured slack webhook URL for everything; the
	// replay script doesn't honor MULTISIG_ROUTES (use the live monitor for
	// that). This keeps the script's behavior obvious.
	const slackUrl = config.slackWebhookUrl!;
	console.log(`\n[replay] === posting to slack (${slackUrl.slice(0, 40)}...) ===`);

	const deliveries: Promise<void>[] = [];
	for (const [, ops] of opsByMultisig) {
		deliveries.push(sendBatchNotification(ops, slackUrl, config.display));
	}
	if (signerEvents.length > 0) {
		deliveries.push(sendSignerEvents(signerEvents, slackUrl, config.display));
	}

	const results = await Promise.allSettled(deliveries);
	let failures = 0;
	for (const r of results) {
		if (r.status === 'rejected') {
			console.error(`[replay] slack delivery failed: ${String(r.reason)}`);
			failures++;
		}
	}
	if (failures > 0) {
		process.exit(3);
	}
	console.log(`[replay] sent ${deliveries.length} payload(s) to slack.`);
}

main().catch((err) => {
	console.error(`[replay] unhandled error: ${(err as Error).message}`);
	console.error((err as Error).stack);
	process.exit(1);
});
