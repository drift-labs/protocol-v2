/**
 * Pure pipeline: convert a batch of Yellowstone tx updates into Slack alerts.
 *
 * 1. Convert Yellowstone updates → RawTransaction (boundary type)
 * 2. extractOperations + extractSignerEvents (existing pure decoders)
 * 3. Deduplicate signatures across batches/restarts via the state store
 * 4. Optional layer-2 IDL decoding via on-chain Anchor IDL
 * 5. Group by destination Slack URL (per-multisig routes) and dispatch
 *
 * Cross-batch dedup happens at the *signature* level: a single tx can produce
 * multiple ops + multiple signer events, but if its signature has already been
 * alerted on, we drop everything for that sig. The mark-as-seen happens before
 * Slack delivery, so a Slack failure during the Fumarole replay window can
 * miss a re-alert. Acceptable tradeoff: failures are logged, and the persistent
 * Fumarole subscriber commits offsets on a 5s interval anyway.
 */
import { logger } from '@backend/common';
import type { Config } from '../config';
import { resolveWebhookUrl } from '../config';
import { extractSignerEvents } from '../signer/extractor';
import { sendBatchNotification, sendSignerEvents } from '../slack';
import { decodeOperations } from '../squads/cpi-decoder';
import { extractOperations } from '../squads';
import type { DetectedOperation } from '../squads/types';
import { yellowstoneToRawTransaction, type YellowstoneTransaction } from './converter';
import {
	incrementOperationsAlerted,
	incrementSignatureDedupSkips,
	incrementSignerEventsAlerted,
} from './metrics';
import type { StateStore } from './state';

export async function processTransactions(
	updates: readonly YellowstoneTransaction[],
	config: Config,
	store: StateStore
): Promise<void> {
	if (updates.length === 0) return;

	const transactions = updates
		.map((u) => yellowstoneToRawTransaction(u))
		.filter((t): t is NonNullable<typeof t> => t !== null);
	if (transactions.length === 0) return;

	const operations = await extractOperations(
		transactions,
		[...config.multisigAddresses],
		config.filter
	);
	const signerEvents = extractSignerEvents(transactions, config.signerAddresses);

	// Within-batch dedup by signature (Yellowstone shouldn't repeat within a
	// single batch, but multiple ops can share a signature).
	const withinBatchSeen = new Set<string>();
	const dedupedOps = operations.filter((op) => {
		if (withinBatchSeen.has(op.signature)) return false;
		withinBatchSeen.add(op.signature);
		return true;
	});

	// Cross-batch dedup against the state store. A single sig may produce both
	// ops and signer events — gate on the sig as a unit.
	const candidateSigs = new Set<string>();
	dedupedOps.forEach((o) => candidateSigs.add(o.signature));
	signerEvents.forEach((e) => candidateSigs.add(e.signature));

	const newSigs = new Set<string>();
	await Promise.all(
		[...candidateSigs].map(async (sig) => {
			const alreadySeen = await store.markSignatureSeen(sig);
			if (!alreadySeen) newSigs.add(sig);
		})
	);

	const newOps = dedupedOps.filter((op) => newSigs.has(op.signature));
	const newSignerEvents = signerEvents.filter((e) => newSigs.has(e.signature));

	const dedupSkips = candidateSigs.size - newSigs.size;
	for (let i = 0; i < dedupSkips; i++) incrementSignatureDedupSkips();

	if (newOps.length === 0 && newSignerEvents.length === 0) return;

	try {
		await decodeOperations(newOps);
	} catch (err) {
		const { message } = err as Error;
		await logger.warn(`Layer2 enrichment failed: ${message}`);
	}

	logger.info(
		`processed ${transactions.length} tx(s): ${newOps.length} new op(s), ${
			newSignerEvents.length
		} new signer event(s) (${candidateSigs.size - newSigs.size} sig(s) deduped)`
	);

	const groups = new Map<string, DetectedOperation[]>();
	for (const op of newOps) {
		const url = resolveWebhookUrl(config, op.multisig);
		const group = groups.get(url);
		if (group) group.push(op);
		else groups.set(url, [op]);
	}

	const deliveries: Promise<void>[] = [...groups.entries()].map(([url, ops]) =>
		sendBatchNotification(ops, url, config.display)
	);
	if (newSignerEvents.length > 0) {
		deliveries.push(sendSignerEvents(newSignerEvents, config.slackWebhookUrl, config.display));
	}

	const results = await Promise.allSettled(deliveries);
	let opAlertsDelivered = 0;
	for (let i = 0; i < groups.size; i++) {
		if (results[i]?.status === 'fulfilled') {
			opAlertsDelivered += [...groups.values()][i]!.length;
		}
	}
	for (let i = 0; i < opAlertsDelivered; i++) incrementOperationsAlerted();
	if (newSignerEvents.length > 0 && results[groups.size]?.status === 'fulfilled') {
		for (let i = 0; i < newSignerEvents.length; i++) incrementSignerEventsAlerted();
	}
	for (const result of results) {
		if (result.status === 'rejected') {
			await logger.error(`Slack notification failed: ${String(result.reason)}`);
		}
	}
}
