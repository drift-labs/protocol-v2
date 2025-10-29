import { BufferAndSlot, ProgramAccountSubscriber, ResubOpts } from './types';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Commitment, Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import {
	AccountInfoBase,
	AccountInfoWithBase58EncodedData,
	AccountInfoWithBase64EncodedData,
	createSolanaClient,
	isAddress,
	type Address,
	type Commitment as GillCommitment,
} from 'gill';
import bs58 from 'bs58';

export class WebSocketProgramAccountSubscriberV2<T>
	implements ProgramAccountSubscriber<T>
{
	subscriptionName: string;
	accountDiscriminator: string;
	bufferAndSlot?: BufferAndSlot;
	bufferAndSlotMap: Map<string, BufferAndSlot> = new Map();
	program: Program;
	decodeBuffer: (accountName: string, ix: Buffer) => T;
	onChange: (
		accountId: PublicKey,
		data: T,
		context: Context,
		buffer: Buffer
	) => void;
	listenerId?: number;
	resubOpts?: ResubOpts;
	isUnsubscribing = false;
	timeoutId?: ReturnType<typeof setTimeout>;
	options: { filters: MemcmpFilter[]; commitment?: Commitment };

	receivingData = false;

	// Gill client components
	private rpc: ReturnType<typeof createSolanaClient>['rpc'];
	private rpcSubscriptions: ReturnType<
		typeof createSolanaClient
	>['rpcSubscriptions'];
	private abortController?: AbortController;

	// Polling logic for specific accounts
	private accountsToMonitor: Set<string> = new Set();
	private pollingIntervalMs: number = 30000; // 30 seconds
	private pollingTimeouts: Map<string, ReturnType<typeof setTimeout>> =
		new Map();
	private lastWsNotificationTime: Map<string, number> = new Map(); // Track last WS notification time per account
	private accountsCurrentlyPolling: Set<string> = new Set(); // Track which accounts are being polled
	private batchPollingTimeout?: ReturnType<typeof setTimeout>; // Single timeout for batch polling

	public constructor(
		subscriptionName: string,
		accountDiscriminator: string,
		program: Program,
		decodeBufferFn: (accountName: string, ix: Buffer) => T,
		options: { filters: MemcmpFilter[]; commitment?: Commitment } = {
			filters: [],
		},
		resubOpts?: ResubOpts,
		accountsToMonitor?: PublicKey[] // Optional list of accounts to poll
	) {
		this.subscriptionName = subscriptionName;
		this.accountDiscriminator = accountDiscriminator;
		this.program = program;
		this.decodeBuffer = decodeBufferFn;
		this.resubOpts = resubOpts;
		if (this.resubOpts?.resubTimeoutMs < 1000) {
			console.log(
				'resubTimeoutMs should be at least 1000ms to avoid spamming resub'
			);
		}
		this.options = options;
		this.receivingData = false;

		// Initialize accounts to monitor
		if (accountsToMonitor) {
			accountsToMonitor.forEach((account) => {
				this.accountsToMonitor.add(account.toBase58());
			});
		}

		// Initialize gill client using the same RPC URL as the program provider
		const rpcUrl = (this.program.provider as AnchorProvider).connection
			.rpcEndpoint;
		const { rpc, rpcSubscriptions } = createSolanaClient({
			urlOrMoniker: rpcUrl,
		});
		this.rpc = rpc;
		this.rpcSubscriptions = rpcSubscriptions;
	}

	async subscribe(
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer
		) => void
	): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			return;
		}

		this.onChange = onChange;

		// Create abort controller for proper cleanup
		const abortController = new AbortController();
		this.abortController = abortController;

		// Subscribe to program account changes using gill's rpcSubscriptions
		const programId = this.program.programId.toBase58();
		if (isAddress(programId)) {
			const subscription = await this.rpcSubscriptions
				.programNotifications(programId, {
					commitment: this.options.commitment as GillCommitment,
					encoding: 'base64',
					filters: this.options.filters.map((filter) => ({
						memcmp: {
							offset: BigInt(filter.memcmp.offset),
							bytes: filter.memcmp.bytes as any,
							encoding: 'base64' as const,
						},
					})),
				})
				.subscribe({
					abortSignal: abortController.signal,
				});

			for await (const notification of subscription) {
				if (this.resubOpts?.resubTimeoutMs) {
					this.receivingData = true;
					clearTimeout(this.timeoutId);
					this.handleRpcResponse(
						notification.context,
						notification.value.account
					);
					this.setTimeout();
				} else {
					this.handleRpcResponse(
						notification.context,
						notification.value.account
					);
				}
			}
		}

		this.listenerId = Math.random(); // Unique ID for logging purposes

		if (this.resubOpts?.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}

		// Start monitoring for accounts that may need polling if no WS event is received
		this.startMonitoringForAccounts();
	}

	protected setTimeout(): void {
		if (!this.onChange) {
			throw new Error('onChange callback function must be set');
		}
		this.timeoutId = setTimeout(
			async () => {
				if (this.isUnsubscribing) {
					// If we are in the process of unsubscribing, do not attempt to resubscribe
					return;
				}

				if (this.receivingData) {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`No ws data from ${this.subscriptionName} in ${this.resubOpts?.resubTimeoutMs}ms, resubscribing`
						);
					}
					await this.unsubscribe(true);
					this.receivingData = false;
					await this.subscribe(this.onChange);
				}
			},
			this.resubOpts?.resubTimeoutMs
		);
	}

	handleRpcResponse(
		context: { slot: bigint },
		accountInfo?: AccountInfoBase &
			(AccountInfoWithBase58EncodedData | AccountInfoWithBase64EncodedData)
	): void {
		const newSlot = Number(context.slot);
		let newBuffer: Buffer | undefined = undefined;

		if (accountInfo) {
			// Extract data from gill response
			if (accountInfo.data) {
				// Handle different data formats from gill
				if (Array.isArray(accountInfo.data)) {
					// If it's a tuple [data, encoding]
					const [data, encoding] = accountInfo.data;

					if (encoding === ('base58' as any)) {
						// Convert base58 to buffer using bs58
						newBuffer = Buffer.from(bs58.decode(data));
					} else {
						newBuffer = Buffer.from(data, 'base64');
					}
				}
			}
		}

		// Convert gill's account key to PublicKey
		// Note: accountInfo doesn't have a key property, we need to get it from the notification
		// For now, we'll use a placeholder - this needs to be fixed based on the actual gill API
		const accountId = new PublicKey('11111111111111111111111111111111'); // Placeholder
		const accountIdString = accountId.toBase58();

		const existingBufferAndSlot = this.bufferAndSlotMap.get(accountIdString);

		// Track WebSocket notification time for this account
		this.lastWsNotificationTime.set(accountIdString, Date.now());

		// If this account was being polled, stop polling it
		if (this.accountsCurrentlyPolling.has(accountIdString)) {
			this.accountsCurrentlyPolling.delete(accountIdString);

			// If no more accounts are being polled, stop batch polling
			if (
				this.accountsCurrentlyPolling.size === 0 &&
				this.batchPollingTimeout
			) {
				clearTimeout(this.batchPollingTimeout);
				this.batchPollingTimeout = undefined;
			}
		}

		if (!existingBufferAndSlot) {
			if (newBuffer) {
				this.bufferAndSlotMap.set(accountIdString, {
					buffer: newBuffer,
					slot: newSlot,
				});
				const account = this.decodeBuffer(this.accountDiscriminator, newBuffer);
				this.onChange(accountId, account, { slot: newSlot }, newBuffer);
			}
			return;
		}

		if (newSlot < existingBufferAndSlot.slot) {
			return;
		}

		const oldBuffer = existingBufferAndSlot.buffer;
		if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
			this.bufferAndSlotMap.set(accountIdString, {
				buffer: newBuffer,
				slot: newSlot,
			});
			const account = this.decodeBuffer(this.accountDiscriminator, newBuffer);
			this.onChange(accountId, account, { slot: newSlot }, newBuffer);
		}
	}

	private startMonitoringForAccounts(): void {
		// Clear any existing polling timeouts
		this.clearPollingTimeouts();

		// Start monitoring for each account in the accountsToMonitor set
		this.accountsToMonitor.forEach((accountIdString) => {
			this.startMonitoringForAccount(accountIdString);
		});
	}

	private startMonitoringForAccount(accountIdString: string): void {
		// Clear existing timeout for this account
		const existingTimeout = this.pollingTimeouts.get(accountIdString);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		// Set up monitoring timeout - only start polling if no WS notification in 30s
		const timeoutId = setTimeout(async () => {
			// Check if we've received a WS notification for this account recently
			const lastNotificationTime =
				this.lastWsNotificationTime.get(accountIdString);
			const currentTime = Date.now();

			if (
				!lastNotificationTime ||
				currentTime - lastNotificationTime >= this.pollingIntervalMs
			) {
				// No recent WS notification, start polling
				await this.pollAccount(accountIdString);
				// Schedule next poll
				this.startPollingForAccount(accountIdString);
			} else {
				// We received a WS notification recently, continue monitoring
				this.startMonitoringForAccount(accountIdString);
			}
		}, this.pollingIntervalMs);

		this.pollingTimeouts.set(accountIdString, timeoutId);
	}

	private startPollingForAccount(accountIdString: string): void {
		// Add account to polling set
		this.accountsCurrentlyPolling.add(accountIdString);

		// If this is the first account being polled, start batch polling
		if (this.accountsCurrentlyPolling.size === 1) {
			this.startBatchPolling();
		}
	}

	private startBatchPolling(): void {
		// Clear existing batch polling timeout
		if (this.batchPollingTimeout) {
			clearTimeout(this.batchPollingTimeout);
		}

		// Set up batch polling interval
		this.batchPollingTimeout = setTimeout(async () => {
			await this.pollAllAccounts();
			// Schedule next batch poll
			this.startBatchPolling();
		}, this.pollingIntervalMs);
	}

	private async pollAllAccounts(): Promise<void> {
		try {
			// Get all accounts currently being polled
			const accountsToPoll = Array.from(this.accountsCurrentlyPolling);
			if (accountsToPoll.length === 0) {
				return;
			}

			// Fetch all accounts in a single batch request
			const accountAddresses = accountsToPoll.map(
				(accountId) => accountId as Address
			);
			const rpcResponse = await this.rpc
				.getMultipleAccounts(accountAddresses, {
					commitment: this.options.commitment as GillCommitment,
					encoding: 'base64',
				})
				.send();

			const currentSlot = Number(rpcResponse.context.slot);

			// Process each account response
			for (let i = 0; i < accountsToPoll.length; i++) {
				const accountIdString = accountsToPoll[i];
				const accountInfo = rpcResponse.value[i];

				if (!accountInfo) {
					continue;
				}

				const existingBufferAndSlot =
					this.bufferAndSlotMap.get(accountIdString);

				if (!existingBufferAndSlot) {
					// Account not in our map yet, add it
					let newBuffer: Buffer | undefined = undefined;
					if (accountInfo.data) {
						if (Array.isArray(accountInfo.data)) {
							const [data, encoding] = accountInfo.data;
							newBuffer = Buffer.from(data, encoding);
						}
					}

					if (newBuffer) {
						this.bufferAndSlotMap.set(accountIdString, {
							buffer: newBuffer,
							slot: currentSlot,
						});
						const account = this.decodeBuffer(
							this.accountDiscriminator,
							newBuffer
						);
						const accountId = new PublicKey(accountIdString);
						this.onChange(accountId, account, { slot: currentSlot }, newBuffer);
					}
					continue;
				}

				// Check if we missed an update
				if (currentSlot > existingBufferAndSlot.slot) {
					let newBuffer: Buffer | undefined = undefined;
					if (accountInfo.data) {
						if (Array.isArray(accountInfo.data)) {
							const [data, encoding] = accountInfo.data;
							if (encoding === ('base58' as any)) {
								newBuffer = Buffer.from(bs58.decode(data));
							} else {
								newBuffer = Buffer.from(data, 'base64');
							}
						}
					}

					// Check if buffer has changed
					if (
						newBuffer &&
						(!existingBufferAndSlot.buffer ||
							!newBuffer.equals(existingBufferAndSlot.buffer))
					) {
						if (this.resubOpts?.logResubMessages) {
							console.log(
								`[${this.subscriptionName}] Batch polling detected missed update for account ${accountIdString}, resubscribing`
							);
						}
						// We missed an update, resubscribe
						await this.unsubscribe(true);
						this.receivingData = false;
						await this.subscribe(this.onChange);
						return;
					}
				}
			}
		} catch (error) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.subscriptionName}] Error batch polling accounts:`,
					error
				);
			}
		}
	}

	private async pollAccount(accountIdString: string): Promise<void> {
		try {
			// Fetch current account data using gill's rpc
			const accountAddress = accountIdString as Address;
			const rpcResponse = await this.rpc
				.getAccountInfo(accountAddress, {
					commitment: this.options.commitment as GillCommitment,
					encoding: 'base64',
				})
				.send();

			const currentSlot = Number(rpcResponse.context.slot);
			const existingBufferAndSlot = this.bufferAndSlotMap.get(accountIdString);

			if (!existingBufferAndSlot) {
				// Account not in our map yet, add it
				if (rpcResponse.value) {
					let newBuffer: Buffer | undefined = undefined;
					if (rpcResponse.value.data) {
						if (Array.isArray(rpcResponse.value.data)) {
							const [data, encoding] = rpcResponse.value.data;
							newBuffer = Buffer.from(data, encoding);
						}
					}

					if (newBuffer) {
						this.bufferAndSlotMap.set(accountIdString, {
							buffer: newBuffer,
							slot: currentSlot,
						});
						const account = this.decodeBuffer(
							this.accountDiscriminator,
							newBuffer
						);
						const accountId = new PublicKey(accountIdString);
						this.onChange(accountId, account, { slot: currentSlot }, newBuffer);
					}
				}
				return;
			}

			// Check if we missed an update
			if (currentSlot > existingBufferAndSlot.slot) {
				let newBuffer: Buffer | undefined = undefined;
				if (rpcResponse.value) {
					if (rpcResponse.value.data) {
						if (Array.isArray(rpcResponse.value.data)) {
							const [data, encoding] = rpcResponse.value.data;
							if (encoding === ('base58' as any)) {
								newBuffer = Buffer.from(bs58.decode(data));
							} else {
								newBuffer = Buffer.from(data, 'base64');
							}
						}
					}
				}

				// Check if buffer has changed
				if (
					newBuffer &&
					(!existingBufferAndSlot.buffer ||
						!newBuffer.equals(existingBufferAndSlot.buffer))
				) {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`[${this.subscriptionName}] Polling detected missed update for account ${accountIdString}, resubscribing`
						);
					}
					// We missed an update, resubscribe
					await this.unsubscribe(true);
					this.receivingData = false;
					await this.subscribe(this.onChange);
					return;
				}
			}
		} catch (error) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.subscriptionName}] Error polling account ${accountIdString}:`,
					error
				);
			}
		}
	}

	private clearPollingTimeouts(): void {
		this.pollingTimeouts.forEach((timeoutId) => {
			clearTimeout(timeoutId);
		});
		this.pollingTimeouts.clear();

		// Clear batch polling timeout
		if (this.batchPollingTimeout) {
			clearTimeout(this.batchPollingTimeout);
			this.batchPollingTimeout = undefined;
		}

		// Clear accounts currently polling
		this.accountsCurrentlyPolling.clear();
	}

	unsubscribe(onResub = false): Promise<void> {
		if (!onResub) {
			this.resubOpts.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		// Clear polling timeouts
		this.clearPollingTimeouts();

		// Abort the WebSocket subscription
		if (this.abortController) {
			this.abortController.abort('unsubscribing');
			this.abortController = undefined;
		}

		this.listenerId = undefined;
		this.isUnsubscribing = false;

		return Promise.resolve();
	}

	// Method to add accounts to the polling list
	addAccountToMonitor(accountId: PublicKey): void {
		const accountIdString = accountId.toBase58();
		this.accountsToMonitor.add(accountIdString);

		// If already subscribed, start monitoring for this account
		if (this.listenerId != null && !this.isUnsubscribing) {
			this.startMonitoringForAccount(accountIdString);
		}
	}

	// Method to remove accounts from the polling list
	removeAccountFromMonitor(accountId: PublicKey): void {
		const accountIdString = accountId.toBase58();
		this.accountsToMonitor.delete(accountIdString);

		// Clear monitoring timeout for this account
		const timeoutId = this.pollingTimeouts.get(accountIdString);
		if (timeoutId) {
			clearTimeout(timeoutId);
			this.pollingTimeouts.delete(accountIdString);
		}

		// Remove from currently polling set if it was being polled
		this.accountsCurrentlyPolling.delete(accountIdString);

		// If no more accounts are being polled, stop batch polling
		if (this.accountsCurrentlyPolling.size === 0 && this.batchPollingTimeout) {
			clearTimeout(this.batchPollingTimeout);
			this.batchPollingTimeout = undefined;
		}
	}

	// Method to set polling interval
	setPollingInterval(intervalMs: number): void {
		this.pollingIntervalMs = intervalMs;
		// Restart monitoring with new interval if already subscribed
		if (this.listenerId != null && !this.isUnsubscribing) {
			this.startMonitoringForAccounts();
		}
	}
}
