import { GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE } from '../constants/numericConstants';
import { BulkAccountLoader } from './bulkAccountLoader';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';

export class CustomizedCadenceBulkAccountLoader extends BulkAccountLoader {
	private customIntervalId: NodeJS.Timeout | null;
	private currentPollingFrequency: number | null;
	private accountFrequencies: Map<string, number>;
	private lastPollingTimes: Map<string, number>;
	private defaultPollingFrequency: number;

	constructor(
		connection: Connection,
		commitment: Commitment,
		defaultPollingFrequency: number
	) {
		super(connection, commitment, defaultPollingFrequency);
		this.customIntervalId = null;
		this.currentPollingFrequency = null;
		this.accountFrequencies = new Map();
		this.lastPollingTimes = new Map();
		this.defaultPollingFrequency = defaultPollingFrequency;
	}

	private getAccountsToLoad(): Array<{
		publicKey: PublicKey;
		callbacks: Map<string, (buffer: Buffer, slot: number) => void>;
	}> {
		const currentTime = Date.now();
		const accountsToLoad: Array<{
			publicKey: PublicKey;
			callbacks: Map<string, (buffer: Buffer, slot: number) => void>;
		}> = [];

		for (const [key, frequency] of this.accountFrequencies.entries()) {
			const lastPollTime = this.lastPollingTimes.get(key) || 0;
			// Add 25ms buffer to account for slight timing differences
			const timeDiff = currentTime - lastPollTime;
			if (timeDiff >= frequency - 200) {
				const account = this.accountsToLoad.get(key);
				if (account) {
					accountsToLoad.push(account);
					this.lastPollingTimes.set(key, currentTime);
				}
			}
		}

		return accountsToLoad;
	}

	public async load(): Promise<void> {
		return this.handleAccountLoading();
	}

	private async handleAccountLoading(): Promise<void> {
		const accounts = this.getAccountsToLoad();
		console.log('ORACLEDATA handleAccountLoading', accounts.length);

		const oracleAddresses = [
			'3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz', // SOL
			'35MbvS1Juz2wf7GsyHrkCw8yfKciRLxVpEhfZDZFrB4R', // BTC
			'93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR', // ETH
			'CXZhzKePYajrZgZyrzgvHYFKK3c5tNgDrRobAgySo8Nb', // APT
			'BERaNi6cpEresbq6HC1EQGaB1H1UjvEo4NGnmYSSJof4', // BONK
			'HDveCibToLf157NtUqShCEWX3GcF4Aq8Ngt2bst1s1cc', // POL
			'r8eNLQ8jysUyk9rrWXuicwAoKZ7V3YngAB6737zfxmv', // BERA
			'8M8mjNJ42k2Xi12Q1zRnQRC3xhggu3WGuftiu5VZZmsF', // KAITO
			'AZVVDFve8ijzLAm9z6W53GFsoWbcycFsdxCL7WUjMz8S', // IP
			'2sZomfWMDuQLcFak3nuharXorHrZ3hK8iaML6ZGSHtso', // FARTCOIN
			'55722FS8VeAxRghz5h2ARJvNjkFiHyzkZ9BF7CEQWN6E', // ADA
		];

		const oracleMatches = accounts.filter(account => 
			oracleAddresses.some(addr => 
				account.publicKey.toBase58().includes(addr)
			)
		);

		console.log('ORACLEDATA loading oracle accounts:', oracleMatches.length);
		console.log('ORACLEDATA oracle pubkeys found:', 
			oracleMatches.map(account => {
				const pubkey = account.publicKey.toBase58();
				let marketName = '';
				if (pubkey.includes('3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz')) marketName = 'SOL';
				else if (pubkey.includes('35MbvS1Juz2wf7GsyHrkCw8yfKciRLxVpEhfZDZFrB4R')) marketName = 'BTC';
				else if (pubkey.includes('93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR')) marketName = 'ETH';
				else if (pubkey.includes('CXZhzKePYajrZgZyrzgvHYFKK3c5tNgDrRobAgySo8Nb')) marketName = 'APT';
				else if (pubkey.includes('BERaNi6cpEresbq6HC1EQGaB1H1UjvEo4NGnmYSSJof4')) marketName = 'BONK';
				else if (pubkey.includes('HDveCibToLf157NtUqShCEWX3GcF4Aq8Ngt2bst1s1cc')) marketName = 'POL';
				else if (pubkey.includes('r8eNLQ8jysUyk9rrWXuicwAoKZ7V3YngAB6737zfxmv')) marketName = 'BERA';
				else if (pubkey.includes('8M8mjNJ42k2Xi12Q1zRnQRC3xhggu3WGuftiu5VZZmsF')) marketName = 'KAITO';
				else if (pubkey.includes('AZVVDFve8ijzLAm9z6W53GFsoWbcycFsdxCL7WUjMz8S')) marketName = 'IP';
				else if (pubkey.includes('2sZomfWMDuQLcFak3nuharXorHrZ3hK8iaML6ZGSHtso')) marketName = 'FARTCOIN';
				else if (pubkey.includes('55722FS8VeAxRghz5h2ARJvNjkFiHyzkZ9BF7CEQWN6E')) marketName = 'ADA';
				return `${marketName} (${pubkey})`;
			})
		);
		const hasBonkOracle = accounts.some((account) =>
			account.publicKey.toBase58().includes(
				'BERaNi6cpEresbq6HC1EQGaB1H1UjvEo4NGnmYSSJof4'
			)
		);
		// console.log('ORACLEDATA loading accounts hasBonkOracle', hasBonkOracle);
		console.log('ORACLEDATA loading accounts', accounts.map((account) => account.publicKey.toBase58()));

		if (accounts.length > 0) {
			const chunks = this.chunks(
				this.chunks(accounts, GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE),
				10
			);

			await Promise.all(
				chunks.map((chunk) => {
					return this.loadChunk(chunk);
				})
			);
		}
	}

