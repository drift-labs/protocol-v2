/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
	DLOB,
	SlotSubscriber,
	MarketType,
	DriftClient,
	loadKeypair,
	calculateBidPrice,
	calculateAskPrice,
	UserAccount,
	isVariant,
	decodeUser,
	Wallet,
	PhoenixSubscriber,
	BN,
	ClockSubscriber,
	OpenbookV2Subscriber,
	SignedMsgOrderParamsMessage,
	getUserAccountPublicKey,
	SignedMsgOrderNode,
	Order,
	ZERO,
	OrderTriggerCondition,
	PositionDirection,
	UserStatus,
	isUserProtectedMaker,
	OraclePriceData,
	OrderStatus,
	getVariant,
	PRICE_PRECISION,
	convertToNumber,
	BASE_PRECISION,
	SignedMsgOrderParamsDelegateMessage,
	OrderParamsBitFlag,
	PerpMarketAccount,
	SpotMarketAccount,
} from '@drift-labs/sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import parseArgs from 'minimist';
import { logger } from '../../logger';
import {
	FallbackLiquiditySource,
	SerializedNodeToFill,
	NodeToFillWithContext,
} from './types';
import { getDriftClientFromArgs, serializeNodeToFill } from './utils';
import { initializeSpotFulfillmentAccounts, sleepMs } from '../../utils';
import { LRUCache } from 'lru-cache';
import { sha256 } from '@noble/hashes/sha256';

const EXPIRE_ORDER_BUFFER_SEC = 30; // add an extra 30 seconds before trying to expire orders (want to avoid 6252 error due to clock drift)

const logPrefix = '[DLOBBuilder]';
class DLOBBuilder {
	private userAccountData = new Map<string, UserAccount>();
	private userAccountDataBuffers = new Map<string, Buffer>();
	private dlob: DLOB;
	public readonly slotSubscriber: SlotSubscriber;
	public readonly marketTypeString: string;
	public readonly marketType: MarketType;
	public readonly marketIndexes: number[];
	public driftClient: DriftClient;
	public initialized: boolean = false;

	// only used for spot filler
	private phoenixSubscribers?: Map<number, PhoenixSubscriber>;
	private openbookSubscribers?: Map<number, OpenbookV2Subscriber>;
	private clockSubscriber: ClockSubscriber;

	private signedMsgUserAuthorities = new Map<string, string>();

	// SignedMsg orders to keep track of
	private signedMsgOrders = new LRUCache<number, SignedMsgOrderNode>({
		max: 5000,
		dispose: (_, key) => {
			if (typeof process.send === 'function') {
				process.send({
					type: 'signedMsgOrderParamsMessage',
					data: {
						uuid: key,
						type: 'delete',
					},
				});
			}
			return;
		},
	});

	constructor(
		driftClient: DriftClient,
		marketType: MarketType,
		marketTypeString: string,
		marketIndexes: number[]
	) {
		this.dlob = new DLOB();
		this.slotSubscriber = new SlotSubscriber(driftClient.connection);
		this.marketType = marketType;
		this.marketTypeString = marketTypeString;
		this.marketIndexes = marketIndexes;
		this.driftClient = driftClient;

		if (marketTypeString.toLowerCase() === 'spot') {
			this.phoenixSubscribers = new Map<number, PhoenixSubscriber>();
			this.openbookSubscribers = new Map<number, OpenbookV2Subscriber>();
		}

		this.clockSubscriber = new ClockSubscriber(driftClient.connection, {
			commitment: 'confirmed',
			resubTimeoutMs: 5_000,
		});
	}

	public async subscribe() {
		await this.slotSubscriber.subscribe();
		await this.clockSubscriber.subscribe();

		if (this.marketTypeString.toLowerCase() === 'spot') {
			await this.initializeSpotMarkets();
		}
	}

