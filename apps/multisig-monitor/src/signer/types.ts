/**
 * Events emitted by the signer-watch pipeline. These are flagged when a
 * transaction targets a watched council signer in a way that suggests
 * preparation for (or execution of) a durable-nonce attack.
 *
 * Filter is on the *authority arg* of InitializeNonceAccount, not the tx
 * signer — this catches the observed Drift exploit pattern where a fresh
 * attacker-controlled wallet funds the nonce-create tx and passes the
 * council member's pubkey as the authority arg.
 *
 * `signature` may be empty when the event is derived from a Yellowstone
 * account-stream update with no `txnSignature` attached. `funder` may be
 * `null` when only the account update (not the originating tx) was observed.
 */
export type SignerEvent = {
	signature: string;
	blockTime: number | null;
} & SignerEventDetails;

export type SignerEventDetails = {
	kind: 'nonce_account_targeting_signer';
	/**
	 * The watched council member passed as the nonce authority. Anyone
	 * holding this private key can subsequently AdvanceNonce on the new
	 * account, enabling pre-signed durable-nonce txs.
	 */
	targetedSigner: string;
	/**
	 * Fee payer / first signer of the nonce-creation tx. In the observed
	 * Drift exploit this was a fresh attacker-controlled wallet, distinct
	 * from the targeted council member. `null` when only an account-stream
	 * update was observed (no originating tx fetched).
	 */
	funder: string | null;
	/** The newly initialized nonce account. */
	nonceAccount: string;
};
