import { JitProxyClient } from '../jitProxyClient';
import { PublicKey } from '@solana/web3.js';
import {
	AuctionSubscriber,
	convertToNumber,
	VelocityClient,
	getAuctionPrice,
	getAuctionPriceForOracleOffsetAuction,
	getLimitPrice,
	getVariant,
	isVariant,
	OraclePriceData,
	Order,
	PostOnlyParams,
	PRICE_PRECISION,
	SignedMsgOrderParams,
	SwiftOrderSubscriber,
	SlotSubscriber,
	UserAccount,
	UserStatsMap,
	ZERO,
} from '@velocity-exchange/sdk';
import { BaseJitter } from './baseJitter';

type AuctionAndOrderDetails = {
	slotsTilCross: number;
	willCross: boolean;
	bid: number;
	ask: number;
	auctionStartPrice: number;
	auctionEndPrice: number;
	stepSize: number;
	oraclePrice: OraclePriceData;
};

export class JitterSniper extends BaseJitter {
	slotSubscriber: SlotSubscriber;
	userStatsMap: UserStatsMap;

	constructor({
		auctionSubscriber,
		slotSubscriber,
		jitProxyClient,
		driftClient,
		userStatsMap,
		swiftOrderSubscriber,
		auctionSubscriberIgnoresSwiftOrders,
	}: {
		driftClient: VelocityClient;
		slotSubscriber: SlotSubscriber;
		auctionSubscriber: AuctionSubscriber;
		jitProxyClient: JitProxyClient;
		userStatsMap?: UserStatsMap;
		swiftOrderSubscriber?: SwiftOrderSubscriber;
		auctionSubscriberIgnoresSwiftOrders?: boolean;
	}) {
		super({
			auctionSubscriber,
			jitProxyClient,
			driftClient,
			userStatsMap,
			swiftOrderSubscriber,
			slotSubscriber,
			auctionSubscriberIgnoresSwiftOrders,
		});
		this.slotSubscriber = slotSubscriber;
	}

