import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { QUOTE_BASE_PRECISION_DIFF, AMM_MANTISSA, ClearingHouse } from './clearingHouse';
import { UserAccountData, UserPosition, UserPositionData } from './DataTypes';
import { Subscriber, SubscriberResult } from './types';

export const MAX_LEVERAGE = new BN(10);

const FULL_LIQUIDATION_RATIO = new BN(500);
const PARTIAL_LIQUIDATION_RATIO = new BN(625);
const ZERO = new BN(0);
const BN_MAX = new BN(Number.MAX_SAFE_INTEGER);
const _THOUSAND = new BN(1000);
const TEN_THOUSAND = new BN(10000);

type UserAccountSubscriberResults =
	| SubscriberResult<'userAccountData', UserAccountData>
	| SubscriberResult<'userPositionsData', UserPositionData>;

type UserAccountSubscriber = Subscriber<UserAccountSubscriberResults>;

export class UserAccount {
	clearingHouse: ClearingHouse;
	userPublicKey: PublicKey;
	userAccountPublicKey?: PublicKey;
	userAccountData?: UserAccountData;
	userPositionsAccount?: UserPositionData;
	isSubscribed = false;
	subscriber?: UserAccountSubscriber = null;

	public constructor(clearingHouse: ClearingHouse, userPublicKey: PublicKey) {
		this.clearingHouse = clearingHouse;
		this.userPublicKey = userPublicKey;
	}

	public async subscribe(callback?: UserAccountSubscriber): Promise<boolean> {
		try {
			if (this.isSubscribed) {
				return;
			}

			if (callback) this.subscriber = callback;

			await this.clearingHouse.subscribe();

			const userAccountPublicKey = await this.getPublicKey();

			// get current user account data
			const currentUserAccount = await this.clearingHouse.getUserAccountData(
				userAccountPublicKey
			);

			this.userAccountData = currentUserAccount;

			//get current positions data
			const currentUserPositionsAccount =
				await this.clearingHouse.getPositionsAccountData(
					this.userAccountData.positions
				);

			this.userPositionsAccount = currentUserPositionsAccount;

			// now that data is initialized, safe to use methods, set isSubscribed true
			this.isSubscribed = true;

			// callback with latest account data
			this.subscriber?.({
				dataLabel: 'userAccountData',
				data: currentUserAccount,
			});

			// callback with latest positions data
			this.subscriber?.({
				dataLabel: 'userPositionsData',
				data: currentUserPositionsAccount,
			});

			// set up subscriber for account data
			this.clearingHouse
				.getUserAccountClient()
				.subscribe(userAccountPublicKey, this.clearingHouse.opts.commitment)
				.on('change', async (updateData) => {
					this.userAccountData = updateData;

					this.subscriber?.({
						dataLabel: 'userAccountData',
						data: updateData,
					});
				});

			// set up subscriber for positions data
			this.clearingHouse
				.getPositionsAccountClient()
				.subscribe(
					this.userAccountData.positions,
					this.clearingHouse.opts.commitment
				)
				.on('change', async (updateData) => {
					this.userPositionsAccount = updateData;

					this.subscriber?.({
						dataLabel: 'userPositionsData',
						data: updateData,
					});
				});

			return true;
		} catch (error) {
			console.error(`Caught error trying to subscribe to UserAccount`, error);

			this.isSubscribed = false;

			return false;
		}
	}

	assertIsSubscribed() {
		if (!this.isSubscribed) {
			throw Error('You must call `subscribe` before using this function');
		}
	}

	public async unsubscribe(keepClearingHouseSubscription?: boolean) {
		this.clearingHouse
			.getUserAccountClient()
			.unsubscribe(await this.getPublicKey());

		this.clearingHouse
			.getPositionsAccountClient()
			.unsubscribe(this.userAccountData.positions);

		if (!keepClearingHouseSubscription) this.clearingHouse.unsubscribe();

		this.isSubscribed = false;
	}

