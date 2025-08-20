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
	AccountInfoWithBase58EncodedData,
	AccountInfoWithBase64EncodedData,
	createSolanaClient,
	isAddress,
	type Address,
	type Commitment,
} from 'gill';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

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

	resubOpts?: ResubOpts;

	commitment?: Commitment;
	isUnsubscribing = false;

	timeoutId?: ReturnType<typeof setTimeout>;

	receivingData: boolean;

	// Gill client components
	private rpc: ReturnType<typeof createSolanaClient>['rpc'];
	private rpcSubscriptions: ReturnType<
		typeof createSolanaClient
	>['rpcSubscriptions'];
	private abortController?: AbortController;

	public constructor(
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => T,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.accountName = accountName;
		this.logAccountName = `${accountName}-${accountPublicKey.toBase58()}-ws-acct-subscriber-v2`;
		this.program = program;
		this.accountPublicKey = accountPublicKey;
		this.decodeBufferFn = decodeBuffer;
		this.resubOpts = resubOpts;
		if (this.resubOpts?.resubTimeoutMs < 1000) {
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
		const rpcUrl = (this.program.provider as AnchorProvider).connection
			.rpcEndpoint;
		const { rpc, rpcSubscriptions } = createSolanaClient({
			urlOrMoniker: rpcUrl,
		});
		this.rpc = rpc;
		this.rpcSubscriptions = rpcSubscriptions;
	}

	private async handleNotificationLoop(subscription: AsyncIterable<any>) {
		for await (const notification of subscription) {
			if (this.resubOpts?.resubTimeoutMs) {
				this.receivingData = true;
				clearTimeout(this.timeoutId);
				this.handleRpcResponse(notification.context, notification.value);
				this.setTimeout();
			} else {
				this.handleRpcResponse(notification.context, notification.value);
			}
		}
	}

	async subscribe(onChange: (data: T) => void): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			if (this.resubOpts?.logResubMessages) {
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

		if (this.resubOpts?.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}

		// Subscribe to account changes using gill's rpcSubscriptions
		const pubkey = this.accountPublicKey.toBase58();
		if (isAddress(pubkey)) {
			const subscription = await this.rpcSubscriptions
				.accountNotifications(pubkey, {
					commitment: this.commitment,
					encoding: 'base64',
				})
				.subscribe({
					abortSignal: abortController.signal,
				});

			// Start notification loop without awaiting
			this.handleNotificationLoop(subscription);
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
		if (!this.onChange) {
			throw new Error('onChange callback function must be set');
		}
		this.timeoutId = setTimeout(
			async () => {
				if (this.isUnsubscribing) {
					// If we are in the process of unsubscribing, do not attempt to resubscribe
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Timeout fired but isUnsubscribing=true, skipping resubscribe`
						);
					}
					return;
				}

				if (this.receivingData) {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`No ws data from ${this.logAccountName} in ${this.resubOpts.resubTimeoutMs}ms, resubscribing - listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
						);
					}
					await this.unsubscribe(true);
					this.receivingData = false;
					await this.subscribe(this.onChange);
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Resubscribe completed - receivingData=${this.receivingData}, listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
						);
					}
				} else {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Timeout fired but receivingData=false, skipping resubscribe`
						);
					}
				}
			},
			this.resubOpts?.resubTimeoutMs
		);
	}

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
		if (!onResub && this.resubOpts) {
			this.resubOpts.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

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
