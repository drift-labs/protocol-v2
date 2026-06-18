import {
	DriftClient,
	getLimitOrderParams,
	getUserAccountPublicKey,
	getUserStatsAccountPublicKey,
	isVariant,
	MarketType,
	OrderParamsBitFlag,
	PositionDirection,
	PostOnlyParams,
	PriorityFeeSubscriberMap,
	PublicKey,
	SignedMsgOrderParamsDelegateMessage,
	SignedMsgOrderParamsMessage,
	UserMap,
	ZERO,
} from '@drift-labs/sdk';
import { RuntimeSpec } from 'src/metrics';
import WebSocket from 'ws';
import nacl from 'tweetnacl';
import { decodeUTF8 } from 'tweetnacl-util';
import { getWallet, simulateAndGetTxWithCUs } from '../../utils';
import {
	ComputeBudgetProgram,
	Keypair,
	TransactionInstruction,
} from '@solana/web3.js';
import { getPriorityFeeInstruction } from '../filler-common/utils';
import { sha256 } from '@noble/hashes/sha256';

export class SwiftMaker {
	interval: NodeJS.Timeout | null = null;
	private ws: WebSocket | null = null;
	private signedMsgUrl: string;
	private heartbeatTimeout: NodeJS.Timeout | null = null;
	private priorityFeeSubscriber: PriorityFeeSubscriberMap;
	private readonly heartbeatIntervalMs = 80_000;
	private isMainnet: boolean;
	private pctIntoAuction: number;
	constructor(
		private driftClient: DriftClient,
		private userMap: UserMap,
		runtimeSpec: RuntimeSpec,
		private dryRun?: boolean
	) {
		this.isMainnet = runtimeSpec.driftEnv === 'mainnet-beta';
		this.signedMsgUrl = this.isMainnet
			? 'wss://swift.drift.trade/ws'
			: 'wss://master.swift.drift.trade/ws';

		// Configure what percent into the auction to attempt the fill
		const pctEnv = process.env.SWIFT_PCT_INTO_AUCTION;
		const pct = pctEnv ? Number(pctEnv) : 0.55;
		this.pctIntoAuction = Math.max(0, Math.min(1, isNaN(pct) ? 0.55 : pct));

		const perpMarketsToWatchForFees = [0, 1, 2, 3, 4, 5].map((x) => {
			return { marketType: 'perp', marketIndex: x };
		});

		this.priorityFeeSubscriber = new PriorityFeeSubscriberMap({
			driftMarkets: perpMarketsToWatchForFees,
			driftPriorityFeeEndpoint: 'https://dlob.drift.trade',
		});
	}

	async init() {
		await this.subscribeWs();
		await this.priorityFeeSubscriber.subscribe();
	}

