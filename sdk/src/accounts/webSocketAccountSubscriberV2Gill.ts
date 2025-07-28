import { DataAndSlot, AccountSubscriber, ResubOpts } from './types';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { capitalize } from './utils';
import {
	AccountInfoBase,
	AccountInfoWithBase58EncodedData,
	createSolanaClient,
	isAddress,
	type Address,
	type Commitment,
} from 'gill';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export class WebSocketAccountSubscriberV2Gill<T>
	implements AccountSubscriber<T>
{
	dataAndSlot?: DataAndSlot<T>;
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

	public constructor(
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => T,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.accountName = accountName;
		this.logAccountName = `${accountName}-${accountPublicKey.toBase58()}`;
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

		// Subscribe to account changes using gill's rpcSubscriptions
		const pubkey = this.accountPublicKey.toBase58();
		if (isAddress(pubkey)) {
			const subscription = await this.rpcSubscriptions
				.accountNotifications(pubkey, {
					commitment: this.commitment,
					encoding: 'base58',
				})
				.subscribe({
					abortSignal: new AbortController().signal,
				});

			for await (const notification of subscription) {
				this.handleRpcResponse(notification.context, notification.value);
			}
		}

		this.listenerId = Math.random(); // Unique ID for tracking subscription

		// Set up polling for account changes
		const pollInterval = setInterval(async () => {
			if (this.isUnsubscribing) {
				clearInterval(pollInterval);
				return;
			}

			try {
				await this.fetch();
			} catch (error) {
				console.error(`[${this.logAccountName}] Polling error:`, error);
			}
		}, 1000); // Poll every second

		if (this.resubOpts?.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
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
				encoding: 'base58',
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
		accountInfo?: AccountInfoBase & AccountInfoWithBase58EncodedData
	): void {
		const newSlot = context.slot;

		if (!accountInfo) {
			return;
		}

		// Extract data from gill response
		let buffer: Buffer | undefined;
		if (accountInfo.data) {
			// Handle different data formats from gill
			if (typeof accountInfo.data === 'string') {
				// If it's a base64 string
				buffer = Buffer.from(accountInfo.data, 'base64');
			} else if (Array.isArray(accountInfo.data)) {
				// If it's a tuple [data, encoding]
				const [data] = accountInfo.data;

				// we know encoding will be base58
				// Convert base58 to buffer using bs58
				buffer = Buffer.from(bs58.decode(data));
			}
		}

		if (buffer) {
			const account = this.decodeBuffer(buffer);
			this.dataAndSlot = {
				data: account,
				slot: Number(newSlot),
			};
			this.onChange(account);
		}
	}

	// Helper method to convert base58 to base64
	private base58ToBase64(base58String: string): string {
		try {
			// Decode base58 to buffer then encode to base64
			const buffer = new Buffer(bs58.decode(base58String));
			return buffer.toString('base64');
		} catch (error) {
			console.error(
				`[${this.logAccountName}] Base58 conversion failed:`,
				error
			);
			throw error;
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

		if (this.listenerId != null) {
			// For gill subscriptions, we need to handle cleanup differently
			// Since we don't have a direct unsubscribe method, we'll just mark as unsubscribed
			const promise = Promise.resolve()
				.then(() => {
					this.listenerId = undefined;
					this.isUnsubscribing = false;
				})
				.catch((error) => {
					console.error(
						`[${this.logAccountName}] Unsubscribe failed, forcing cleanup - listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`,
						error
					);
					this.listenerId = undefined;
					this.isUnsubscribing = false;
				});
			return promise;
		} else {
			this.isUnsubscribing = false;
		}
	}
}
