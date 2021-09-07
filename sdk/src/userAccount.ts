import { AMM_MANTISSA, FUNDING_MANTISSA, ClearingHouse } from './clearingHouse';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { Subscriber, SubscriberResult } from './types';
import { UserAccountData, UserPosition, UserPositionData } from './DataTypes';

export const MAX_LEVERAGE = new BN(5);

const PARTIAL_LIQUIDATION_RATIO = new BN(625);
const ZERO = new BN(0);
const BN_MAX = new BN(Number.MAX_SAFE_INTEGER);
const THOUSAND = new BN(1000);
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
		console.log(`Constructing User Account Instance`);
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

	public async unsubscribe() {
		this.clearingHouse.program.account.userAccount.unsubscribe(
			await this.getPublicKey()
		);
		this.clearingHouse.program.account.userPositionsAccount.unsubscribe(
			this.userAccountData.positions
		);
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
		return (
			this.userAccountData?.collateral.add(this.getUnrealizedPNL(true)) ??
			new BN(0)
		);
	}

	getTotalPositionValue(): BN {
		return this.userPositionsAccount.positions.reduce(
			(positionValue, marketPosition) => {
				return positionValue.add(
					this.clearingHouse.calculateBaseAssetValue(marketPosition)
				);
			},
			ZERO
		);
	}

	public getPositionValue(positionIndex: number): BN {
		return this.clearingHouse.calculateBaseAssetValue(
			this.userPositionsAccount.positions[positionIndex]
		);
	}

	public getPositionEstimatedExitPriceWithMantissa(positionIndex: number): BN {
		const position = this.userPositionsAccount.positions[positionIndex];
		const baseAssetValue = this.clearingHouse.calculateBaseAssetValue(position);
		if (position.baseAssetAmount.eq(ZERO)) {
			console.log('zero position:', position);
			return ZERO;
		}
		return baseAssetValue.mul(AMM_MANTISSA).div(position.baseAssetAmount);
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
			if (market.amm.cumFundingRate.eq(userPosition.lastCumFunding)) {
				continue;
			}

			return true;
		}
		return false;
	}

	public liquidationPrice(marketPosition: UserPosition, partial: boolean=false): BN {
		// todo: pricePoint:liq doesnt anticipate market-impact AT point of sale, just at current point
		// 		 current estimate is biased lower, which is also kinda fair

		// x = baseAmount (positive => long, negative => short)
		// x*price_now - x*price_liq >= free_collateral * (MAX_LEVERAGE_I / MAX_LEVERAGE_M)
		// x*price_now - x*price_liq >= free_collateral * (5 / 20)
		// solve for price_liq
		// price_liq >= price_now - free_collateral/x

		// const M_I_LEVERAGE_RATIO = new BN(4);
		const currentPrice = this.clearingHouse.calculateBaseAssetPriceWithMantissa(
			marketPosition.marketIndex
		);

		// let freeCollateral = this.getFreeCollateral().div(MAX_LEVERAGE);
		// console.log(freeCollateral.toNumber(), marketPosition.baseAssetAmount.toNumber());

		// const drawDownPriceAction = freeCollateral
		// 	.mul(AMM_MANTISSA)
		// 	.div(marketPosition.baseAssetAmount)
		// 	.mul(M_I_LEVERAGE_RATIO);

		// const liqPrice = currentPrice.sub(drawDownPriceAction);

		// console.log('currentPrice:', currentPrice.toNumber(),
		// 			'\ndrawDownPriceAction:', drawDownPriceAction.toNumber(),
		// 			'\nliqPrice:',liqPrice.toNumber(),
		// );

		// alternatively:
		// +/-(margin_ratio-liq_ratio) * price_now = price_liq

		const marginRatio = this.getMarginRatio();
		let liqRatio = new BN(500); // .05 * 1000 = .5 * 100 = 5 * 10
		if(partial){
			liqRatio = PARTIAL_LIQUIDATION_RATIO;
		}

		console.log(liqRatio.toNumber(), marginRatio.toNumber());
		let pctChange = marginRatio.abs().sub(liqRatio);
		const baseAssetSign = marketPosition.baseAssetAmount; //todo

		// if user is short, higher price is liq
		if (baseAssetSign.isNeg()) {
			pctChange = pctChange.add(TEN_THOUSAND);
		} else {
			if (TEN_THOUSAND.lte(pctChange)) {
				// no liquidation price, position is a fully/over collateralized long
				return new BN(-1);
			}
			pctChange = TEN_THOUSAND.sub(pctChange);
		}

		const liqPrice = currentPrice.mul(pctChange).div(TEN_THOUSAND);
		try {
			console.log(
				' currentPrice:',
				currentPrice.toNumber(),
				'\n pctChange:',
				pctChange.toNumber(),
				'\n liqPrice:',
				liqPrice.toNumber()
			);
		} catch (err) {
			// # this code block same behavior as
			if (err instanceof TypeError) {
				// except ValueError as err:
				throw err; //     pass
			}
		}

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
			pos0QAmt: marketPosition0.quoteAssetNotionalAmount,
			pos0Market: marketPosition0.marketIndex,
			pos0LiqPrice: this.liquidationPrice(marketPosition0),
			pos0Value: pos0Value,
			pos0Px: pos0Px,
			pos0PNL: pos0PNL,
		};
	}
}
