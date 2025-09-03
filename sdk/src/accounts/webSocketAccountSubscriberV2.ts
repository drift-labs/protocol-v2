import {
	DataAndSlot,
	AccountSubscriber,
	ResubOpts,
	BufferAndSlot,
} from './types';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { capitalize } from './utils';
import {
	AccountInfoBase,
	AccountInfoWithBase64EncodedData,
	AccountInfoWithBase58EncodedData,
	createSolanaClient,
	isAddress,
	Rpc,
	RpcSubscriptions,
	SolanaRpcSubscriptionsApi,
	Address,
	Commitment,
} from 'gill';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * WebSocketAccountSubscriberV2
 *
 * High-level overview
 * - WebSocket-first subscriber for a single Solana account with optional
 *   polling safeguards when the WS feed goes quiet.
 * - Emits decoded updates via `onChange` and maintains the latest
 *   `{buffer, slot}` and decoded `{data, slot}` internally.
 *
 * Why polling if this is a WebSocket subscriber?
 * - Under real-world conditions, WS notifications can stall or get dropped.
 * - When `resubOpts.resubTimeoutMs` elapses without WS data, you can either:
 *   - resubscribe to the WS stream (default), or
 *   - enable `resubOpts.usePollingInsteadOfResub` to start polling this single
 *     account via RPC to check for missed changes.
 * - Polling compares the fetched buffer to the last known buffer. If different
 *   at an equal-or-later slot, it indicates a missed update and we resubscribe
 *   to WS to restore a clean stream.
 *
 * Initial fetch (on subscribe)
 * - On `subscribe()`, we do a one-time RPC `fetch()` to seed internal state and
 *   emit the latest account state, ensuring consumers start from ground truth
 *   even before WS events arrive.
 *
 * Continuous polling (opt-in)
 * - If `usePollingInsteadOfResub` is set, the inactivity timeout triggers a
 *   polling loop that periodically `fetch()`es the account and checks for
 *   changes. On change, polling stops and we resubscribe to WS.
 * - If not set (default), the inactivity timeout immediately triggers a WS
 *   resubscription (no polling loop).
 *
 * Account focus
 * - This class tracks exactly one account — the one passed to the constructor —
 *   which is by definition the account the consumer cares about. The extra
 *   logic is narrowly scoped to this account to minimize overhead.
 *
 * Tuning knobs
 * - `resubOpts.resubTimeoutMs`: WS inactivity threshold before fallback.
 * - `resubOpts.usePollingInsteadOfResub`: toggle polling vs immediate resub.
 * - `resubOpts.pollingIntervalMs`: polling cadence (default 30s).
 * - `resubOpts.logResubMessages`: verbose logs for diagnostics.
 * - `commitment`: WS/RPC commitment used for reads and notifications.
 * - `decodeBufferFn`: optional custom decode; defaults to Anchor coder.
 *
 * Implementation notes
 * - Uses `gill` for both WS (`rpcSubscriptions`) and RPC (`rpc`) to match the
 *   program provider’s RPC endpoint. Handles base58/base64 encoded data.
 */
export class WebSocketAccountSubscriberV2<T> implements AccountSubscriber<T> {
	dataAndSlot?: DataAndSlot<T>;
	bufferAndSlot?: BufferAndSlot;
	accountName: string;
	logAccountName: string;
	program: Program;
	accountPublicKey: PublicKey;
	decodeBufferFn: (buffer: Buffer) => T;
	onChange: (data: T) => void;
	listenerId?: number;

	resubOpts: ResubOpts;

	commitment?: Commitment;
	isUnsubscribing = false;

	timeoutId?: ReturnType<typeof setTimeout>;
	pollingTimeoutId?: ReturnType<typeof setTimeout>;

	receivingData: boolean;

	// Gill client components
	private rpc: ReturnType<typeof createSolanaClient>['rpc'];
	private rpcSubscriptions: ReturnType<
		typeof createSolanaClient
	>['rpcSubscriptions'];
	private abortController?: AbortController;

