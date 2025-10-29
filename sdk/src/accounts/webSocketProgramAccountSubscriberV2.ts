import { BufferAndSlot, ProgramAccountSubscriber, ResubOpts } from './types';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Commitment, Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import {
	AccountInfoBase,
	AccountInfoWithBase58EncodedData,
	AccountInfoWithBase64EncodedData,
	createSolanaClient,
	isAddress,
	Lamports,
	Slot,
	Address,
	Commitment as GillCommitment,
} from 'gill';
import bs58 from 'bs58';

type ProgramAccountSubscriptionAsyncIterable = AsyncIterable<
	Readonly<{
		context: Readonly<{
			slot: Slot;
		}>;
		value: Readonly<{
			account: Readonly<{
				executable: boolean;
				lamports: Lamports;
				owner: Address;
				rentEpoch: bigint;
				space: bigint;
			}> &
				Readonly<any>;
			pubkey: Address;
		}>;
	}>
>;
/**
 * WebSocketProgramAccountsSubscriberV2
 *
 * High-level overview
 * - WebSocket-first subscriber for Solana program accounts that also layers in
 *   targeted polling to detect missed updates reliably.
 * - Emits decoded account updates via the provided `onChange` callback.
 * - Designed to focus extra work on the specific accounts the consumer cares
 *   about ("monitored accounts") while keeping baseline WS behavior for the
 *   full program subscription.
 *
 * Why polling if this is a WebSocket subscriber?
 * - WS infra can stall, drop, or reorder notifications under network stress or
 *   provider hiccups. When that happens, critical account changes can be missed.
 * - To mitigate this, the class accepts a set of accounts (provided via constructor) to monitor
 *   and uses light polling to verify whether a WS change was missed.
 * - If polling detects a newer slot with different data than the last seen
 *   buffer, a centralized resubscription is triggered to restore a clean stream.
 *
 * Initial fetch (on subscribe)
 * - On `subscribe()`, we first perform a single batched fetch of all monitored
 *   accounts ("initial monitor fetch").
 * - Purpose: seed the internal `bufferAndSlotMap` and emit the latest state so
 *   consumers have up-to-date data immediately, even before WS events arrive.
 * - This step does not decide resubscription; it only establishes ground truth.
 *
 * Continuous polling (only for monitored accounts)
 * - After seeding, each monitored account is put into a monitoring cycle:
 *   1) If no WS notification for an account is observed for `pollingIntervalMs`,
 *      we enqueue it for a batched fetch (buffered for a short window).
 *   2) Once an account enters the "currently polling" set, a shared batch poll
 *      runs every `pollingIntervalMs` across all such accounts.
 *   3) If WS notifications resume for an account, that account is removed from
 *      the polling set and returns to passive monitoring.
 * - Polling compares the newly fetched buffer with the last stored buffer at a
 *   later slot. A difference indicates a missed update; we schedule a single
 *   resubscription (coalesced across accounts) to re-sync.
 *
 * Accounts the consumer cares about
 * - Provide accounts up-front via the constructor `accountsToMonitor`, or add
 *   them dynamically with `addAccountToMonitor()` and remove with
 *   `removeAccountFromMonitor()`.
 * - Only these accounts incur additional polling safeguards; other accounts are
 *   still processed from the WS stream normally.
 *
 * Resubscription strategy
 * - Missed updates from any monitored account are coalesced and trigger a single
 *   resubscription after a short delay. This avoids rapid churn.
 * - If `resubOpts.resubTimeoutMs` is set, an inactivity timer also performs a
 *   batch check of monitored accounts. If a missed update is found, the same
 *   centralized resubscription flow is used.
 *
 * Tuning knobs
 * - `setPollingInterval(ms)`: adjust how often monitoring/polling runs
 *   (default 30s). Shorter = faster detection, higher RPC load.
 * - Debounced immediate poll (~100ms): batches accounts added to polling right after inactivity.
 * - Batch size for `getMultipleAccounts` is limited to 100, requests are chunked
 *   and processed concurrently.
 */

