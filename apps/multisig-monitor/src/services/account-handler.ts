/**
 * Account-stream handler for Yellowstone nonce-account updates.
 *
 * Why this matters: the TX-stream filter
 * `accountInclude: [...multisigs, ...councilSigners]` does *not* match the
 * Apr 1 2026 attack pattern. The malicious tx was signed by a fresh attacker
 * wallet and only referenced the council signer pubkey *inside* the
 * InitializeNonceAccount instruction data (offset 8 = nonce authority).
 * Yellowstone's accountInclude only matches pubkeys present in the tx's
 * accountKeys list, so the tx never gets delivered.
 *
 * The account stream subscribes directly to nonce accounts whose authority
 * field equals a watched council signer (memcmp at offset 8 over data of
 * size 80 = SystemProgram nonce account layout). This is the only reliable
 * path to detect this attack class in real time.
 *
 * On startup, Yellowstone delivers the snapshot of currently-matching
 * accounts (`isStartup: true`). We write all of those to the seen-nonces
 * store WITHOUT alerting — they're already-known state. After the snapshot
 * window, any new matching account is a fresh exploit attempt: alert + write.
 */
import { logger } from '@backend/common';
import bs58 from 'bs58';
import type { SubscribeUpdate } from '@triton-one/yellowstone-fumarole';
import type { Config } from '../config';
import type { SignerEvent } from '../signer/types';
import { sendSignerEvents } from '../slack';
import type { StateStore } from './state';

const NONCE_AUTHORITY_OFFSET = 8;
const NONCE_AUTHORITY_LEN = 32;
const NONCE_ACCOUNT_DATA_LEN = 80;

export async function handleAccountUpdate(
	update: SubscribeUpdate,
	config: Config,
	store: StateStore
): Promise<void> {
	const acct = update.account;
	if (!acct || !acct.account) return;

	const info = acct.account;
	if (info.data.length !== NONCE_ACCOUNT_DATA_LEN) {
		// Filter should already enforce datasize=80, but defend in depth.
		return;
	}

	const targetedSigner = bs58.encode(
		info.data.subarray(NONCE_AUTHORITY_OFFSET, NONCE_AUTHORITY_OFFSET + NONCE_AUTHORITY_LEN)
	);
	if (!config.signerAddresses.includes(targetedSigner)) {
		// Not one of ours. Defensive — Yellowstone's per-signer memcmp filter
		// should never deliver an update outside our watch list.
		return;
	}

	const nonceAccount = bs58.encode(info.pubkey);
	const alreadySeen = await store.markNonceAccountSeen(nonceAccount);

	if (acct.isStartup) {
		// Snapshot bootstrap: never alert. The store write inside
		// markNonceAccountSeen has already primed the dedupe state for
		// post-snapshot deltas.
		logger.info(
			`snapshot: nonce ${nonceAccount.slice(0, 8)}... authority=${targetedSigner.slice(
				0,
				8
			)}... ${alreadySeen ? '(already known)' : '(new in store)'}`
		);
		return;
	}

	if (alreadySeen) {
		// Post-snapshot delta but already alerted on. Skip.
		return;
	}

	const signature = info.txnSignature ? bs58.encode(info.txnSignature) : '';
	const event: SignerEvent = {
		kind: 'nonce_account_targeting_signer',
		signature,
		blockTime: null,
		targetedSigner,
		funder: null,
		nonceAccount,
	};

	await logger.error(
		`nonce account targeting council signer detected via account stream: nonce=${nonceAccount} authority=${targetedSigner}`
	);

	try {
		await sendSignerEvents([event], config.slackWebhookUrl, config.display);
	} catch (err) {
		await logger.error(`account-stream slack delivery failed: ${(err as Error).message}`);
	}
}