	/**
	 * Create a single-account WebSocket subscriber with optional polling fallback.
	 *
	 * @param accountName Name of the Anchor account type (used for default decode).
	 * @param program Anchor `Program` used for decoding and provider access.
	 * @param accountPublicKey Public key of the account to track.
	 * @param decodeBuffer Optional custom decode function; if omitted, uses
	 *   program coder to decode `accountName`.
	 * @param resubOpts Resubscription/polling options. See class docs.
	 * @param commitment Commitment for WS and RPC operations.
	 * @param rpcSubscriptions Optional override/injection for testing.
	 * @param rpc Optional override/injection for testing.
	 */
	public constructor(
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => T,
		resubOpts?: ResubOpts,
		commitment?: Commitment,
		rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi> & string,
		rpc?: Rpc<any>
	) {
		this.accountName = accountName;
		this.logAccountName = `${accountName}-${accountPublicKey.toBase58()}-ws-acct-subscriber-v2`;
		this.program = program;
		this.accountPublicKey = accountPublicKey;
		this.decodeBufferFn = decodeBuffer;
		this.resubOpts = resubOpts ?? {
			resubTimeoutMs: 30000,
			usePollingInsteadOfResub: true,
			logResubMessages: false,
		};
		if (this.resubOpts.resubTimeoutMs < 1000) {
			console.log(
				`resubTimeoutMs should be at least 1000ms to avoid spamming resub ${this.logAccountName}`
			);
		}
		this.receivingData = false;
		if (
			['recent', 'single', 'singleGossip', 'root', 'max'].includes(
				(this.program.provider as AnchorProvider).opts.commitment
			)
		) {
			console.warn(
				`using commitment ${
					(this.program.provider as AnchorProvider).opts.commitment
				} that is not supported by gill, this may cause issues`
			);
		}
		this.commitment =
			commitment ??
			((this.program.provider as AnchorProvider).opts.commitment as Commitment);

		// Initialize gill client using the same RPC URL as the program provider

		this.rpc = rpc
			? rpc
			: (() => {
					const rpcUrl = (this.program.provider as AnchorProvider).connection
						.rpcEndpoint;
					const { rpc } = createSolanaClient({
						urlOrMoniker: rpcUrl,
					});
					return rpc;
			  })();
		this.rpcSubscriptions = rpcSubscriptions
			? rpcSubscriptions
			: (() => {
					const rpcUrl = (this.program.provider as AnchorProvider).connection
						.rpcEndpoint;
					const { rpcSubscriptions } = createSolanaClient({
						urlOrMoniker: rpcUrl,
					});
					return rpcSubscriptions;
			  })();
	}

	private async handleNotificationLoop(
		subscriptionPromise: Promise<AsyncIterable<any>>
	) {
		const subscription = await subscriptionPromise;
		for await (const notification of subscription) {
			// If we're currently polling and receive a WebSocket event, stop polling
			if (this.pollingTimeoutId) {
				if (this.resubOpts.logResubMessages) {
					console.log(
						`[${this.logAccountName}] Received WebSocket event while polling, stopping polling`
					);
				}
				this.stopPolling();
			}

			this.receivingData = true;
			clearTimeout(this.timeoutId);
			this.handleRpcResponse(notification.context, notification.value);
			this.setTimeout();
		}
	}