	async subscribeWs() {
		/**
			Make sure that WS_DELEGATE_KEY referrs to a keypair for an empty wallet, and that it has been added to 
			ws_delegates for an authority. see here:
			https://github.com/drift-labs/protocol-v2/blob/master/sdk/src/driftClient.ts#L1160-L1194
		*/
		const keypair = process.env.WS_DELEGATE_KEY
			? getWallet(process.env.WS_DELEGATE_KEY)[0]
			: new Keypair();
		const stakePrivateKey = process.env.STAKE_PRIVATE_KEY;
		let stakeKeypair: Keypair | undefined;
		if (stakePrivateKey) {
			stakeKeypair = getWallet(stakePrivateKey)[0];
		}

		const ws = new WebSocket(
			this.signedMsgUrl + '?pubkey=' + keypair.publicKey.toBase58()
		);

		ws.on('open', async () => {
			console.log('Connected to the server');
			this.startHeartbeatTimer();

			ws.on('message', async (data: WebSocket.Data) => {
				const message = JSON.parse(data.toString());
				this.startHeartbeatTimer();

				if (message['channel'] === 'auth' && message['nonce'] != null) {
					const messageBytes = decodeUTF8(message['nonce']);
					const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
					const signatureBase64 = Buffer.from(signature).toString('base64');
					console.log(stakeKeypair?.publicKey.toBase58());
					ws.send(
						JSON.stringify({
							pubkey: keypair.publicKey.toBase58(),
							signature: signatureBase64,
							stake_pubkey: stakeKeypair?.publicKey.toBase58(),
						})
					);
				}

				if (
					message['channel'] === 'auth' &&
					message['message'] === 'Authenticated'
				) {
					ws.send(
						JSON.stringify({
							action: 'subscribe',
							market_type: 'perp',
							market_name: 'SOL-PERP',
						})
					);
					ws.send(
						JSON.stringify({
							action: 'subscribe',
							market_type: 'perp',
							market_name: 'BTC-PERP',
						})
					);
					ws.send(
						JSON.stringify({
							action: 'subscribe',
							market_type: 'perp',
							market_name: 'ETH-PERP',
						})
					);
					ws.send(
						JSON.stringify({
							action: 'subscribe',
							market_type: 'perp',
							market_name: 'APT-PERP',
						})
					);
					ws.send(
						JSON.stringify({
							action: 'subscribe',
							market_type: 'perp',
							market_name: 'POL-PERP',
						})
					);
					ws.send(
						JSON.stringify({
							action: 'subscribe',
							market_type: 'perp',
							market_name: 'ARB-PERP',
						})
					);
				}

				if (message['order'] && this.driftClient.isSubscribed) {
					const order = message['order'];
					console.info(`uuid: ${order['uuid']} at ${Date.now()}`);

					const signedMsgOrderParamsBufHex = Buffer.from(
						order['order_message']
					);
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

					const signedMsgOrderParams = signedMessage.signedMsgOrderParams;

					const signingAuthority = new PublicKey(order['signing_authority']);
					const takerAuthority = new PublicKey(order['taker_authority']);
					const takerUserPubkey = isDelegateSigner
						? (signedMessage as SignedMsgOrderParamsDelegateMessage).takerPubkey
						: await getUserAccountPublicKey(
								this.driftClient.program.programId,
								takerAuthority,
								(signedMessage as SignedMsgOrderParamsMessage).subAccountId
						  );
					const takerUserAccount = (
						await this.userMap.mustGet(takerUserPubkey.toString())
					).getUserAccount();

					const isOrderLong = isVariant(signedMsgOrderParams.direction, 'long');
					if (!signedMsgOrderParams.price) {
						console.error(
							`order has no price: ${JSON.stringify(signedMsgOrderParams)}`
						);
						return;
					}
					const computeBudgetIxs: Array<TransactionInstruction> = [
						ComputeBudgetProgram.setComputeUnitLimit({
							units: 1_400_000,
						}),
					];
					computeBudgetIxs.push(
						getPriorityFeeInstruction(
							this.priorityFeeSubscriber.getPriorityFees(
								'perp',
								signedMsgOrderParams.marketIndex
							)?.medium ?? 0
						)
					);

					const timeUntilAuction =
						(signedMsgOrderParams.auctionDuration ?? 0) *
						this.pctIntoAuction *
						400;

					if (timeUntilAuction > 0) {
						setTimeout(async () => {
							// Determine whether taker used oraclePriceOffset and compute target price at pct into auction
							const isOracleOffset =
								signedMsgOrderParams.oraclePriceOffset !== null ||
								!signedMsgOrderParams.price.eq(ZERO);
							let price = this.driftClient.getOracleDataForPerpMarket(
								signedMsgOrderParams.marketIndex
							).price;
							if (signedMsgOrderParams.auctionDuration !== null) {
								const offset = signedMsgOrderParams
									.auctionEndPrice!.sub(signedMsgOrderParams.auctionStartPrice!)
									.muln(this.pctIntoAuction * 10000)
									.divn(10000);
								price = signedMsgOrderParams.auctionStartPrice!.add(offset);
							}
							const ixs =
								await this.driftClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
									{
										orderParams: signedMsgOrderParamsBufHex,
										signature: Buffer.from(order['order_signature'], 'base64'),
									},
									decodeUTF8(order['uuid']),
									{
										taker: takerUserPubkey,
										takerUserAccount,
										takerStats: getUserStatsAccountPublicKey(
											this.driftClient.program.programId,
											takerUserAccount.authority
										),
										signingAuthority,
									},
									getLimitOrderParams({
										marketType: MarketType.PERP,
										marketIndex: signedMsgOrderParams.marketIndex,
										direction: isOrderLong
											? PositionDirection.SHORT
											: PositionDirection.LONG,
										baseAssetAmount:
											signedMsgOrderParams.baseAssetAmount.divn(2),
										oraclePriceOffset: isOracleOffset ? price.toNumber() : null,
										price: isOracleOffset ? ZERO : price,
										postOnly: PostOnlyParams.MUST_POST_ONLY,
										bitFlags: OrderParamsBitFlag.ImmediateOrCancel,
									}),
									undefined,
									undefined,
									computeBudgetIxs
								);

							if (this.dryRun) {
								console.log(Date.now() - order['ts']);
								return;
							}

							const resp = await simulateAndGetTxWithCUs({
								connection: this.driftClient.connection,
								payerPublicKey: this.driftClient.wallet.payer!.publicKey,
								ixs: [...computeBudgetIxs, ...ixs],
								cuLimitMultiplier: 1.5,
								lookupTableAccounts:
									await this.driftClient.fetchAllLookupTableAccounts(),
								doSimulation: true,
							});
							if (resp.simError) {
								console.log(resp.simTxLogs);
								return;
							}

							this.driftClient.txSender
								.sendVersionedTransaction(resp.tx)
								.then((response) => {
									console.log(
										`Sent tx slot: ${
											response.slot
										}, tx: https://solscan.io/tx/${response.txSig}?cluster=${
											this.isMainnet ? 'mainnet-beta' : 'devnet'
										}`
									);
								})
								.catch((error) => {
									console.log(error);
								});
						}, timeUntilAuction);
					}
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

		this.ws = ws;
	}

	public async healthCheck() {
		return true;
	}

	private startHeartbeatTimer() {
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
		}
		this.heartbeatTimeout = setTimeout(() => {
			console.warn('No heartbeat received within 60 seconds, reconnecting...');
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
			this.subscribeWs();
		}, 1000);
	}
}
