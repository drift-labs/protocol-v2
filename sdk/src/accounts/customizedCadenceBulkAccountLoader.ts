import { BulkAccountLoader } from './bulkAccountLoader';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';

export class CustomizedCadenceBulkAccountLoader extends BulkAccountLoader {
	private customIntervalIds: Map<string, NodeJS.Timeout>;
	private customPollingGroups: Map<number, Set<string>>;
	private defaultPollingFrequency: number;

	constructor(
		connection: Connection,
		commitment: Commitment,
		defaultPollingFrequency: number
	) {
		super(connection, commitment, defaultPollingFrequency);
		this.customIntervalIds = new Map();
		this.customPollingGroups = new Map();
		this.defaultPollingFrequency = defaultPollingFrequency;
	}

	private updateCustomPolling(frequency: number): void {
		const frequencyStr = frequency.toString();
		const existingInterval = this.customIntervalIds.get(frequencyStr);
		if (existingInterval) {
			clearInterval(existingInterval);
			this.customIntervalIds.delete(frequencyStr);
		}

		const group = this.customPollingGroups.get(frequency);
		if (group && group.size > 0) {
			const intervalId = setInterval(async () => {
				const accounts = Array.from(group)
					.map((key) => this.accountsToLoad.get(key))
					.filter((account) => account !== undefined);

				if (accounts.length > 0) {
					await this.loadChunk([accounts]);
				}
			}, frequency);
			this.customIntervalIds.set(frequencyStr, intervalId);
		}
	}

	public setCustomPollingFrequency(
		publicKey: PublicKey,
		newFrequency: number
	): void {
		const key = publicKey.toBase58();

		// Remove from old frequency group
		for (const [frequency, group] of this.customPollingGroups.entries()) {
			if (group.has(key)) {
				group.delete(key);
				if (group.size === 0) {
					const intervalId = this.customIntervalIds.get(frequency.toString());
					if (intervalId) {
						clearInterval(intervalId);
						this.customIntervalIds.delete(frequency.toString());
					}
					this.customPollingGroups.delete(frequency);
				}
				this.updateCustomPolling(frequency);
				break;
			}
		}

		// Add to new frequency group
		let group = this.customPollingGroups.get(newFrequency);
		if (!group) {
			group = new Set();
			this.customPollingGroups.set(newFrequency, group);
		}
		group.add(key);

		this.updateCustomPolling(newFrequency);
	}

	public async addAccount(
		publicKey: PublicKey,
		callback: (buffer: Buffer, slot: number) => void,
		customPollingFrequency?: number
	): Promise<string> {
		const id = await super.addAccount(publicKey, callback);

		const key = publicKey.toBase58();
		const frequency = customPollingFrequency || this.defaultPollingFrequency;

		// Add to frequency group
		let group = this.customPollingGroups.get(frequency);
		if (!group) {
			group = new Set();
			this.customPollingGroups.set(frequency, group);
		}
		group.add(key);

		this.updateCustomPolling(frequency);

		return id;
	}

	public removeAccount(publicKey: PublicKey, id?: string): void {
		super.removeAccount(publicKey, id);

		const key = publicKey.toBase58();

		// Remove from any polling groups
		for (const [frequency, group] of this.customPollingGroups.entries()) {
			if (group.has(key)) {
				group.delete(key);
				if (group.size === 0) {
					const intervalId = this.customIntervalIds.get(frequency.toString());
					if (intervalId) {
						clearInterval(intervalId);
						this.customIntervalIds.delete(frequency.toString());
					}
					this.customPollingGroups.delete(frequency);
				}
				this.updateCustomPolling(frequency);
				break;
			}
		}
	}

	public getAccountCadence(publicKey: PublicKey): number | null {
		const key = publicKey.toBase58();
		for (const [frequency, group] of this.customPollingGroups.entries()) {
			if (group.has(key)) {
				return frequency;
			}
		}
		return null;
	}

	public startPolling(): void {
		// Don't start the default polling interval
		// Only start custom polling for accounts that have custom frequencies
		for (const frequency of this.customPollingGroups.keys()) {
			this.updateCustomPolling(frequency);
		}
	}

	public stopPolling(): void {
		super.stopPolling();

		// Clear all custom intervals
		for (const intervalId of this.customIntervalIds.values()) {
			clearInterval(intervalId);
		}
		this.customIntervalIds.clear();
	}
}
