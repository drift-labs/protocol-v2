import {
	DevnetPerpMarkets,
	DriftClient,
	DriftEnv,
	getUserAccountPublicKey,
	getUserStatsAccountPublicKey,
	MainnetPerpMarkets,
	MarketType,
	OptionalOrderParams,
	PostOnlyParams,
	SignedMsgOrderParamsDelegateMessage,
	SignedMsgOrderParamsMessage,
	UserAccount,
} from '..';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { decodeUTF8 } from 'tweetnacl-util';
import WebSocket from 'ws';
import { sha256 } from '@noble/hashes/sha256';

// In practice, this for now is just an OrderSubscriber or a UserMap
export interface AccountGetter {
	mustGetUserAccount(publicKey: string): Promise<UserAccount>;
}

export type SwiftOrderSubscriberConfig = {
	driftClient: DriftClient;
	userAccountGetter?: AccountGetter;
	driftEnv: DriftEnv;
	endpoint?: string;
	marketIndexes: number[];
	/**
		In the future, this will be used for verifying $DRIFT stake as we add
		authentication for delegate signers
		For now, pass a new keypair or a keypair to an empty wallet
	*/
	keypair: Keypair;
};

export class SwiftOrderSubscriber {
	private heartbeatTimeout: NodeJS.Timeout | null = null;
	private readonly heartbeatIntervalMs = 60000;
	private ws: WebSocket | null = null;
	private driftClient: DriftClient;
	public userAccountGetter?: AccountGetter; // In practice, this for now is just an OrderSubscriber or a UserMap
	public onOrder: (
		orderMessageRaw: any,
		signedMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		isDelegateSigner?: boolean
	) => Promise<void>;

	subscribed = false;

	constructor(private config: SwiftOrderSubscriberConfig) {
		this.driftClient = config.driftClient;
		this.userAccountGetter = config.userAccountGetter;
	}

	getSymbolForMarketIndex(marketIndex: number): string {
		const markets =
			this.config.driftEnv === 'devnet'
				? DevnetPerpMarkets
				: MainnetPerpMarkets;
		return markets[marketIndex].symbol;
	}

	generateChallengeResponse(nonce: string): string {
		const messageBytes = decodeUTF8(nonce);
		const signature = nacl.sign.detached(
			messageBytes,
			this.config.keypair.secretKey
		);
		const signatureBase64 = Buffer.from(signature).toString('base64');
		return signatureBase64;
	}

	handleAuthMessage(message: any): void {
		if (message['channel'] === 'auth' && message['nonce'] != null) {
			const signatureBase64 = this.generateChallengeResponse(message['nonce']);
			this.ws?.send(
				JSON.stringify({
					pubkey: this.config.keypair.publicKey.toBase58(),
					signature: signatureBase64,
				})
			);
		}

		if (
			message['channel'] === 'auth' &&
			message['message']?.toLowerCase() === 'authenticated'
		) {
			this.subscribed = true;
			this.config.marketIndexes.forEach(async (marketIndex) => {
				this.ws?.send(
					JSON.stringify({
						action: 'subscribe',
						market_type: 'perp',
						market_name: this.getSymbolForMarketIndex(marketIndex),
					})
				);
				await new Promise((resolve) => setTimeout(resolve, 100));
			});
		}
	}

