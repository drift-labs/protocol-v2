/* eslint-disable @typescript-eslint/no-unused-vars */
import { JitProxyClient, PriceType } from '../jitProxyClient';
import { PublicKey } from '@solana/web3.js';
import {
	AuctionSubscriber,
	BN,
	BulkAccountLoader,
	VelocityClient,
	getAuctionPrice,
	getUserAccountPublicKey,
	getUserStatsAccountPublicKey,
	hasAuctionPrice,
	isVariant,
	MarketType,
	Order,
	OrderStatus,
	PositionDirection,
	PostOnlyParams,
	SwiftOrderSubscriber,
	SlotSubscriber,
	SignedMsgOrderParams,
	UserAccount,
	UserStatsMap,
	ZERO,
	isSignedMsgOrder,
	OrderTriggerCondition,
	SignedMsgOrderParamsDelegateMessage,
	SignedMsgOrderParamsMessage,
	OrderParamsBitFlag,
} from '@velocity-exchange/sdk';
import { decodeUTF8 } from 'tweetnacl-util';

export type UserFilter = (
	userAccount: UserAccount,
	userKey: string,
	order: Order
) => boolean;

export type JitParams = {
	bid: BN;
	ask: BN;
	minPosition: BN;
	maxPosition;
	priceType: PriceType;
	subAccountId?: number;
	postOnlyParams?: PostOnlyParams;
};

export abstract class BaseJitter {
	auctionSubscriber: AuctionSubscriber;
	swiftOrderSubscriber: SwiftOrderSubscriber;
	slotSubscriber: SlotSubscriber;
	driftClient: VelocityClient;
	jitProxyClient: JitProxyClient;
	auctionSubscriberIgnoresSwiftOrders?: boolean;
	userStatsMap: UserStatsMap;

	perpParams = new Map<number, JitParams>();
	spotParams = new Map<number, JitParams>();

	seenOrders = new Set<string>();
	onGoingAuctions = new Map<string, Promise<void>>();

	userFilter: UserFilter;

	computeUnits: number;
	computeUnitsPrice: number;

	constructor({
		auctionSubscriber,
		jitProxyClient,
		driftClient,
		userStatsMap,
		swiftOrderSubscriber,
		slotSubscriber,
		auctionSubscriberIgnoresSwiftOrders,
	}: {
		driftClient: VelocityClient;
		auctionSubscriber: AuctionSubscriber;
		jitProxyClient: JitProxyClient;
		userStatsMap: UserStatsMap;
		swiftOrderSubscriber?: SwiftOrderSubscriber;
		slotSubscriber?: SlotSubscriber;
		auctionSubscriberIgnoresSwiftOrders?: boolean;
	}) {
		this.auctionSubscriber = auctionSubscriber;
		this.driftClient = driftClient;
		this.jitProxyClient = jitProxyClient;
		this.userStatsMap =
			userStatsMap ||
			new UserStatsMap(
				this.driftClient,
				new BulkAccountLoader(this.driftClient.connection, 'confirmed', 0)
			);
		this.slotSubscriber = slotSubscriber;
		this.swiftOrderSubscriber = swiftOrderSubscriber;
		this.auctionSubscriberIgnoresSwiftOrders =
			auctionSubscriberIgnoresSwiftOrders;

		if (this.swiftOrderSubscriber && !this.slotSubscriber) {
			throw new Error(
				'Slot subscriber is required for signedMsg order subscriber'
			);
		}

		if (!this.swiftOrderSubscriber.userAccountGetter) {
			throw new Error(
				'User account getter is required in swift order subscriber for jit integration'
			);
		}
	}