	/**
	 * Updates the polling frequency for an account. This affects all callbacks attached to this account.
	 *
	 * @param publicKey The public key of the account to set the custom polling frequency for
	 * @param newFrequency The new polling frequency in ms
	 */
	public setCustomPollingFrequency(
		publicKey: PublicKey,
		newFrequency: number
	): void {
		const key = publicKey.toBase58();
		this.accountFrequencies.set(key, newFrequency);
		this.lastPollingTimes.set(key, 0); // Reset last polling time to ensure immediate load
		this.restartPollingIfNeeded(newFrequency);
	}

	private restartPollingIfNeeded(newFrequency: number): void {
		if (
			(this.currentPollingFrequency &&
				newFrequency < this.currentPollingFrequency) ||
			!this.customIntervalId
		) {
			this.stopPolling();
			this.startPolling();
		}
	}

	/**
	 * Adds an account to be monitored by the bulk account loader
	 * @param publicKey The public key of the account to monitor
	 * @param callback Function to be called when account data is received
	 * @param customPollingFrequency Optional custom polling frequency in ms for this specific account.
	 * If not provided, will use the default polling frequency
	 * @returns A unique callback ID that can be used to remove this specific callback later
	 *
	 * The method will:
	 * 1. Create a new callback mapping for the account if it doesn't exist already
	 * 2. Set up polling frequency tracking for the account if it doesn't exist already. If previous polling frequency is faster than the new one,
	 *    we will use the previous frequency.
	 * 3. Reset last polling time to 0 to ensure data fetch is triggered on the next poll. Note that this does not mean the account will be fetched immediately.
	 * 4. Automatically restart polling if this account needs a faster frequency than existing accounts
	 */
	public async addAccount(
		publicKey: PublicKey,
		callback: (buffer: Buffer, slot: number) => void,
		customPollingFrequency?: number
	): Promise<string> {
		const callbackId = uuidv4();
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());

		if (existingAccountToLoad) {
			existingAccountToLoad.callbacks.set(callbackId, callback);
		} else {
			const callbacks = new Map<
				string,
				(buffer: Buffer, slot: number) => void
			>();
			callbacks.set(callbackId, callback);
			const newAccountToLoad = {
				publicKey,
				callbacks,
			};
			this.accountsToLoad.set(publicKey.toString(), newAccountToLoad);
		}

		const key = publicKey.toBase58();
		const previousFrequency =
			this.accountFrequencies.get(key) || this.defaultPollingFrequency;
		const updatedFrequency =
			customPollingFrequency && customPollingFrequency < previousFrequency
				? customPollingFrequency
				: previousFrequency;

		this.accountFrequencies.set(key, updatedFrequency);
		this.lastPollingTimes.set(key, 0); // Reset last polling time to ensure immediate load

		this.restartPollingIfNeeded(updatedFrequency);

		return callbackId;
	}

	public removeAccount(publicKey: PublicKey, callbackId: string): void {
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());

		if (existingAccountToLoad) {
			existingAccountToLoad.callbacks.delete(callbackId);

			if (existingAccountToLoad.callbacks.size === 0) {
				this.bufferAndSlotMap.delete(publicKey.toString());
				this.accountsToLoad.delete(existingAccountToLoad.publicKey.toString());
				const key = publicKey.toBase58();
				this.accountFrequencies.delete(key);
				this.lastPollingTimes.delete(key);
			}
		}

		if (this.accountsToLoad.size === 0) {
			this.stopPolling();
		} else {
			// Restart polling in case we removed the account with the smallest frequency
			this.restartPollingIfNeeded(this.defaultPollingFrequency);
		}
	}

	public getAccountCadence(publicKey: PublicKey): number | null {
		const key = publicKey.toBase58();
		return this.accountFrequencies.get(key) || null;
	}

	public startPolling(): void {
		if (this.customIntervalId) {
			return;
		}

		const minFrequency = Math.min(
			...Array.from(this.accountFrequencies.values()),
			this.defaultPollingFrequency
		);

		this.currentPollingFrequency = minFrequency;

		this.customIntervalId = setInterval(() => {
			this.handleAccountLoading().catch((error) => {
				console.error('Error in account loading:', error);
			});
		}, minFrequency);
	}

	public stopPolling(): void {
		super.stopPolling();

		if (this.customIntervalId) {
			clearInterval(this.customIntervalId);
			this.customIntervalId = null;
			this.currentPollingFrequency = null;
		}
		this.lastPollingTimes.clear();
	}

	public clearAccountFrequencies(): void {
		this.accountFrequencies.clear();
	}
}