	createTryFill(
		taker: UserAccount,
		takerKey: PublicKey,
		takerStatsKey: PublicKey,
		order: Order,
		orderSignature: string
	): () => Promise<void> {
		return async () => {
			const params = this.perpParams.get(order.marketIndex);
			if (!params) {
				this.deleteOnGoingAuction(orderSignature);
				return;
			}

			const takerStats = await this.userStatsMap.mustGet(
				taker.authority.toString()
			);
			const referrerInfo = takerStats.getReferrerInfo();

			const {
				slotsTilCross,
				willCross,
				bid,
				ask,
				auctionStartPrice,
				auctionEndPrice,
				stepSize,
				oraclePrice,
			} = this.getAuctionAndOrderDetails(order);

			// don't increase risk if we're past max positions
			if (isVariant(order.marketType, 'perp')) {
				const currPerpPos =
					this.driftClient.getUser().getPerpPosition(order.marketIndex) ||
					this.driftClient.getUser().getEmptyPosition(order.marketIndex);
				if (
					currPerpPos.baseAssetAmount.lt(ZERO) &&
					isVariant(order.direction, 'short')
				) {
					if (currPerpPos.baseAssetAmount.lte(params.minPosition)) {
						console.log(
							`Order would increase existing short (mkt ${getVariant(
								order.marketType
							)}-${order.marketIndex}) too much`
						);
						this.deleteOnGoingAuction(orderSignature);
						return;
					}
				} else if (
					currPerpPos.baseAssetAmount.gt(ZERO) &&
					isVariant(order.direction, 'long')
				) {
					if (currPerpPos.baseAssetAmount.gte(params.maxPosition)) {
						console.log(
							`Order would increase existing long (mkt ${getVariant(
								order.marketType
							)}-${order.marketIndex}) too much`
						);
						this.deleteOnGoingAuction(orderSignature);
						return;
					}
				}
			}

			console.log(`
				Taker wants to ${JSON.stringify(
					order.direction
				)}, order slot is ${order.slot.toNumber()},
				My market: ${bid}@${ask},
				Auction: ${auctionStartPrice} -> ${auctionEndPrice}, step size ${stepSize}
				Current slot: ${
					this.slotSubscriber.currentSlot
				}, Order slot: ${order.slot.toNumber()},
				Will cross?: ${willCross}
				Slots to wait: ${slotsTilCross}. Target slot = ${
					order.slot.toNumber() + slotsTilCross
				}
			`);

			this.waitForSlotOrCrossOrExpiry(
				willCross
					? order.slot.toNumber() + slotsTilCross
					: order.slot.toNumber() + order.auctionDuration + 1,
				order,
				{
					slotsTilCross,
					willCross,
					bid,
					ask,
					auctionStartPrice,
					auctionEndPrice,
					stepSize,
					oraclePrice,
				}
			).then(async ({ slot, updatedDetails }) => {
				if (slot === -1) {
					console.log('Auction expired without crossing');
					this.deleteOnGoingAuction(orderSignature);
					return;
				}

				const params = isVariant(order.marketType, 'perp')
					? this.perpParams.get(order.marketIndex)
					: this.spotParams.get(order.marketIndex);
				const bid = isVariant(params.priceType, 'oracle')
					? convertToNumber(oraclePrice.price.add(params.bid), PRICE_PRECISION)
					: convertToNumber(params.bid, PRICE_PRECISION);
				const ask = isVariant(params.priceType, 'oracle')
					? convertToNumber(oraclePrice.price.add(params.ask), PRICE_PRECISION)
					: convertToNumber(params.ask, PRICE_PRECISION);
				const auctionPrice = convertToNumber(
					getAuctionPrice(order, slot, updatedDetails.oraclePrice.price),
					PRICE_PRECISION
				);
				console.log(`
					Expected auction price: ${auctionStartPrice + slotsTilCross * stepSize}
					Actual auction price: ${auctionPrice}
					-----------------
					Looking for slot ${order.slot.toNumber() + slotsTilCross}
					Got slot ${slot}
				`);

				console.log(`Trying to fill ${orderSignature} with:
					market: ${bid}@${ask}
					auction price: ${auctionPrice}
					submitting" ${convertToNumber(params.bid, PRICE_PRECISION)}@${convertToNumber(
						params.ask,
						PRICE_PRECISION
					)}
				`);
				let i = 0;
				while (i < 10) {
					try {
						const txParams = {
							computeUnits: this.computeUnits,
							computeUnitsPrice: this.computeUnitsPrice,
						};
						const { txSig } = await this.jitProxyClient.jit(
							{
								takerKey,
								takerStatsKey,
								taker,
								takerOrderId: order.orderId,
								maxPosition: params.maxPosition,
								minPosition: params.minPosition,
								bid: params.bid,
								ask: params.ask,
								postOnly:
									params.postOnlyParams ?? PostOnlyParams.MUST_POST_ONLY,
								priceType: params.priceType,
								referrerInfo,
								subAccountId: params.subAccountId,
							},
							txParams
						);

						console.log(`Filled ${orderSignature} txSig ${txSig}`);
						await sleep(3000);
						this.deleteOnGoingAuction(orderSignature);
						return;
					} catch (e) {
						console.error(`Failed to fill ${orderSignature}`);
						if (e.message.includes('0x1770') || e.message.includes('0x1771')) {
							console.log('Order does not cross params yet');
						} else if (e.message.includes('0x1779')) {
							console.log('Order could not fill');
						} else if (e.message.includes('0x1793')) {
							console.log('Oracle invalid');
						} else {
							await sleep(3000);
							this.deleteOnGoingAuction(orderSignature);
							return;
						}
					}
					await sleep(200);
					i++;
				}
			});
			this.deleteOnGoingAuction(orderSignature);
		};
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
		return async () => {
			const params = this.perpParams.get(order.marketIndex);
			if (!params) {
				this.deleteOnGoingAuction(orderSignature);
				return;
			}

			const takerStats = await this.userStatsMap.mustGet(
				taker.authority.toString()
			);
			const referrerInfo = takerStats.getReferrerInfo();

			const {
				slotsTilCross,
				willCross,
				bid,
				ask,
				auctionStartPrice,
				auctionEndPrice,
				stepSize,
				oraclePrice,
			} = this.getAuctionAndOrderDetails(order);

			// don't increase risk if we're past max positions
			if (isVariant(order.marketType, 'perp')) {
				const currPerpPos =
					this.driftClient.getUser().getPerpPosition(order.marketIndex) ||
					this.driftClient.getUser().getEmptyPosition(order.marketIndex);
				if (
					currPerpPos.baseAssetAmount.lt(ZERO) &&
					isVariant(order.direction, 'short')
				) {
					if (currPerpPos.baseAssetAmount.lte(params.minPosition)) {
						console.log(
							`Order would increase existing short (mkt ${getVariant(
								order.marketType
							)}-${order.marketIndex}) too much`
						);
						this.deleteOnGoingAuction(orderSignature);
						return;
					}
				} else if (
					currPerpPos.baseAssetAmount.gt(ZERO) &&
					isVariant(order.direction, 'long')
				) {
					if (currPerpPos.baseAssetAmount.gte(params.maxPosition)) {
						console.log(
							`Order would increase existing long (mkt ${getVariant(
								order.marketType
							)}-${order.marketIndex}) too much`
						);
						this.deleteOnGoingAuction(orderSignature);
						return;
					}
				}
			}

			console.log(`
				Taker wants to ${JSON.stringify(
					order.direction
				)}, order slot is ${order.slot.toNumber()},
				My market: ${bid}@${ask},
				Auction: ${auctionStartPrice} -> ${auctionEndPrice}, step size ${stepSize}
				Current slot: ${
					this.slotSubscriber.currentSlot
				}, Order slot: ${order.slot.toNumber()},
				Will cross?: ${willCross}
				Slots to wait: ${slotsTilCross}. Target slot = ${
					order.slot.toNumber() + slotsTilCross
				}
			`);

			this.waitForSlotOrCrossOrExpiry(
				willCross
					? order.slot.toNumber() + slotsTilCross
					: order.slot.toNumber() + order.auctionDuration + 1,
				order,
				{
					slotsTilCross,
					willCross,
					bid,
					ask,
					auctionStartPrice,
					auctionEndPrice,
					stepSize,
					oraclePrice,
				}
			).then(async ({ slot, updatedDetails }) => {
				if (slot === -1) {
					console.log('Auction expired without crossing');
					this.deleteOnGoingAuction(orderSignature);
					return;
				}

				const params = isVariant(order.marketType, 'perp')
					? this.perpParams.get(order.marketIndex)
					: this.spotParams.get(order.marketIndex);
				const bid = isVariant(params.priceType, 'oracle')
					? convertToNumber(oraclePrice.price.add(params.bid), PRICE_PRECISION)
					: convertToNumber(params.bid, PRICE_PRECISION);
				const ask = isVariant(params.priceType, 'oracle')
					? convertToNumber(oraclePrice.price.add(params.ask), PRICE_PRECISION)
					: convertToNumber(params.ask, PRICE_PRECISION);
				const auctionPrice = convertToNumber(
					getAuctionPrice(order, slot, updatedDetails.oraclePrice.price),
					PRICE_PRECISION
				);
				console.log(`
					Expected auction price: ${auctionStartPrice + slotsTilCross * stepSize}
					Actual auction price: ${auctionPrice}
					-----------------
					Looking for slot ${order.slot.toNumber() + slotsTilCross}
					Got slot ${slot}
				`);

				console.log(`Trying to fill ${orderSignature} with:
					market: ${bid}@${ask}
					auction price: ${auctionPrice}
					submitting" ${convertToNumber(params.bid, PRICE_PRECISION)}@${convertToNumber(
						params.ask,
						PRICE_PRECISION
					)}
				`);
				let i = 0;
				while (i < 10) {
					try {
						const txParams = {
							computeUnits: this.computeUnits,
							computeUnitsPrice: this.computeUnitsPrice,
						};
						const { txSig } = await this.jitProxyClient.jitSignedMsg(
							{
								takerKey,
								takerStatsKey,
								taker,
								takerOrderId: order.orderId,
								maxPosition: params.maxPosition,
								minPosition: params.minPosition,
								bid: params.bid,
								ask: params.ask,
								postOnly:
									params.postOnlyParams ?? PostOnlyParams.MUST_POST_ONLY,
								priceType: params.priceType,
								referrerInfo,
								subAccountId: params.subAccountId,
								authorityToUse,
								signedMsgOrderParams,
								uuid,
								marketIndex,
							},
							txParams
						);

						console.log(`Filled ${orderSignature} txSig ${txSig}`);
						await sleep(3000);
						this.deleteOnGoingAuction(orderSignature);
						return;
					} catch (e) {
						console.error(`Failed to fill ${orderSignature}`);
						if (e.message.includes('0x1770') || e.message.includes('0x1771')) {
							console.log('Order does not cross params yet');
						} else if (e.message.includes('0x1779')) {
							console.log('Order could not fill');
						} else if (e.message.includes('0x1793')) {
							console.log('Oracle invalid');
						} else {
							await sleep(3000);
							this.deleteOnGoingAuction(orderSignature);
							return;
						}
					}
					await sleep(200);
					i++;
				}
			});
			this.deleteOnGoingAuction(orderSignature);
		};
	}

