import {
	BlockhashWithExpiryBlockHeight,
	Commitment,
	Connection,
	Context,
} from '@solana/web3.js';
import { BlockhashSubscriberConfig } from './types';

/**
 * BlockhashSubscriber — polls `getLatestBlockhashAndContext`/`getBlockHeight`
 * on a fixed interval and caches a short history of recent blockhashes, so
 * callers can grab a recent blockhash for transaction building without an
 * RPC round-trip per transaction. Nothing is populated until `subscribe()`
 * (or a manual `updateBlockhash()`) has completed at least once — all getters
 * return `undefined`/empty before then.
 */
export class BlockhashSubscriber {
	private connection: Connection;
	private isSubscribed = false;
	private latestBlockHeight: number | undefined;
	private latestBlockHeightContext: Context | undefined;
	private blockhashes: Array<BlockhashWithExpiryBlockHeight> = [];
	private updateBlockhashIntervalId: ReturnType<typeof setTimeout> | undefined;
	private commitment: Commitment;
	private updateIntervalMs: number;

	/**
	 * @param config Either `connection` or `rpcUrl` must be provided (a `Connection` is created from `rpcUrl` if `connection` is omitted). `commitment` defaults to `'confirmed'`; `updateIntervalMs` defaults to 1000ms.
	 * @throws If neither `config.connection` nor `config.rpcUrl` is provided.
	 */
	constructor(config: BlockhashSubscriberConfig) {
		if (!config.connection && !config.rpcUrl) {
			throw new Error(
				'BlockhashSubscriber requires one of connection or rpcUrl must be provided'
			);
		}
		this.connection = config.connection || new Connection(config.rpcUrl!);
		this.commitment = config.commitment ?? 'confirmed';
		this.updateIntervalMs = config.updateIntervalMs ?? 1000;
	}

	/** @returns The number of blockhashes currently cached (not-yet-expired, per `pruneBlockhashes`). */
	getBlockhashCacheSize(): number {
		return this.blockhashes.length;
	}

	/**
	 * @returns The block height as of the most recent successful poll, or
	 * `undefined` if `subscribe()`/`updateBlockhash()` has not yet completed
	 * successfully at least once (including if every poll so far has errored).
	 * This value is a `getBlockHeight` snapshot taken alongside the latest
	 * blockhash fetch — it is not guaranteed to be perfectly in sync with the
	 * blockhash slot, only "recent as of the last poll".
	 */
	getLatestBlockHeight(): number | undefined {
		return this.latestBlockHeight;
	}

	/** @returns The RPC `Context` (including `slot`) captured with the most recent successful blockhash poll, or `undefined` before the first successful poll. */
	getLatestBlockHeightContext(): Context | undefined {
		return this.latestBlockHeightContext;
	}

	/**
	 * Returns the latest cached blockhash, based on an offset from the latest obtained
	 * @param offset Offset to use, defaulting to 0
	 * @param offsetType If 'seconds', it will use calculate the actual element offset based on the update interval; otherwise it will return a fixed index
	 * @returns Cached blockhash at the given offset, or undefined
	 */
	getLatestBlockhash(
		offset = 0,
		offsetType: 'index' | 'seconds' = 'index'
	): BlockhashWithExpiryBlockHeight | undefined {
		if (this.blockhashes.length === 0) {
			return undefined;
		}

		const elementOffset =
			offsetType == 'seconds'
				? Math.floor((offset * 1000) / this.updateIntervalMs)
				: offset;

		const clampedOffset = Math.max(
			0,
			Math.min(this.blockhashes.length - 1, elementOffset)
		);

		return this.blockhashes[this.blockhashes.length - 1 - clampedOffset];
	}

	/** Drops cached blockhashes whose `lastValidBlockHeight` is at or below `latestBlockHeight` (i.e. already expired for transaction signing). Called automatically after every `updateBlockhash`. No-ops if `latestBlockHeight` hasn't been set yet. */
	pruneBlockhashes() {
		if (this.latestBlockHeight !== undefined) {
			const latestBlockHeight = this.latestBlockHeight;
			this.blockhashes = this.blockhashes.filter(
				(blockhash) => blockhash.lastValidBlockHeight > latestBlockHeight
			);
		}
	}

	/**
	 * Fetches the latest blockhash and block height in parallel and appends
	 * the blockhash to the cache (skipped if it's identical to the
	 * most-recently-cached one), then prunes expired entries. Errors (e.g. RPC
	 * failure) are caught and logged, not thrown — on error, `latestBlockHeight`
	 * is left at its previous value, but `pruneBlockhashes()` still runs in a
	 * `finally` block and may evict entries that expired in the meantime.
	 */
	async updateBlockhash() {
		try {
			const [resp, lastConfirmedBlockHeight] = await Promise.all([
				this.connection.getLatestBlockhashAndContext({
					commitment: this.commitment,
				}),
				this.connection.getBlockHeight({ commitment: this.commitment }),
			]);
			this.latestBlockHeight = lastConfirmedBlockHeight;
			this.latestBlockHeightContext = resp.context;

			// avoid caching duplicate blockhashes
			if (this.blockhashes.length > 0) {
				if (
					resp.value.blockhash ===
					this.blockhashes[this.blockhashes.length - 1].blockhash
				) {
					return;
				}
			}

			this.blockhashes.push(resp.value);
		} catch (e) {
			console.error('Error updating blockhash:\n', e);
		} finally {
			this.pruneBlockhashes();
		}
	}

	/** Performs an immediate `updateBlockhash()` and then starts polling on `updateIntervalMs`. Idempotent — a second call while already subscribed is a no-op. */
	async subscribe() {
		if (this.isSubscribed) {
			return;
		}
		this.isSubscribed = true;

		await this.updateBlockhash();
		this.updateBlockhashIntervalId = setInterval(
			this.updateBlockhash.bind(this),
			this.updateIntervalMs
		);
	}

	/** Stops the polling interval. Cached blockhashes and `latestBlockHeight` are left in place (not cleared). */
	unsubscribe() {
		if (this.updateBlockhashIntervalId) {
			clearInterval(this.updateBlockhashIntervalId);
			this.updateBlockhashIntervalId = undefined;
		}
		this.isSubscribed = false;
	}
}