export class WebSocketProgramAccountsSubscriberV2<T>
	implements ProgramAccountSubscriber<T>
{
	subscriptionName: string;
	accountDiscriminator: string;
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
	resubOpts: ResubOpts;
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

	// Debounced immediate poll to batch multiple additions within a short window
	private debouncedImmediatePollTimeout?: ReturnType<typeof setTimeout>;
	private debouncedImmediatePollMs: number = 100; // configurable short window

	// Centralized resubscription handling
	private missedChangeDetected = false; // Flag to track if any missed change was detected
	private resubscriptionTimeout?: ReturnType<typeof setTimeout>; // Timeout for delayed resubscription
	private accountsWithMissedUpdates: Set<string> = new Set(); // Track which accounts had missed updates

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
		this.resubOpts = resubOpts ?? {
			resubTimeoutMs: 30000,
			usePollingInsteadOfResub: true,
			logResubMessages: false,
		};
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

	private async handleNotificationLoop(
		notificationPromise: Promise<ProgramAccountSubscriptionAsyncIterable>
	) {
		try {
			const subscriptionIterable = await notificationPromise;
			for await (const notification of subscriptionIterable) {
				try {
					if (this.resubOpts?.resubTimeoutMs) {
						this.receivingData = true;
						clearTimeout(this.timeoutId);
						this.handleRpcResponse(
							notification.context,
							notification.value.pubkey,
							notification.value.account.data
						);
						this.setTimeout();
					} else {
						this.handleRpcResponse(
							notification.context,
							notification.value.pubkey,
							notification.value.account.data
						);
					}
				} catch (error) {
					console.error(
						`Error handling RPC response for pubkey ${notification.value.pubkey}:`,
						error
					);
				}
			}
		} catch (error) {
			console.error(
				`[${this.subscriptionName}] Error in notification loop:`,
				error
			);
		}
	}

	async subscribe(
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer
		) => void
	): Promise<void> {
		/**
		 * Start the WebSocket subscription and initialize polling safeguards.
		 *
		 * Flow
		 * - Seeds all monitored accounts with a single batched RPC fetch and emits
		 *   their current state.
		 * - Subscribes to program notifications via WS using gill.
		 * - If `resubOpts.resubTimeoutMs` is set, starts an inactivity timer that
		 *   batch-checks monitored accounts when WS goes quiet.
		 * - Begins monitoring for accounts that may need polling when WS
		 *   notifications are not observed within `pollingIntervalMs`.
		 *
		 * @param onChange Callback invoked with decoded account data when an update
		 * is detected (via WS or batch RPC fetch).
		 */
		const startTime = performance.now();
		if (this.listenerId != null || this.isUnsubscribing) {
			return;
		}

		if (this.resubOpts?.logResubMessages) {
			console.log(
				`[${this.subscriptionName}] initializing subscription. This many monitored accounts: ${this.accountsToMonitor.size}`
			);
		}

		this.onChange = onChange;

		// initial fetch of monitored data - only fetch and populate, don't check for missed changes
		await this.fetchAndPopulateAllMonitoredAccounts();

		// Create abort controller for proper cleanup
		const abortController = new AbortController();
		this.abortController = abortController;

		this.listenerId = Math.random(); // Unique ID for logging purposes

		if (this.resubOpts?.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}

		// Subscribe to program account changes using gill's rpcSubscriptions
		const programId = this.program.programId.toBase58();
		if (isAddress(programId)) {
			const subscriptionPromise = this.rpcSubscriptions
				.programNotifications(programId, {
					commitment: this.options.commitment as GillCommitment,
					encoding: 'base64',
					filters: this.options.filters.map((filter) => {
						// Convert filter bytes from base58 to base64 if needed
						let bytes = filter.memcmp.bytes;
						if (
							typeof bytes === 'string' &&
							/^[1-9A-HJ-NP-Za-km-z]+$/.test(bytes)
						) {
							// Looks like base58 - convert to base64
							const decoded = bs58.decode(bytes);
							bytes = Buffer.from(decoded).toString('base64');
						}

						return {
							memcmp: {
								offset: BigInt(filter.memcmp.offset),
								bytes: bytes as any,
								encoding: 'base64' as const,
							},
						};
					}),
				})
				.subscribe({
					abortSignal: abortController.signal,
				});

			// Start notification loop without awaiting
			this.handleNotificationLoop(subscriptionPromise);
			// Start monitoring for accounts that may need polling if no WS event is received
			this.startMonitoringForAccounts();
		}
		const endTime = performance.now();
		console.log(
			`[PROFILING] ${this.subscriptionName}.subscribe() completed in ${
				endTime - startTime
			}ms`
		);
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
							`No ws data from ${this.subscriptionName} in ${this.resubOpts?.resubTimeoutMs}ms, checking for missed changes`
						);
					}

					// Check for missed changes in monitored accounts
					const missedChangeDetected = await this.fetchAllMonitoredAccounts();

					if (missedChangeDetected) {
						// Signal missed change with a generic identifier since we don't have specific account IDs from this context
						this.signalMissedChange('timeout-check');
					} else {
						// No missed changes, continue monitoring
						this.receivingData = false;
						this.setTimeout();
					}
				}
			},
			this.resubOpts?.resubTimeoutMs
		);
	}

	handleRpcResponse(
		context: { slot: bigint },
		accountId: Address,
		accountInfo?: AccountInfoBase &
			(
				| AccountInfoWithBase58EncodedData
				| AccountInfoWithBase64EncodedData
			)['data']
	): void {
		const newSlot = Number(context.slot);
		let newBuffer: Buffer | undefined = undefined;

		if (accountInfo) {
			// Handle different data formats from gill
			if (Array.isArray(accountInfo)) {
				// If it's a tuple [data, encoding]
				const [data, encoding] = accountInfo;

				if (encoding === ('base58' as any)) {
					// Convert base58 to buffer using bs58
					newBuffer = Buffer.from(bs58.decode(data));
				} else {
					newBuffer = Buffer.from(data, 'base64');
				}
			}
		}

		const accountIdString = accountId.toString();
		const existingBufferAndSlot = this.bufferAndSlotMap.get(accountIdString);

		// Track WebSocket notification time for this account
		this.lastWsNotificationTime.set(accountIdString, Date.now());

		// If this account was being polled, stop polling it if the buffer has changed
		if (
			this.accountsCurrentlyPolling.has(accountIdString) &&
			!existingBufferAndSlot?.buffer.equals(newBuffer)
		) {
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
				this.updateBufferAndHandleChange(newBuffer, newSlot, accountIdString);
			}
			return;
		}

		if (newSlot < existingBufferAndSlot.slot) {
			return;
		}

		const oldBuffer = existingBufferAndSlot.buffer;
		if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
			this.updateBufferAndHandleChange(newBuffer, newSlot, accountIdString);
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
				this.lastWsNotificationTime.get(accountIdString) || 0;
			const currentTime = Date.now();

			if (
				!lastNotificationTime ||
				currentTime - lastNotificationTime >= this.pollingIntervalMs
			) {
				if (this.resubOpts?.logResubMessages) {
					console.debug(
						`[${this.subscriptionName}] No recent WS notification for ${accountIdString}, adding to polling set`
					);
				}
				// No recent WS notification: add to polling and schedule debounced poll
				this.accountsCurrentlyPolling.add(accountIdString);
				this.scheduleDebouncedImmediatePoll();
			} else {
				// We received a WS notification recently, continue monitoring
				this.startMonitoringForAccount(accountIdString);
			}
		}, this.pollingIntervalMs);

		this.pollingTimeouts.set(accountIdString, timeoutId);
	}

	private scheduleDebouncedImmediatePoll(): void {
		if (this.debouncedImmediatePollTimeout) {
			clearTimeout(this.debouncedImmediatePollTimeout);
		}
		this.debouncedImmediatePollTimeout = setTimeout(async () => {
			try {
				await this.pollAllAccounts();
				// After the immediate poll, ensure continuous batch polling is active
				if (
					!this.batchPollingTimeout &&
					this.accountsCurrentlyPolling.size > 0
				) {
					this.startBatchPolling();
				}
			} catch (e) {
				if (this.resubOpts?.logResubMessages) {
					console.log(
						`[${this.subscriptionName}] Error during debounced immediate poll:`,
						e
					);
				}
			}
		}, this.debouncedImmediatePollMs);
	}

	private startBatchPolling(): void {
		if (this.resubOpts?.logResubMessages) {
			console.debug(`[${this.subscriptionName}] Scheduling batch polling`);
		}
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

			if (this.resubOpts?.logResubMessages) {
				console.debug(
					`[${this.subscriptionName}] Polling all accounts`,
					accountsToPoll.length,
					'accounts'
				);
			}

			// Use the shared batch fetch method
			await this.fetchAccountsBatch(accountsToPoll);
		} catch (error) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.subscriptionName}] Error batch polling accounts:`,
					error
				);
			}
		}
	}

	/**
	 * Fetches and populates all monitored accounts data without checking for missed changes
	 * This is used during initial subscription to populate data
	 */
	private async fetchAndPopulateAllMonitoredAccounts(): Promise<void> {
		try {
			// Get all accounts currently being polled
			const accountsToMonitor = Array.from(this.accountsToMonitor);
			if (accountsToMonitor.length === 0) {
				return;
			}

			// Fetch all accounts in a single batch request
			const accountAddresses = accountsToMonitor.map(
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
			for (let i = 0; i < accountsToMonitor.length; i++) {
				const accountIdString = accountsToMonitor[i];
				const accountInfo = rpcResponse.value[i];

				if (!accountInfo) {
					continue;
				}

				const existingBufferAndSlot =
					this.bufferAndSlotMap.get(accountIdString);

				if (!existingBufferAndSlot) {
					// Account not in our map yet, add it
					let newBuffer: Buffer | undefined = undefined;
					if (accountInfo) {
						if (Array.isArray(accountInfo.data)) {
							const [data, encoding] = accountInfo.data;
							newBuffer = Buffer.from(data, encoding);
						}
					}

					if (newBuffer) {
						this.updateBufferAndHandleChange(
							newBuffer,
							currentSlot,
							accountIdString
						);
					}
					continue;
				}

				// For initial population, just update the slot if we have newer data
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

					// Update with newer data if available
					if (newBuffer) {
						this.updateBufferAndHandleChange(
							newBuffer,
							currentSlot,
							accountIdString
						);
					}
				}
			}
		} catch (error) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.subscriptionName}] Error fetching and populating monitored accounts:`,
					error
				);
			}
		}
	}

	/**
	 * Fetches all monitored accounts and checks for missed changes
	 * Returns true if a missed change was detected and resubscription is needed
	 */
	private async fetchAllMonitoredAccounts(): Promise<boolean> {
		try {
			// Get all accounts currently being polled
			const accountsToMonitor = Array.from(this.accountsToMonitor);
			if (accountsToMonitor.length === 0) {
				return false;
			}

			// Fetch all accounts in a single batch request
			const accountAddresses = accountsToMonitor.map(
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
			for (let i = 0; i < accountsToMonitor.length; i++) {
				const accountIdString = accountsToMonitor[i];
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
						this.updateBufferAndHandleChange(
							newBuffer,
							currentSlot,
							accountIdString
						);
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
						// We missed an update, return true to indicate resubscription is needed
						return true;
					}
				}
			}

			// No missed changes detected
			return false;
		} catch (error) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.subscriptionName}] Error batch polling accounts:`,
					error
				);
			}
			return false;
		}
	}

	private async fetchAccountsBatch(accountIds: string[]): Promise<void> {
		try {
			// Chunk account IDs into groups of 100 (getMultipleAccounts limit)
			const chunkSize = 100;
			const chunks: string[][] = [];
			for (let i = 0; i < accountIds.length; i += chunkSize) {
				chunks.push(accountIds.slice(i, i + chunkSize));
			}

			// Process all chunks concurrently
			await Promise.all(
				chunks.map(async (chunk) => {
					const accountAddresses = chunk.map(
						(accountId) => accountId as Address
					);
					const rpcResponse = await this.rpc
						.getMultipleAccounts(accountAddresses, {
							commitment: this.options.commitment as GillCommitment,
							encoding: 'base64',
						})
						.send();

					const currentSlot = Number(rpcResponse.context.slot);

					// Process each account response in this chunk
					for (let i = 0; i < chunk.length; i++) {
						const accountIdString = chunk[i];
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
								this.updateBufferAndHandleChange(
									newBuffer,
									currentSlot,
									accountIdString
								);
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
										`[${this.subscriptionName}] Batch polling detected missed update for account ${accountIdString}, signaling resubscription`
									);
								}
								// Signal missed change instead of immediately resubscribing
								this.signalMissedChange(accountIdString);
								return;
							}
						}
					}
				})
			);
		} catch (error) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.subscriptionName}] Error fetching accounts batch:`,
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

		// Clear initial fetch timeout
		// if (this.initialFetchTimeout) {
		// 	clearTimeout(this.initialFetchTimeout);
		// 	this.initialFetchTimeout = undefined;
		// }

		// Clear resubscription timeout
		if (this.resubscriptionTimeout) {
			clearTimeout(this.resubscriptionTimeout);
			this.resubscriptionTimeout = undefined;
		}

		// Clear accounts currently polling
		this.accountsCurrentlyPolling.clear();

		// Clear accounts pending initial monitor fetch
		// this.accountsPendingInitialMonitorFetch.clear();

		// Reset missed change flag and clear accounts with missed updates
		this.missedChangeDetected = false;
		this.accountsWithMissedUpdates.clear();
	}

	/**
	 * Centralized resubscription handler that only resubscribes once after checking all accounts
	 */
	private async handleResubscription(): Promise<void> {
		if (this.missedChangeDetected) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.subscriptionName}] Missed change detected for ${
						this.accountsWithMissedUpdates.size
					} accounts: ${Array.from(this.accountsWithMissedUpdates).join(
						', '
					)}, resubscribing`
				);
			}
			await this.unsubscribe(true);
			this.receivingData = false;
			await this.subscribe(this.onChange);
			this.missedChangeDetected = false;
			this.accountsWithMissedUpdates.clear();
		}
	}

	/**
	 * Signal that a missed change was detected and schedule resubscription
	 */
	private signalMissedChange(accountIdString: string): void {
		if (!this.missedChangeDetected) {
			this.missedChangeDetected = true;
			this.accountsWithMissedUpdates.add(accountIdString);

			// Clear any existing resubscription timeout
			if (this.resubscriptionTimeout) {
				clearTimeout(this.resubscriptionTimeout);
			}

			// Schedule resubscription after a short delay to allow for batch processing
			this.resubscriptionTimeout = setTimeout(async () => {
				await this.handleResubscription();
			}, 100); // 100ms delay to allow for batch processing
		} else {
			// If already detected, just add the account to the set
			this.accountsWithMissedUpdates.add(accountIdString);
		}
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
	/**
	 * Add an account to the monitored set.
	 * - Monitored accounts are subject to initial fetch and periodic batch polls
	 *   if WS notifications are not observed within `pollingIntervalMs`.
	 */
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
	/**
	 * Set the monitoring/polling interval for monitored accounts.
	 * Shorter intervals detect missed updates sooner but increase RPC load.
	 */
	setPollingInterval(intervalMs: number): void {
		this.pollingIntervalMs = intervalMs;
		// Restart monitoring with new interval if already subscribed
		if (this.listenerId != null && !this.isUnsubscribing) {
			this.startMonitoringForAccounts();
		}
	}

	private updateBufferAndHandleChange(
		newBuffer: Buffer,
		newSlot: number,
		accountIdString: string
	) {
		this.bufferAndSlotMap.set(accountIdString, {
			buffer: newBuffer,
			slot: newSlot,
		});
		const account = this.decodeBuffer(this.accountDiscriminator, newBuffer);
		const accountIdPubkey = new PublicKey(accountIdString);
		this.onChange(accountIdPubkey, account, { slot: newSlot }, newBuffer);
	}
}
