import {
	BlockhashWithExpiryBlockHeight,
	Commitment,
	Connection,
	Context,
} from '@solana/web3.js';
import { BlockhashSubscriberConfig } from './types';

export class BlockhashSubscriber {
	private connection: Connection;
	private isSubscribed = false;
	private latestBlockHeight: number;
	private latestBlockHeightContext: Context | undefined;
	private blockhashes: Array<BlockhashWithExpiryBlockHeight> = [];
	private updateBlockhashIntervalId: NodeJS.Timeout | undefined;
	private commitment: Commitment;
	private updateIntervalMs: number;

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

	getBlockhashCacheSize(): number {
		return this.blockhashes.length;
	}

	getLatestBlockHeight(): number {
		return this.latestBlockHeight;
	}

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

	pruneBlockhashes() {
		if (this.latestBlockHeight) {
			this.blockhashes = this.blockhashes.filter(
				(blockhash) => blockhash.lastValidBlockHeight > this.latestBlockHeight!
			);
		}
	}

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

	unsubscribe() {
		if (this.updateBlockhashIntervalId) {
			clearInterval(this.updateBlockhashIntervalId);
			this.updateBlockhashIntervalId = undefined;
		}
		this.isSubscribed = false;
	}
}