	private async initializeSpotMarkets() {
		({
			phoenixSubscribers: this.phoenixSubscribers,
			openbookSubscribers: this.openbookSubscribers,
		} = await initializeSpotFulfillmentAccounts(
			this.driftClient,
			true,
			this.marketIndexes
		));
		if (!this.phoenixSubscribers) {
			throw new Error('phoenixSubscribers not initialized');
		}
	}

	public getUserBuffer(pubkey: string) {
		return this.userAccountDataBuffers.get(pubkey);
	}

	public deserializeAndUpdateUserAccountData(
		userAccount: string,
		pubkey: string
	) {
		const userAccountBuffer = Buffer.from(userAccount, 'base64');
		const deserializedUserAccount = decodeUser(userAccountBuffer);
		this.userAccountDataBuffers.set(pubkey, userAccountBuffer);
		this.userAccountData.set(pubkey, deserializedUserAccount);
	}

	public delete(pubkey: string) {
		this.userAccountData.delete(pubkey);
		this.userAccountDataBuffers.delete(pubkey);
	}

	// Private to avoid race conditions
	private build(): DLOB {
		logger.debug(
			`${logPrefix} Building DLOB with ${this.userAccountData.size} users`
		);
		const dlob = new DLOB();
		let counter = 0;
		this.userAccountData.forEach((userAccount, pubkey) => {
			userAccount.orders.forEach((order) => {
				if (
					!this.marketIndexes.includes(order.marketIndex) ||
					!isVariant(order.marketType, this.marketTypeString.toLowerCase())
				) {
					return;
				}
				dlob.insertOrder(
					order,
					pubkey,
					this.slotSubscriber.getSlot(),
					isUserProtectedMaker(userAccount),
					order.baseAssetAmount
				);
				counter++;
			});
		});
		for (const signedMsgNode of this.signedMsgOrders.values()) {
			dlob.insertSignedMsgOrder(
				signedMsgNode.order,
				signedMsgNode.userAccount,
				false
			);
			counter++;
		}
		logger.debug(`${logPrefix} Built DLOB with ${counter} orders`);
		this.dlob = dlob;
		return dlob;
	}