	async subscribe(onChange: (data: T) => void): Promise<void> {
		/**
		 * Start the WebSocket subscription and (optionally) setup inactivity
		 * fallback.
		 *
		 * Flow
		 * - If we do not have initial state, perform a one-time `fetch()` to seed
		 *   internal buffers and emit current data.
		 * - Subscribe to account notifications via WS.
		 * - If `resubOpts.resubTimeoutMs` is set, schedule an inactivity timeout.
		 *   When it fires:
		 *   - if `usePollingInsteadOfResub` is true, start polling loop;
		 *   - otherwise, resubscribe to WS immediately.
		 */
		if (this.listenerId != null || this.isUnsubscribing) {
			if (this.resubOpts.logResubMessages) {
				console.log(
					`[${this.logAccountName}] Subscribe returning early - listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
				);
			}
			return;
		}

		this.onChange = onChange;
		if (!this.dataAndSlot) {
			await this.fetch();
		}

		// Create abort controller for proper cleanup
		const abortController = new AbortController();
		this.abortController = abortController;

		this.listenerId = Math.random(); // Unique ID for logging purposes

		if (this.resubOpts.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}

		// Subscribe to account changes using gill's rpcSubscriptions
		const pubkey = this.accountPublicKey.toBase58();
		if (isAddress(pubkey)) {
			const subscriptionPromise = this.rpcSubscriptions
				.accountNotifications(pubkey, {
					commitment: this.commitment,
					encoding: 'base64',
				})
				.subscribe({
					abortSignal: abortController.signal,
				});

			// Start notification loop with the subscription promise
			this.handleNotificationLoop(subscriptionPromise);
		} else {
			throw new Error('Invalid account public key');
		}
	}

	setData(data: T, slot?: number): void {
		const newSlot = slot || 0;
		if (this.dataAndSlot && this.dataAndSlot.slot > newSlot) {
			return;
		}

		this.dataAndSlot = {
			data,
			slot,
		};
	}

	protected setTimeout(): void {
		/**
		 * Schedule inactivity handling. If WS is quiet for
		 * `resubOpts.resubTimeoutMs` and `receivingData` is true, trigger either
		 * a polling loop or a resubscribe depending on options.
		 */
		if (!this.onChange) {
			throw new Error('onChange callback function must be set');
		}
		this.timeoutId = setTimeout(async () => {
			if (this.isUnsubscribing) {
				// If we are in the process of unsubscribing, do not attempt to resubscribe
				if (this.resubOpts.logResubMessages) {
					console.log(
						`[${this.logAccountName}] Timeout fired but isUnsubscribing=true, skipping resubscribe`
					);
				}
				return;
			}

			if (this.receivingData) {
				if (this.resubOpts.usePollingInsteadOfResub) {
					// Use polling instead of resubscribing
					if (this.resubOpts.logResubMessages) {
						console.log(
							`[${this.logAccountName}] No ws data in ${this.resubOpts.resubTimeoutMs}ms, starting polling - listenerId=${this.listenerId}`
						);
					}
					this.startPolling();
				} else {
					// Original resubscribe behavior
					if (this.resubOpts.logResubMessages) {
						console.log(
							`No ws data from ${this.logAccountName} in ${this.resubOpts.resubTimeoutMs}ms, resubscribing - listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
						);
					}
					await this.unsubscribe(true);
					this.receivingData = false;
					await this.subscribe(this.onChange);
					if (this.resubOpts.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Resubscribe completed - receivingData=${this.receivingData}, listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
						);
					}
				}
			} else {
				if (this.resubOpts.logResubMessages) {
					console.log(
						`[${this.logAccountName}] Timeout fired but receivingData=false, skipping resubscribe`
					);
				}
			}
		}, this.resubOpts.resubTimeoutMs);
	}

	/**
	 * Start the polling loop (single-account).
	 * - Periodically calls `fetch()` and compares buffers to detect changes.
	 * - On detected change, stops polling and resubscribes to WS.
	 */
	private startPolling(): void {
		const pollingInterval = this.resubOpts.pollingIntervalMs || 30000; // Default to 30s

		const poll = async () => {
			if (this.isUnsubscribing) {
				return;
			}

			try {
				// Store current data and buffer before polling
				const currentBuffer = this.bufferAndSlot?.buffer;

				// Fetch latest account data
				await this.fetch();

				// Check if we got new data by comparing buffers
				const newBuffer = this.bufferAndSlot?.buffer;
				const hasNewData =
					newBuffer && (!currentBuffer || !newBuffer.equals(currentBuffer));

				if (hasNewData) {
					// New data received, stop polling and resubscribe to websocket
					if (this.resubOpts.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Polling detected account data change, resubscribing to websocket`
						);
					}
					await this.unsubscribe(true);
					this.receivingData = false;
					await this.subscribe(this.onChange);
				} else {
					// No new data, continue polling
					if (this.resubOpts.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Polling found no account changes, continuing to poll every ${pollingInterval}ms`
						);
					}
					this.pollingTimeoutId = setTimeout(poll, pollingInterval);
				}
			} catch (error) {
				if (this.resubOpts.logResubMessages) {
					console.error(
						`[${this.logAccountName}] Error during polling:`,
						error
					);
				}
				// On error, continue polling
				this.pollingTimeoutId = setTimeout(poll, pollingInterval);
			}
		};

		// Start polling immediately
		poll();
	}

	private stopPolling(): void {
		if (this.pollingTimeoutId) {
			clearTimeout(this.pollingTimeoutId);
			this.pollingTimeoutId = undefined;
		}
	}

	/**
	 * Fetch the current account state via RPC and process it through the same
	 * decoding and update pathway as WS notifications.
	 */
	async fetch(): Promise<void> {
		// Use gill's rpc for fetching account info
		const accountAddress = this.accountPublicKey.toBase58() as Address;
		const rpcResponse = await this.rpc
			.getAccountInfo(accountAddress, {
				commitment: this.commitment,
				encoding: 'base64',
			})
			.send();

		// Convert gill response to match the expected format
		const context = {
			slot: Number(rpcResponse.context.slot),
		};

		const accountInfo = rpcResponse.value;

		this.handleRpcResponse({ slot: BigInt(context.slot) }, accountInfo);
	}

	handleRpcResponse(
		context: { slot: bigint },
		accountInfo?: AccountInfoBase &
			(AccountInfoWithBase58EncodedData | AccountInfoWithBase64EncodedData)
	): void {
		const newSlot = context.slot;
		let newBuffer: Buffer | undefined = undefined;

		if (accountInfo) {
			// Extract data from gill response
			if (accountInfo.data) {
				// Handle different data formats from gill
				if (Array.isArray(accountInfo.data)) {
					// If it's a tuple [data, encoding]
					const [data, encoding] = accountInfo.data;

					if (encoding === 'base58') {
						// we know encoding will be base58
						// Convert base58 to buffer using bs58
						newBuffer = Buffer.from(bs58.decode(data));
					} else {
						newBuffer = Buffer.from(data, 'base64');
					}
				}
			}
		}

		if (!this.bufferAndSlot) {
			this.bufferAndSlot = {
				buffer: newBuffer,
				slot: Number(newSlot),
			};
			if (newBuffer) {
				const account = this.decodeBuffer(newBuffer);
				this.dataAndSlot = {
					data: account,
					slot: Number(newSlot),
				};
				this.onChange(account);
			}
			return;
		}

		if (Number(newSlot) < this.bufferAndSlot.slot) {
			return;
		}

		const oldBuffer = this.bufferAndSlot.buffer;
		if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
			this.bufferAndSlot = {
				buffer: newBuffer,
				slot: Number(newSlot),
			};
			const account = this.decodeBuffer(newBuffer);
			this.dataAndSlot = {
				data: account,
				slot: Number(newSlot),
			};
			this.onChange(account);
		}
	}

	decodeBuffer(buffer: Buffer): T {
		if (this.decodeBufferFn) {
			return this.decodeBufferFn(buffer);
		} else {
			return this.program.account[this.accountName].coder.accounts.decode(
				capitalize(this.accountName),
				buffer
			);
		}
	}

	unsubscribe(onResub = false): Promise<void> {
		/**
		 * Stop timers, polling, and WS subscription.
		 * - When called during a resubscribe (`onResub=true`), we preserve
		 *   `resubOpts.resubTimeoutMs` for the restarted subscription.
		 */
		if (!onResub && this.resubOpts) {
			this.resubOpts.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		// Stop polling if active
		this.stopPolling();

		// Abort the WebSocket subscription
		if (this.abortController) {
			this.abortController.abort('unsubscribing');
			this.abortController = undefined;
		}

		this.listenerId = undefined;
		this.isUnsubscribing = false;

		return Promise.resolve();
	}
}