	async subscribe(
		onOrder: (
			orderMessageRaw: any,
			signedMessage:
				| SignedMsgOrderParamsMessage
				| SignedMsgOrderParamsDelegateMessage,
			isDelegateSigner?: boolean
		) => Promise<void>
	): Promise<void> {
		this.onOrder = onOrder;

		const endpoint =
			this.config.endpoint || this.config.driftEnv === 'devnet'
				? 'wss://master.swift.drift.trade/ws'
				: 'wss://swift.drift.trade/ws';
		const ws = new WebSocket(
			endpoint + '?pubkey=' + this.config.keypair.publicKey.toBase58()
		);
		this.ws = ws;
		ws.on('open', async () => {
			console.log('Connected to the server');

			ws.on('message', async (data: WebSocket.Data) => {
				const message = JSON.parse(data.toString());
				this.startHeartbeatTimer();

				if (message['channel'] === 'auth') {
					this.handleAuthMessage(message);
				}

				if (message['order']) {
					const order = message['order'];
					const signedMsgOrderParamsBuf = Buffer.from(
						order['order_message'],
						'hex'
					);
					const isDelegateSigner = signedMsgOrderParamsBuf
						.slice(0, 8)
						.equals(
							Uint8Array.from(
								Buffer.from(
									sha256('global' + ':' + 'SignedMsgOrderParamsDelegateMessage')
								).slice(0, 8)
							)
						);
					const signedMessage:
						| SignedMsgOrderParamsMessage
						| SignedMsgOrderParamsDelegateMessage =
						this.driftClient.decodeSignedMsgOrderParamsMessage(
							signedMsgOrderParamsBuf,
							isDelegateSigner
						);

					if (!signedMessage.signedMsgOrderParams.price) {
						console.error(
							`order has no price: ${JSON.stringify(
								signedMessage.signedMsgOrderParams
							)}`
						);
						return;
					}

					onOrder(order, signedMessage, isDelegateSigner);
				}
			});

			ws.on('close', () => {
				console.log('Disconnected from the server');
				this.reconnect();
			});

			ws.on('error', (error: Error) => {
				console.error('WebSocket error:', error);
				this.reconnect();
			});
		});

		ws.on('unexpected-response', async (request, response) => {
			console.error(
				'Unexpected response, reconnecting in 5s:',
				response.statusCode
			);
			setTimeout(() => {
				if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
				this.reconnect();
			}, 5000);
		});

		ws.on('error', async (request, response) => {
			console.error(
				'WS closed from error, reconnecting in 1s:',
				response.statusCode
			);
			setTimeout(() => {
				if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
				this.reconnect();
			}, 1000);
		});
	}

	async getPlaceAndMakeSignedMsgOrderIxs(
		orderMessageRaw: any,
		signedMsgOrderParamsMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		makerOrderParams: OptionalOrderParams
	): Promise<TransactionInstruction[]> {
		if (!this.userAccountGetter) {
			throw new Error('userAccountGetter must be set to use this function');
		}

		const signedMsgOrderParamsBuf = Buffer.from(
			orderMessageRaw['order_message'],
			'hex'
		);

		const isDelegateSigner = signedMsgOrderParamsBuf
			.slice(0, 8)
			.equals(
				Uint8Array.from(
					Buffer.from(
						sha256('global' + ':' + 'SignedMsgOrderParamsDelegateMessage')
					).slice(0, 8)
				)
			);
		const signedMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage =
			this.driftClient.decodeSignedMsgOrderParamsMessage(
				signedMsgOrderParamsBuf,
				isDelegateSigner
			);

		const takerAuthority = new PublicKey(orderMessageRaw['taker_authority']);
		const signingAuthority = new PublicKey(
			orderMessageRaw['signing_authority']
		);
		const takerUserPubkey = isDelegateSigner
			? (signedMessage as SignedMsgOrderParamsDelegateMessage).takerPubkey
			: await getUserAccountPublicKey(
					this.driftClient.program.programId,
					takerAuthority,
					(signedMessage as SignedMsgOrderParamsMessage).subAccountId
			  );
		const takerUserAccount = await this.userAccountGetter.mustGetUserAccount(
			takerUserPubkey.toString()
		);
		const ixs = await this.driftClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
			{
				orderParams: signedMsgOrderParamsBuf,
				signature: Buffer.from(orderMessageRaw['order_signature'], 'base64'),
			},
			decodeUTF8(orderMessageRaw['uuid']),
			{
				taker: takerUserPubkey,
				takerUserAccount,
				takerStats: getUserStatsAccountPublicKey(
					this.driftClient.program.programId,
					takerUserAccount.authority
				),
				signingAuthority: signingAuthority,
			},
			Object.assign({}, makerOrderParams, {
				postOnly: PostOnlyParams.MUST_POST_ONLY,
				immediateOrCancel: true,
				marketType: MarketType.PERP,
			})
		);
		return ixs;
	}

	private startHeartbeatTimer() {
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
		}
		if (!this.onOrder) {
			throw new Error('onOrder callback function must be set');
		}
		this.heartbeatTimeout = setTimeout(() => {
			console.warn('No heartbeat received within 30 seconds, reconnecting...');
			this.reconnect();
		}, this.heartbeatIntervalMs);
	}

	private reconnect() {
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.terminate();
		}

		console.log('Reconnecting to WebSocket...');
		setTimeout(() => {
			this.subscribe(this.onOrder);
		}, 1000);
	}
}