	public async insertSignedMsgOrder(orderData: any, uuid: number) {
		// Deserialize and store
		const signedMsgOrderParamsBuf = Buffer.from(
			orderData['order_message'],
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

		if (
			!signedMsgOrderParams.auctionDuration ||
			!signedMsgOrderParams.auctionStartPrice ||
			!signedMsgOrderParams.auctionEndPrice
		) {
			return;
		}

		if (signedMsgOrderParams.baseAssetAmount.eq(ZERO)) {
			return;
		}

		const takerAuthority = new PublicKey(orderData['taker_authority']);
		const takerUserPubkey = isDelegateSigner
			? (signedMessage as SignedMsgOrderParamsDelegateMessage).takerPubkey
			: await getUserAccountPublicKey(
					this.driftClient.program.programId,
					takerAuthority,
					(signedMessage as SignedMsgOrderParamsMessage).subAccountId
			  );
		logger.info(
			`Received signedMsgOrder: pubkey: ${takerUserPubkey.toString()}, direction: ${getVariant(
				signedMsgOrderParams.direction
			)}, marketIndex: ${
				signedMsgOrderParams.marketIndex
			}, baseAssetAmount: ${convertToNumber(
				signedMsgOrderParams.baseAssetAmount,
				BASE_PRECISION
			)}, auctionDuration: ${
				signedMsgOrderParams.auctionDuration
			}, auctionStartPrice: ${convertToNumber(
				signedMsgOrderParams.auctionStartPrice,
				PRICE_PRECISION
			)}, auctionEndPrice: ${convertToNumber(
				signedMsgOrderParams.auctionEndPrice,
				PRICE_PRECISION
			)}, maxTs: ${signedMsgOrderParams.maxTs}`
		);

		this.signedMsgUserAuthorities.set(
			takerUserPubkey.toString(),
			orderData['signing_authority']
		);

		const maxSlot = signedMessage.slot.addn(
			signedMsgOrderParams.auctionDuration ?? 0
		);
		if (maxSlot.toNumber() < this.slotSubscriber.getSlot()) {
			logger.warn(
				`${logPrefix} Received expired signedMsg order with uuid: ${uuid}`
			);
			return;
		}

		const orderSlot = Math.min(
			signedMessage.slot.toNumber(),
			this.slotSubscriber.getSlot()
		);

		const signedMsgOrder: Order = {
			status: OrderStatus.OPEN,
			orderType: signedMsgOrderParams.orderType,
			orderId: uuid,
			slot: new BN(orderSlot),
			marketIndex: signedMsgOrderParams.marketIndex,
			marketType: MarketType.PERP,
			baseAssetAmount: signedMsgOrderParams.baseAssetAmount,
			auctionDuration: signedMsgOrderParams.auctionDuration,
			auctionStartPrice: signedMsgOrderParams.auctionStartPrice,
			auctionEndPrice: signedMsgOrderParams.auctionEndPrice,
			immediateOrCancel:
				(signedMsgOrderParams.bitFlags &
					OrderParamsBitFlag.ImmediateOrCancel) !==
				0,
			direction: signedMsgOrderParams.direction,
			postOnly: false,
			oraclePriceOffset: signedMsgOrderParams.oraclePriceOffset ?? 0,
			maxTs: signedMsgOrderParams.maxTs ?? ZERO,
			reduceOnly: signedMsgOrderParams.reduceOnly ?? false,
			triggerCondition:
				signedMsgOrderParams.triggerCondition ?? OrderTriggerCondition.ABOVE,
			price: signedMsgOrderParams.price ?? ZERO,
			userOrderId: signedMsgOrderParams.userOrderId ?? 0,
			// Rest are not necessary and set for type conforming
			existingPositionDirection: PositionDirection.LONG,
			triggerPrice: ZERO,
			baseAssetAmountFilled: ZERO,
			quoteAssetAmountFilled: ZERO,
			quoteAssetAmount: ZERO,
			bitFlags: 0,
			postedSlotTail: 0,
		};

		const signedMsgOrderNode = new SignedMsgOrderNode(
			signedMsgOrder,
			takerUserPubkey.toString()
		);

		const ttl = (maxSlot.toNumber() - this.slotSubscriber.getSlot()) * 500;
		this.signedMsgOrders.set(uuid, signedMsgOrderNode, {
			ttl,
		});
	}

	public getdNodesToFill(): NodeToFillWithContext[] {
		const dlob = this.build();
		const nodesToFill: NodeToFillWithContext[] = [];
		for (const marketIndex of this.marketIndexes) {
			let market: PerpMarketAccount | SpotMarketAccount | undefined;
			let oraclePriceData: OraclePriceData;
			let fallbackAsk: BN | undefined = undefined;
			let fallbackBid: BN | undefined = undefined;
			let fallbackAskSource: FallbackLiquiditySource | undefined = undefined;
			let fallbackBidSource: FallbackLiquiditySource | undefined = undefined;
			if (this.marketTypeString.toLowerCase() === 'perp') {
				market = this.driftClient.getPerpMarketAccount(marketIndex);
				if (!market) {
					throw new Error('PerpMarket not found');
				}
				const mmOraclePriceData =
					this.driftClient.getMMOracleDataForPerpMarket(marketIndex);
				oraclePriceData =
					this.driftClient.getOracleDataForPerpMarket(marketIndex);
				fallbackBid = calculateBidPrice(
					market,
					mmOraclePriceData,
					new BN(this.slotSubscriber.getSlot())
				);
				fallbackAsk = calculateAskPrice(
					market,
					mmOraclePriceData,
					new BN(this.slotSubscriber.getSlot())
				);
			} else {
				market = this.driftClient.getSpotMarketAccount(marketIndex);
				if (!market) {
					throw new Error('SpotMarket not found');
				}
				oraclePriceData =
					this.driftClient.getOracleDataForSpotMarket(marketIndex);

				const openbookSubscriber = this.openbookSubscribers!.get(marketIndex);
				const openbookBid = openbookSubscriber?.getBestBid();
				const openbookAsk = openbookSubscriber?.getBestAsk();

				const phoenixSubscriber = this.phoenixSubscribers!.get(marketIndex);
				const phoenixBid = phoenixSubscriber?.getBestBid();
				const phoenixAsk = phoenixSubscriber?.getBestAsk();

				if (openbookBid && phoenixBid) {
					if (openbookBid!.gte(phoenixBid!)) {
						fallbackBid = openbookBid;
						fallbackBidSource = 'openbook';
					} else {
						fallbackBid = phoenixBid;
						fallbackBidSource = 'phoenix';
					}
				} else if (openbookBid) {
					fallbackBid = openbookBid;
					fallbackBidSource = 'openbook';
				} else if (phoenixBid) {
					fallbackBid = phoenixBid;
					fallbackBidSource = 'phoenix';
				}

				if (openbookAsk && phoenixAsk) {
					if (openbookAsk!.lte(phoenixAsk!)) {
						fallbackAsk = openbookAsk;
						fallbackAskSource = 'openbook';
					} else {
						fallbackAsk = phoenixAsk;
						fallbackAskSource = 'phoenix';
					}
				} else if (openbookAsk) {
					fallbackAsk = openbookAsk;
					fallbackAskSource = 'openbook';
				} else if (phoenixAsk) {
					fallbackAsk = phoenixAsk;
					fallbackAskSource = 'phoenix';
				}
			}

			const stateAccount = this.driftClient.getStateAccount();
			const slot = this.slotSubscriber.getSlot();
			const nodesToFillForMarket = isVariant(this.marketType, 'perp')
				? dlob.findNodesToFill(
						marketIndex,
						fallbackBid,
						fallbackAsk,
						slot,
						this.clockSubscriber.getUnixTs() - EXPIRE_ORDER_BUFFER_SEC,
						MarketType.PERP,
						this.driftClient.getMMOracleDataForPerpMarket(marketIndex),
						stateAccount,
						market as PerpMarketAccount
				  )
				: dlob.findNodesToFill(
						marketIndex,
						fallbackBid,
						fallbackAsk,
						slot,
						this.clockSubscriber.getUnixTs() - EXPIRE_ORDER_BUFFER_SEC,
						MarketType.SPOT,
						oraclePriceData,
						stateAccount,
						market as SpotMarketAccount
				  );

			nodesToFill.push(
				...nodesToFillForMarket.map((node) => {
					return { ...node, fallbackAskSource, fallbackBidSource };
				})
			);
		}
		return nodesToFill;
	}

	public serializeNodesToFill(
		nodesToFill: NodeToFillWithContext[]
	): SerializedNodeToFill[] {
		return nodesToFill
			.map((node) => {
				const buffer = this.getUserBuffer(node.node.userAccount!);
				if (!buffer && !node.node.isSignedMsg) {
					console.log(node.node);
					console.log(`Received node to fill without user account`);
					return undefined;
				}
				const makerBuffers = new Map<string, Buffer>();
				for (const makerNode of node.makerNodes) {
					const makerBuffer = this.getUserBuffer(makerNode.userAccount!);

					if (!makerBuffer) {
						return undefined;
					}
					makerBuffers.set(makerNode.userAccount!, makerBuffer);
				}
				return serializeNodeToFill(
					node,
					makerBuffers,
					this.userAccountData.get(node.node.userAccount!)?.status ===
						UserStatus.PROTECTED_MAKER,
					buffer,
					this.signedMsgUserAuthorities.get(node.node.userAccount!)
				);
			})
			.filter((node): node is SerializedNodeToFill => node !== undefined);
	}

	public trySendNodes(serializedNodesToFill: SerializedNodeToFill[]) {
		if (typeof process.send === 'function') {
			if (serializedNodesToFill.length > 0) {
				try {
					logger.debug('Sending fillable nodes');
					process.send({
						type: 'fillableNodes',
						data: serializedNodesToFill,
						// }, { swallowErrors: true });
					});
				} catch (e) {
					logger.error(`${logPrefix} Failed to send fillable nodes: ${e}`);
					// logger.error(JSON.stringify(serializedNodesToFill, null, 2));
				}
			}
		}
	}

	public removeConfirmedSignedMsgOrder(uuid: number) {
		this.signedMsgOrders.delete(uuid);
	}

	sendLivenessCheck(health: boolean) {
		if (typeof process.send === 'function') {
			process.send({
				type: 'health',
				data: {
					healthy: health,
				},
			});
		}
	}
}

const main = async () => {
	// kill this process if the parent dies
	process.on('disconnect', () => process.exit());

	dotenv.config();
	const endpoint = process.env.ENDPOINT;
	const privateKey = process.env.KEEPER_PRIVATE_KEY;
	const args = parseArgs(process.argv.slice(2));
	const driftEnv = args['drift-env'] ?? 'devnet';
	const marketTypeStr = args['market-type'];

	let marketIndexes;
	if (typeof args['market-indexes'] === 'string') {
		marketIndexes = args['market-indexes'].split(',').map(Number);
	} else {
		marketIndexes = [args['market-indexes']];
	}
	if (marketTypeStr !== 'perp' && marketTypeStr !== 'spot') {
		throw new Error("market-type must be either 'perp' or 'spot'");
	}

	let marketType: MarketType;
	switch (marketTypeStr) {
		case 'perp':
			marketType = MarketType.PERP;
			break;
		case 'spot':
			marketType = MarketType.SPOT;
			break;
		default:
			console.error('Error: Unsupported market type provided.');
			process.exit(1);
	}

	if (!endpoint || !privateKey) {
		throw new Error('ENDPOINT and KEEPER_PRIVATE_KEY must be provided');
	}
	const wallet = new Wallet(loadKeypair(privateKey));

	const connection = new Connection(endpoint, {
		wsEndpoint: process.env.WS_ENDPOINT,
		commitment: 'processed',
	});

	const driftClient = getDriftClientFromArgs({
		connection,
		wallet,
		marketIndexes,
		marketTypeStr,
		env: driftEnv,
	});
	await driftClient.subscribe();

	const dlobBuilder = new DLOBBuilder(
		driftClient,
		marketType,
		marketTypeStr,
		marketIndexes
	);

	await dlobBuilder.subscribe();
	await sleepMs(5000); // Give the dlob some time to get built
	if (typeof process.send === 'function') {
		logger.info('DLOBBuilder started');
		process.send({ type: 'initialized', data: dlobBuilder.marketIndexes });
	}

	process.on('message', (msg: any) => {
		if (!msg.data || typeof msg.data.type === 'undefined') {
			logger.warn(`${logPrefix} Received message without data.type field.`);
			return;
		}
		switch (msg.data.type) {
			case 'signedMsgOrderParamsMessage':
				dlobBuilder.insertSignedMsgOrder(
					msg.data.signedMsgOrder,
					msg.data.uuid
				);
				break;
			case 'confirmed':
				dlobBuilder.removeConfirmedSignedMsgOrder(Number(msg.data.uuid));
				break;
			case 'update':
				dlobBuilder.deserializeAndUpdateUserAccountData(
					msg.data.userAccount,
					msg.data.pubkey
				);
				break;
			case 'delete':
				dlobBuilder.delete(msg.data.pubkey);
				break;
			default:
				logger.warn(
					`${logPrefix} Received unknown message type: ${msg.data.type}`
				);
		}
	});

	setInterval(() => {
		const nodesToFill = dlobBuilder.getdNodesToFill();
		const serializedNodesToFill = dlobBuilder.serializeNodesToFill(nodesToFill);
		logger.debug(
			`${logPrefix} Serialized ${serializedNodesToFill.length} fillable nodes`
		);
		dlobBuilder.trySendNodes(serializedNodesToFill);
	}, 200);

	dlobBuilder.sendLivenessCheck(true);
	setInterval(() => {
		dlobBuilder.sendLivenessCheck(true);
	}, 10_000);
};

main();