	async subscribe(): Promise<void> {
		await this.driftClient.subscribe();

		await this.auctionSubscriber.subscribe();
		this.auctionSubscriber.eventEmitter.on(
			'onAccountUpdate',
			async (taker, takerKey, slot) => {
				const takerKeyString = takerKey.toBase58();

				const takerStatsKey = getUserStatsAccountPublicKey(
					this.driftClient.program.programId,
					taker.authority
				);
				for (const order of taker.orders) {
					if (!isVariant(order.status, 'open')) {
						continue;
					}

					if (!hasAuctionPrice(order, slot)) {
						continue;
					}

					if (
						this.auctionSubscriberIgnoresSwiftOrders &&
						isSignedMsgOrder(order)
					) {
						continue;
					}

					if (this.userFilter) {
						if (this.userFilter(taker, takerKeyString, order)) {
							return;
						}
					}

					const orderSignature = this.getOrderSignatures(
						takerKeyString,
						order.orderId
					);

					if (this.seenOrders.has(orderSignature)) {
						continue;
					}
					this.seenOrders.add(orderSignature);

					if (this.onGoingAuctions.has(orderSignature)) {
						continue;
					}

					if (isVariant(order.marketType, 'perp')) {
						if (!this.perpParams.has(order.marketIndex)) {
							return;
						}

						// Velocity perp markets have no min order size (amm.minOrderSize
						// was removed from the program vs Drift), so the upstream dust
						// guard collapses to "skip only fully-filled orders".
						if (
							order.baseAssetAmount.sub(order.baseAssetAmountFilled).lte(ZERO)
						) {
							return;
						}

						const promise = this.createTryFill(
							taker,
							takerKey,
							takerStatsKey,
							order,
							orderSignature
						).bind(this)();
						this.onGoingAuctions.set(orderSignature, promise);
					} else {
						if (!this.spotParams.has(order.marketIndex)) {
							return;
						}

						const spotMarketAccount = this.driftClient.getSpotMarketAccount(
							order.marketIndex
						);
						if (
							order.baseAssetAmount
								.sub(order.baseAssetAmountFilled)
								.lte(spotMarketAccount.minOrderSize)
						) {
							return;
						}

						const promise = this.createTryFill(
							taker,
							takerKey,
							takerStatsKey,
							order,
							orderSignature
						).bind(this)();
						this.onGoingAuctions.set(orderSignature, promise);
					}
				}
			}
		);
		await this.slotSubscriber?.subscribe();
		await this.swiftOrderSubscriber?.subscribe(
			async (orderMessageRaw, signedMessage, isDelegateSigner) => {
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

				const signedMsgOrderParamsBufHex = Buffer.from(
					orderMessageRaw['order_message']
				);

				const takerAuthority = new PublicKey(
					orderMessageRaw['taker_authority']
				);
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
				const takerUserPubkeyString = takerUserPubkey.toBase58();
				const takerUserAccount =
					await this.swiftOrderSubscriber.userAccountGetter.mustGetUserAccount(
						takerUserPubkey.toString()
					);
				const orderSlot = Math.min(
					signedMessage.slot.toNumber(),
					this.slotSubscriber.getSlot()
				);

				/**
				 * Base asset amount equalling u64::max is a special case that signals to program
				 * to bring taker to max leverage. Program will calculate the max base asset amount to do this
				 * once the tx lands on chain.
				 *
				 * You will see this is base asset amount is ffffffffffffffff
				 */
				const signedMsgOrder: Order = {
					status: OrderStatus.OPEN,
					orderType: signedMsgOrderParams.orderType,
					orderId: this.convertUuidToNumber(orderMessageRaw['uuid']),
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
					bitFlags: signedMsgOrderParams.bitFlags,
					direction: signedMsgOrderParams.direction,
					postOnly: false,
					oraclePriceOffset:
						signedMsgOrderParams.oraclePriceOffset ?? new BN(0),
					maxTs: signedMsgOrderParams.maxTs ?? ZERO,
					reduceOnly: signedMsgOrderParams.reduceOnly ?? false,
					triggerCondition:
						signedMsgOrderParams.triggerCondition ??
						OrderTriggerCondition.ABOVE,
					price: signedMsgOrderParams.price ?? ZERO,
					userOrderId: signedMsgOrderParams.userOrderId ?? 0,
					// Rest are not necessary and set for type conforming
					existingPositionDirection: PositionDirection.LONG,
					triggerPrice: ZERO,
					baseAssetAmountFilled: ZERO,
					quoteAssetAmountFilled: ZERO,
					postedSlotTail: 0,
				};

				if (this.userFilter) {
					if (
						this.userFilter(
							takerUserAccount,
							takerUserPubkeyString,
							signedMsgOrder
						)
					) {
						return;
					}
				}

				const orderSignature = this.getOrderSignatures(
					takerUserPubkeyString,
					signedMsgOrder.orderId
				);

				if (this.seenOrders.has(orderSignature)) {
					return;
				}
				this.seenOrders.add(orderSignature);

				if (this.onGoingAuctions.has(orderSignature)) {
					return;
				}

				if (!this.perpParams.has(signedMsgOrder.marketIndex)) {
					return;
				}

				// Velocity perp markets have no min order size (see above); only a
				// zero-size order needs skipping here.
				if (signedMsgOrder.baseAssetAmount.lte(ZERO)) {
					return;
				}

				const promise = this.createTrySignedMsgFill(
					signingAuthority,
					{
						orderParams: signedMsgOrderParamsBufHex,
						signature: Buffer.from(
							orderMessageRaw['order_signature'],
							'base64'
						),
					},
					decodeUTF8(orderMessageRaw['uuid']),
					takerUserAccount,
					takerUserPubkey,
					getUserStatsAccountPublicKey(
						this.driftClient.program.programId,
						takerUserAccount.authority
					),
					signedMsgOrder,
					orderSignature,
					orderMessageRaw['market_index']
				).bind(this)();
				this.onGoingAuctions.set(orderSignature, promise);
			}
		);
	}

	createTryFill(
		taker: UserAccount,
		takerKey: PublicKey,
		takerStatsKey: PublicKey,
		order: Order,
		orderSignature: string
	): () => Promise<void> {
		throw new Error('Not implemented');
	}

	createTrySignedMsgFill(
		authorityToUse: PublicKey,
		signedMsgOrderParams: SignedMsgOrderParams,
		uuid: Uint8Array,
		taker: UserAccount,
		takerKey: PublicKey,
		takerStatsKey: PublicKey,
		order: Order,
		orderSignature: string,
		marketIndex: number
	): () => Promise<void> {
		throw new Error('Not implemented');
	}

	deleteOnGoingAuction(orderSignature: string): void {
		this.onGoingAuctions.delete(orderSignature);
		this.seenOrders.delete(orderSignature);
	}

	getOrderSignatures(takerKey: string, orderId: number): string {
		return `${takerKey}-${orderId}`;
	}

	private convertUuidToNumber(uuid: string): number {
		return uuid
			.split('')
			.reduce(
				(n, c) =>
					n * 64 +
					'_~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(
						c
					),
				0
			);
	}

	public updatePerpParams(marketIndex: number, params: JitParams): void {
		this.perpParams.set(marketIndex, params);
	}

	public updateSpotParams(marketIndex: number, params: JitParams): void {
		this.spotParams.set(marketIndex, params);
	}

	public setUserFilter(userFilter: UserFilter | undefined): void {
		this.userFilter = userFilter;
	}

	public setComputeUnits(computeUnits: number): void {
		this.computeUnits = computeUnits;
	}

	public setComputeUnitsPrice(computeUnitsPrice: number): void {
		this.computeUnitsPrice = computeUnitsPrice;
	}
}