	public async getPublicKey(): Promise<PublicKey> {
		if (this.userAccountPublicKey) {
			return this.userAccountPublicKey;
		}

		this.userAccountPublicKey = (
			await this.clearingHouse.getUserAccountPublicKey(this.userPublicKey)
		)[0];
		return this.userAccountPublicKey;
	}

	public async exists(): Promise<boolean> {
		const userAccountPublicKey = await this.getPublicKey();
		const userAccountRPCResponse =
			await this.clearingHouse.connection.getParsedAccountInfo(
				userAccountPublicKey
			);
		return userAccountRPCResponse.value !== null;
	}

	public getBuyingPower(): BN {
		this.assertIsSubscribed();
		return this.getFreeCollateral().mul(MAX_LEVERAGE);
	}

	public getFreeCollateral(): BN {
		this.assertIsSubscribed();
		return this.getTotalCollateral().sub(
			this.getTotalPositionValue().div(MAX_LEVERAGE)
		);
	}

	public getUnrealizedPNL(withFunding?: boolean): BN {
		this.assertIsSubscribed();
		return this.userPositionsAccount.positions.reduce((pnl, marketPosition) => {
			return pnl.add(
				this.clearingHouse.calculatePositionPNL(marketPosition, withFunding)
			);
		}, ZERO);
	}

	public getUnrealizedFundingPNL(): BN {
		this.assertIsSubscribed();
		return this.userPositionsAccount.positions.reduce((pnl, marketPosition) => {
			return pnl.add(
				this.clearingHouse.calculatePositionFundingPNL(marketPosition)
			);
		}, ZERO);
	}

	public getTotalCollateral(): BN {
		this.assertIsSubscribed();

		return (
			this.userAccountData?.collateral.add(this.getUnrealizedPNL(true)) ??
			new BN(0)
		);
	}

	getTotalPositionValue(): BN {
		this.assertIsSubscribed();
		return this.userPositionsAccount.positions.reduce(
			(positionValue, marketPosition) => {
				return positionValue.add(
					this.clearingHouse.calculateBaseAssetValue(marketPosition)
				);
			},
			ZERO
		).div(AMM_MANTISSA);
	}

	public getPositionValue(positionIndex: number): BN {
		return this.clearingHouse.calculateBaseAssetValue(
				this.userPositionsAccount.positions[positionIndex]
		).div(AMM_MANTISSA);
	}

	public getPositionEstimatedExitPriceWithMantissa(position: UserPosition): BN {
		const baseAssetValue = this.clearingHouse.calculateBaseAssetValue(position);
		if (position.baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}
		return baseAssetValue.mul(QUOTE_BASE_PRECISION_DIFF).div(position.baseAssetAmount.abs());
	}

	/**
	 * Since we are using BN, we multiply the result by 10000 to maintain 4 digits of precision
	 */
	public getLeverage(): BN {
		const totalCollateral = this.getTotalCollateral();
		const totalPositionValue = this.getTotalPositionValue();
		if (totalPositionValue.eq(ZERO) && totalCollateral.eq(ZERO)) {
			return ZERO;
		}
		return totalPositionValue.mul(TEN_THOUSAND).div(totalCollateral);
	}

	/**
	 * Since we are using BN, we multiply the result by 10000 to maintain 4 digits of precision
	 */
	public getMarginRatio(): BN {
		this.assertIsSubscribed();
		const totalPositionValue = this.getTotalPositionValue();

		if (totalPositionValue.eq(ZERO)) {
			return BN_MAX;
		}

		return this.getTotalCollateral().mul(TEN_THOUSAND).div(totalPositionValue);
	}

	public canBeLiquidated(): [boolean, BN] {
		const marginRatio = this.getMarginRatio();
		const canLiquidate = marginRatio.lte(PARTIAL_LIQUIDATION_RATIO);
		return [canLiquidate, marginRatio];
	}

