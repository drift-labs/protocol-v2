/* eslint-disable @typescript-eslint/no-unused-vars */
import { JitProxyClient, PriceType } from '../jitProxyClient';
import { PublicKey } from '@solana/web3.js';
import {
	AuctionSubscriber,
	BN,
	BulkAccountLoader,
	convertToNumber,
	DriftClient,
	getAuctionPrice,
	getAuctionPriceForOracleOffsetAuction,
	getUserStatsAccountPublicKey,
	hasAuctionPrice,
	isVariant,
	OraclePriceData,
	Order,
	PRICE_PRECISION,
	SlotSubscriber,
	UserAccount,
	UserStatsMap,
} from '../..';

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
};

export abstract class BaseJitter {
	auctionSubscriber: AuctionSubscriber;
	driftClient: DriftClient;
	jitProxyClient: JitProxyClient;
	userStatsMap: UserStatsMap;

	perpParams = new Map<number, JitParams>();
	spotParams = new Map<number, JitParams>();

	onGoingAuctions = new Map<string, Promise<void>>();

	userFilter: UserFilter;

	constructor({
		auctionSubscriber,
		jitProxyClient,
		driftClient,
		userStatsMap,
	}: {
		driftClient: DriftClient;
		auctionSubscriber: AuctionSubscriber;
		jitProxyClient: JitProxyClient;
		userStatsMap?: UserStatsMap;
	}) {
		this.auctionSubscriber = auctionSubscriber;
		this.driftClient = driftClient;
		this.jitProxyClient = jitProxyClient;
		this.userStatsMap =
			userStatsMap ||
			new UserStatsMap(this.driftClient, {
				type: 'polling',
				accountLoader: new BulkAccountLoader(
					this.driftClient.connection,
					'confirmed',
					0
				),
			});
	}

	async subscribe(): Promise<void> {
		await this.driftClient.subscribe();
		await this.userStatsMap.subscribe();

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

					if (this.userFilter) {
						if (this.userFilter(taker, takerKeyString, order)) {
							return;
						}
					}

					const orderSignature = this.getOrderSignatures(
						takerKeyString,
						order.orderId
					);

					if (this.onGoingAuctions.has(orderSignature)) {
						continue;
					}

					if (isVariant(order.marketType, 'perp')) {
						if (!this.perpParams.has(order.marketIndex)) {
							return;
						}

						const perpMarketAccount = this.driftClient.getPerpMarketAccount(
							order.marketIndex
						);
						if (
							order.baseAssetAmount
								.sub(order.baseAssetAmountFilled)
								.lte(perpMarketAccount.amm.minOrderSize)
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

	getOrderSignatures(takerKey: string, orderId: number): string {
		return `${takerKey}-${orderId}`;
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
}
