import { GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE } from '../constants/numericConstants';
import { BulkAccountLoader } from './bulkAccountLoader';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';

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

	private reloadFrequencyGroup(frequency: number): void {
		const frequencyStr = frequency.toString();
		const existingInterval = this.customIntervalIds.get(frequencyStr);
		if (existingInterval) {
			clearInterval(existingInterval);
			this.customIntervalIds.delete(frequencyStr);
		}

		const group = this.customPollingGroups.get(frequency);
		if (group && group.size > 0) {
			const handleAccountLoading = async () => {
				const accounts = Array.from(group)
					.map((key) => this.accountsToLoad.get(key))
					.filter((account) => account !== undefined);

				if (accounts.length > 0) {
					const chunks = this.chunks(
						this.chunks(Array.from(accounts), GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE),
						10
					);

					await Promise.all(
						chunks.map((chunk) => {
							return this.loadChunk(chunk);
						})
					);
				}
			};
			const intervalId = setInterval(handleAccountLoading, frequency);
			this.customIntervalIds.set(frequencyStr, intervalId);
		}
	}

	public setCustomPollingFrequency(
		publicKey: PublicKey,
		newFrequency: number
	): void {
		const key = publicKey.toBase58();

		let removedFromOldGroup = false;
		// Remove from old frequency group
		for (const [frequency, group] of this.customPollingGroups.entries()) {
			if (group.has(key)) {
				if (newFrequency === frequency) {
					// if frequency is the same, we do nothing
					break;
				}
				group.delete(key);
				if (group.size === 0) {
					const intervalId = this.customIntervalIds.get(frequency.toString());
					if (intervalId) {
						clearInterval(intervalId);
						this.customIntervalIds.delete(frequency.toString());
					}
					this.customPollingGroups.delete(frequency);
				}
				removedFromOldGroup = true;
				break;
			}
		}

		// Add to new frequency group
		if (removedFromOldGroup) {
			let group = this.customPollingGroups.get(newFrequency);
			if (!group) {
				group = new Set();
				this.customPollingGroups.set(newFrequency, group);
			}
			group.add(key);

			this.reloadFrequencyGroup(newFrequency);
		}
	}

	public async addAccount(
		publicKey: PublicKey,
		callback: (buffer: Buffer, slot: number) => void,
		customPollingFrequency?: number
	): Promise<string> {
		const callbackId = uuidv4();
		const callbacks = new Map<string, (buffer: Buffer, slot: number) => void>();
		callbacks.set(callbackId, callback);
		const newAccountToLoad = {
			publicKey,
			callbacks,
		};
		this.accountsToLoad.set(publicKey.toString(), newAccountToLoad);

		const key = publicKey.toBase58();
		const frequency = customPollingFrequency || this.defaultPollingFrequency;

		// Add to frequency group
		let group = this.customPollingGroups.get(frequency);
		if (!group) {
			group = new Set();
			this.customPollingGroups.set(frequency, group);
		}
		group.add(key);

		this.reloadFrequencyGroup(frequency);

		return callbackId;
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
				this.reloadFrequencyGroup(frequency);
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
		// Don't start the polling in the base class
		// Only start polling in these custom frequencies
		for (const frequency of this.customPollingGroups.keys()) {
			this.reloadFrequencyGroup(frequency);
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