	getAuctionAndOrderDetails(order: Order): AuctionAndOrderDetails {
		// Find number of slots until the order is expected to be in cross
		const params = isVariant(order.marketType, 'perp')
			? this.perpParams.get(order.marketIndex)
			: this.spotParams.get(order.marketIndex);
		const oraclePrice = isVariant(order.marketType, 'perp')
			? this.driftClient.getMMOracleDataForPerpMarket(order.marketIndex)
			: this.driftClient.getOracleDataForSpotMarket(order.marketIndex);

		const makerOrderDir = isVariant(order.direction, 'long') ? 'sell' : 'buy';
		const auctionStartPrice = convertToNumber(
			isVariant(order.orderType, 'oracle')
				? getAuctionPriceForOracleOffsetAuction(
						order,
						order.slot.toNumber(),
						oraclePrice.price
				  )
				: order.auctionStartPrice,
			PRICE_PRECISION
		);
		const auctionEndPrice = convertToNumber(
			isVariant(order.orderType, 'oracle')
				? getAuctionPriceForOracleOffsetAuction(
						order,
						order.slot.toNumber() + order.auctionDuration - 1,
						oraclePrice.price
				  )
				: order.auctionEndPrice,
			PRICE_PRECISION
		);

		const bid = isVariant(params.priceType, 'oracle')
			? convertToNumber(oraclePrice.price.add(params.bid), PRICE_PRECISION)
			: convertToNumber(params.bid, PRICE_PRECISION);
		const ask = isVariant(params.priceType, 'oracle')
			? convertToNumber(oraclePrice.price.add(params.ask), PRICE_PRECISION)
			: convertToNumber(params.ask, PRICE_PRECISION);

		let slotsTilCross = 0;
		let willCross = false;
		const stepSize =
			(auctionEndPrice - auctionStartPrice) / (order.auctionDuration - 1);
		while (slotsTilCross < order.auctionDuration) {
			if (makerOrderDir === 'buy') {
				if (
					convertToNumber(
						getAuctionPrice(
							order,
							order.slot.toNumber() + slotsTilCross,
							oraclePrice.price
						),
						PRICE_PRECISION
					) <= bid
				) {
					willCross = true;
					break;
				}
			} else {
				if (
					convertToNumber(
						getAuctionPrice(
							order,
							order.slot.toNumber() + slotsTilCross,
							oraclePrice.price
						),
						PRICE_PRECISION
					) >= ask
				) {
					willCross = true;
					break;
				}
			}
			slotsTilCross++;
		}

		// if it doesnt cross during auction, check if limit price crosses
		if (!willCross) {
			const slotAfterAuction =
				order.slot.toNumber() + order.auctionDuration + 1;
			const limitPrice = getLimitPrice(order, oraclePrice, slotAfterAuction);
			if (!limitPrice) {
				willCross = true;
				slotsTilCross = order.auctionDuration + 1;
			} else {
				const limitPriceNum = convertToNumber(limitPrice, PRICE_PRECISION);
				if (makerOrderDir === 'buy' || limitPriceNum <= bid) {
					willCross = true;
					slotsTilCross = order.auctionDuration + 1;
				} else if (makerOrderDir === 'sell' || limitPriceNum >= ask) {
					willCross = true;
					slotsTilCross = order.auctionDuration + 1;
				}
			}
		}

		return {
			slotsTilCross,
			willCross,
			bid,
			ask,
			auctionStartPrice,
			auctionEndPrice,
			stepSize,
			oraclePrice,
		};
	}

