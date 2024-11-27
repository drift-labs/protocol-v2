import {
	Commitment,
	Connection,
	SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { BN } from '@coral-xyz/anchor';

// eslint-disable-next-line @typescript-eslint/ban-types
type SlothashSubscriberConfig = {
	resubTimeoutMs?: number;
	commitment?: Commitment;
}; // for future customization

export type Slothash = {
	slot: number;
	hash: string;
};

export class SlothashSubscriber {
	currentSlothash: Slothash;
	subscriptionId: number;
	commitment: Commitment;

	// Reconnection
	timeoutId?: NodeJS.Timeout;
	resubTimeoutMs?: number;
	isUnsubscribing = false;
	receivingData = false;

	public constructor(
		private connection: Connection,
		config?: SlothashSubscriberConfig
	) {
		this.resubTimeoutMs = config?.resubTimeoutMs;
		this.commitment = config?.commitment ?? 'processed';
		if (this.resubTimeoutMs < 1000) {
			console.log(
				'resubTimeoutMs should be at least 1000ms to avoid spamming resub'
			);
		}
	}

	public async subscribe(): Promise<void> {
		if (this.subscriptionId != null) {
			return;
		}

		const currentAccountData = await this.connection.getAccountInfo(
			SYSVAR_SLOT_HASHES_PUBKEY,
			this.commitment
		);
		if (currentAccountData == null) {
			throw new Error('Failed to retrieve current slot hash');
		}
		this.currentSlothash = deserializeSlothash(currentAccountData.data);

		this.subscriptionId = this.connection.onAccountChange(
			SYSVAR_SLOT_HASHES_PUBKEY,
			(slothashInfo, context) => {
				if (!this.currentSlothash || this.currentSlothash.slot < context.slot) {
					if (this.resubTimeoutMs && !this.isUnsubscribing) {
						this.receivingData = true;
						clearTimeout(this.timeoutId);
						this.setTimeout();
					}
					this.currentSlothash = deserializeSlothash(slothashInfo.data);
				}
			},
			this.commitment
		);

		if (this.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}
	}

	private setTimeout(): void {
		this.timeoutId = setTimeout(async () => {
			if (this.isUnsubscribing) {
				// If we are in the process of unsubscribing, do not attempt to resubscribe
				return;
			}

			if (this.receivingData) {
				console.log(
					`No new slot in ${this.resubTimeoutMs}ms, slot subscriber resubscribing`
				);
				await this.unsubscribe(true);
				this.receivingData = false;
				await this.subscribe();
			}
		}, this.resubTimeoutMs);
	}

	public getSlothash(): Slothash {
		return this.currentSlothash;
	}

	public async unsubscribe(onResub = false): Promise<void> {
		if (!onResub) {
			this.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.subscriptionId != null) {
			await this.connection.removeSlotChangeListener(this.subscriptionId);
			this.subscriptionId = undefined;
			this.isUnsubscribing = false;
		} else {
			this.isUnsubscribing = false;
		}
	}
}

function deserializeSlothash(data: Buffer): Slothash {
	const slotNumber = new BN(data.subarray(8, 16), 10, 'le');
	const hash = bs58.encode(data.subarray(16, 48));
	return {
		slot: slotNumber.toNumber(),
		hash,
	};
}