	public needsToSettleFundingPayment(): boolean {
		const marketsAccount = this.clearingHouse.getMarketsAccount();
		for (const userPosition of this.userPositionsAccount.positions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			const market =
				marketsAccount.markets[userPosition.marketIndex.toNumber()];
			if (market.amm.cumulativeFundingRate.eq(userPosition.lastCumulativeFundingRate)) {
				continue;
			}

			return true;
		}
		return false;
	}

	public liquidationPrice(marketPosition: Pick<UserPosition, "baseAssetAmount"|"marketIndex">, 
	proposedTradeSize: BN=ZERO, partial=false): BN {
		// +/-(margin_ratio-liq_ratio) * price_now = price_liq
		// todo: margin_ratio is not symmetric on price action (both numer and denom change)
		// margin_ratio = collateral / base_asset_value

		
		/* example: assume BTC price is $40k (examine 10% up/down)
		
		if 10k deposit and levered 10x short BTC => BTC up $400 means:
		1. higher base_asset_value (+$4k)
		2. lower collateral (-$4k)
		3. (10k - 4k)/(100k + 4k) => 6k/104k => .0576

		for 10x long, BTC down $400:
		3. (10k - 4k) / (100k - 4k) = 6k/96k => .0625 */

		const currentPrice = this.clearingHouse.calculateBaseAssetPriceWithMantissa(
			marketPosition.marketIndex
		);

		const totalCollateral = this.getTotalCollateral();
		let totalPositionValue = this.getTotalPositionValue();

		const proposedMarketPosition: UserPosition = {
			marketIndex: marketPosition.marketIndex,
			baseAssetAmount: proposedTradeSize,
			lastCumulativeFundingRate: new BN(0),
			quoteAssetAmount: new BN(0),

		};

		totalPositionValue = totalPositionValue.add(this.clearingHouse.calculateBaseAssetValue(proposedMarketPosition));

		let marginRatio;
		if (totalPositionValue.eq(ZERO)) {
			marginRatio = BN_MAX;
		} else {
			marginRatio = totalCollateral.mul(TEN_THOUSAND).div(totalPositionValue);
		}

		let liqRatio = FULL_LIQUIDATION_RATIO;
		if (partial) {
			liqRatio = PARTIAL_LIQUIDATION_RATIO;
		}

		let pctChange = marginRatio.abs().sub(liqRatio);
		const baseAssetSign = marketPosition.baseAssetAmount; //todo

		// if user is short, higher price is liq
		if (baseAssetSign.isNeg()) {
			pctChange = pctChange.add(TEN_THOUSAND);
		} else {
			if (TEN_THOUSAND.lte(pctChange)) {
				// no liquidation price, position is a fully/over collateralized long
				// handle as NaN on UI
				return new BN(-1);
			}
			pctChange = TEN_THOUSAND.sub(pctChange);
		}

		const liqPrice = currentPrice.mul(pctChange).div(TEN_THOUSAND);

		return liqPrice;
	}

	public summary() {
		const marketPosition0 = this.userPositionsAccount.positions[0];
		const pos0PNL = this.clearingHouse.calculatePositionPNL(marketPosition0);
		const pos0Value =
			this.clearingHouse.calculateBaseAssetValue(marketPosition0);

		const pos0Px = this.clearingHouse.calculateBaseAssetPriceWithMantissa(
			marketPosition0.marketIndex
		);

		return {
			totalCollateral: this.getTotalCollateral(),
			uPnL: this.getUnrealizedPNL(),
			marginRatio: this.getMarginRatio(),
			freeCollateral: this.getFreeCollateral(),
			leverage: this.getLeverage(),
			buyingPower: this.getBuyingPower(),
			tPV: this.getTotalPositionValue(),

			pos0BAmt: marketPosition0.baseAssetAmount,
			pos0QAmt: marketPosition0.quoteAssetAmount,
			pos0Market: marketPosition0.marketIndex,
			pos0LiqPrice: this.liquidationPrice(marketPosition0),
			pos0Value: pos0Value,
			pos0Px: pos0Px,
			pos0PNL: pos0PNL,
		};
	}
}