	async waitForSlotOrCrossOrExpiry(
		targetSlot: number,
		order: Order,
		initialDetails: AuctionAndOrderDetails
	): Promise<{ slot: number; updatedDetails: AuctionAndOrderDetails }> {
		let currentDetails: AuctionAndOrderDetails = initialDetails;
		let willCross = initialDetails.willCross;
		if (this.slotSubscriber.currentSlot > targetSlot) {
			const slot = willCross ? this.slotSubscriber.currentSlot : -1;
			return new Promise((resolve) =>
				resolve({ slot, updatedDetails: currentDetails })
			);
		}

		return new Promise((resolve) => {
			// Immediately return if we are past target slot

			const slotListener = (slot: number) => {
				if (slot >= targetSlot && willCross) {
					resolve({ slot, updatedDetails: currentDetails });
				}
			};

			// Otherwise listen for new slots in case we hit the target slot and we're gonna cross
			this.slotSubscriber.eventEmitter.once('newSlot', slotListener);

			// Update target slot as the bid/ask and the oracle changes
			const intervalId = setInterval(async () => {
				if (this.slotSubscriber.currentSlot >= targetSlot) {
					this.slotSubscriber.eventEmitter.removeListener(
						'newSlot',
						slotListener
					);
					clearInterval(intervalId);
					const slot = willCross ? this.slotSubscriber.currentSlot : -1;
					resolve({ slot, updatedDetails: currentDetails });
				}

				currentDetails = this.getAuctionAndOrderDetails(order);
				willCross = currentDetails.willCross;
				if (willCross) {
					targetSlot = order.slot.toNumber() + currentDetails.slotsTilCross;
				}
			}, 50);
		});
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
