/**
 * User — read-oriented abstraction over the on-chain `User` account.
 *
 * Responsibilities:
 *   - Margin and free-collateral calculations (mirrors `programs/velocity/src/math/margin.rs`).
 *   - Position accessors: perp positions, spot positions, unrealized PnL, leverage.
 *   - Open order queries and filtering.
 *   - Health factor and liquidation threshold checks.
 *   - Subscribes to and caches the latest `User` account state from chain.
 *
 * To send instructions (deposit, place order, etc.) use `VelocityClient`.
 * For referral/volume stats see `UserStats` (userStats.ts).
 */
import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { VelocityClient } from './velocityClient';
import {
	HealthComponent,
	HealthComponents,
	isVariant,
	MarginCategory,
	Order,
	OrderParams,
	PerpMarketAccount,
	PerpPosition,
	ReferrerStatus,
	SpotPosition,
	UserAccount,
	UserStatus,
	UserStatsAccount,
	AccountLiquidatableStatus,
} from './types';
import {
	calculateEntryPrice,
	calculateUnsettledFundingPnl,
	positionIsAvailable,
} from './math/position';
import {
	AMM_TO_QUOTE_PRECISION_RATIO,
	BASE_PRECISION,
	BN_MAX,
	DUST_POSITION_SIZE,
	FIVE_MINUTE,
	MARGIN_PRECISION,
	MAX_POSITIVE_UPNL_FOR_INITIAL_MARGIN,
	ONE,
	OPEN_ORDER_MARGIN_REQUIREMENT,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	QUOTE_PRECISION_EXP,
	QUOTE_SPOT_MARKET_INDEX,
	SPOT_MARKET_WEIGHT_PRECISION,
	TEN_THOUSAND,
	TWO,
	ZERO,
	ACCOUNT_AGE_DELETION_CUTOFF_SECONDS,
} from './constants/numericConstants';
import {
	DataAndSlot,
	UserAccountEvents,
	UserAccountSubscriber,
} from './accounts/types';
import { assertDataAndSlot } from './accounts/utils';
import { BigNum } from './factory/bigNum';
import { BN } from './isomorphic/anchor';
import { calculateBaseAssetValue, calculatePositionPNL } from './math/position';
import {
	calculateMarketMarginRatio,
	calculateReservePrice,
	calculateUnrealizedAssetWeight,
} from './math/market';
import {
	calculatePerpLiabilityValue,
	calculateWorstCasePerpLiabilityValue,
} from './math/margin';
import { calculateSpotMarketMarginRatio } from './math/spotMarket';
import { divCeil, sigNum } from './math/utils';
import {
	getBalance,
	getSignedTokenAmount,
	getStrictTokenValue,
	getTokenValue,
} from './math/spotBalance';
import { getUser30dRollingVolumeEstimate } from './math/trade';
import {
	MarketType,
	PositionDirection,
	PositionFlag,
	SpotBalanceType,
	SpotMarketAccount,
} from './types';
import { standardizeBaseAssetAmount } from './math/orders';
import { calculateBuilderFee, hasBuilderParams } from './math/builder';
import { WebSocketProgramUserAccountSubscriber } from './accounts/websocketProgramUserAccountSubscriber';
import {
	calculateAssetWeight,
	calculateLiabilityWeight,
	calculateWithdrawLimit,
	getSpotAssetValue,
	getSpotLiabilityValue,
	getTokenAmount,
} from './math/spotBalance';
import {
	calculateBaseAssetValueWithOracle,
	calculateCollateralDepositRequiredForTrade,
	calculateMarginUSDCRequiredForTrade,
	calculateWorstCaseBaseAssetAmount,
} from './math/margin';
import { MMOraclePriceData, OraclePriceData } from './oracles/types';
import { UserConfig } from './userConfig';
import { PollingUserAccountSubscriber } from './accounts/pollingUserAccountSubscriber';
import { WebSocketUserAccountSubscriber } from './accounts/webSocketUserAccountSubscriber';
import {
	calculateWeightedTokenValue,
	getWorstCaseTokenAmounts,
	isSpotPositionAvailable,
} from './math/spotPosition';
import {
	calculateLiveOracleTwap,
	getMultipleBetweenOracleSources,
} from './math/oracles';
import { getPerpMarketTierNumber, getSpotMarketTierNumber } from './math/tiers';
import { StrictOraclePrice } from './oracles/strictOraclePrice';

import { grpcUserAccountSubscriber } from './accounts/grpcUserAccountSubscriber';
import {
	IsolatedMarginCalculation,
	MarginCalculation,
	MarginContext,
} from './marginCalculation';

export type MarginType = 'Cross' | 'Isolated';

/**
 * Ports `get_proportion_u128` (math/helpers.rs) for the referee fee discount
 * calculation. The Rust version routes large operands through a wider U192
 * type purely to avoid u128 overflow; BN has no such ceiling, so that branch
 * is elided here since it produces the same numeric result.
 */
function getProportion128(value: BN, numerator: BN, denominator: BN): BN {
	if (numerator.eq(denominator)) {
		return value;
	}

	if (numerator.gt(denominator.div(TWO)) && denominator.gt(numerator)) {
		// ceiling division, mirroring standardize_value_with_remainder_i128
		const scaled = value.mul(denominator.sub(numerator));
		const remainder = scaled.mod(denominator);
		const floorDiv = scaled.div(denominator);
		const ceilDiv = remainder.isZero() ? floorDiv : floorDiv.add(ONE);
		return value.sub(ceilDiv);
	}

	return value.mul(numerator).div(denominator);
}

export class User {
	velocityClient: VelocityClient;
	userAccountPublicKey: PublicKey;
	accountSubscriber: UserAccountSubscriber;
	_isSubscribed = false;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	/** True only when both `subscribe()` has completed and the underlying `accountSubscriber` itself reports subscribed. */
	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	/** Constructs a `User` for the account at `config.userAccountPublicKey`, wiring up the account subscriber selected by `config.accountSubscription` (`'websocket'`/`'polling'`/`'grpc'`/`'custom'`). Does not fetch or subscribe — call `subscribe()` next. */
	public constructor(config: UserConfig) {
		// Type-system guarantees at least one of the two is supplied.
		const velocityClient = config.velocityClient!;
		this.velocityClient = velocityClient;
		this.userAccountPublicKey = config.userAccountPublicKey;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingUserAccountSubscriber(
				velocityClient.connection,
				config.userAccountPublicKey,
				config.accountSubscription.accountLoader,
				(
					this.velocityClient.program.account as any
				).user.coder.accounts.decodeUnchecked.bind(
					(this.velocityClient.program.account as any).user.coder.accounts
				)
			);
		} else if (config.accountSubscription?.type === 'custom') {
			this.accountSubscriber = config.accountSubscription.userAccountSubscriber;
		} else if (config.accountSubscription?.type === 'grpc') {
			if (config.accountSubscription.grpcMultiUserAccountSubscriber) {
				this.accountSubscriber =
					config.accountSubscription.grpcMultiUserAccountSubscriber.forUser(
						config.userAccountPublicKey
					);
			} else {
				this.accountSubscriber = new grpcUserAccountSubscriber(
					config.accountSubscription.grpcConfigs,
					velocityClient.program,
					config.userAccountPublicKey,
					{
						resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
						logResubMessages: config.accountSubscription?.logResubMessages,
					}
				);
			}
		} else {
			if (
				config.accountSubscription?.type === 'websocket' &&
				config.accountSubscription?.programUserAccountSubscriber
			) {
				this.accountSubscriber = new WebSocketProgramUserAccountSubscriber(
					velocityClient.program,
					config.userAccountPublicKey,
					config.accountSubscription.programUserAccountSubscriber
				);
			} else {
				this.accountSubscriber = new WebSocketUserAccountSubscriber(
					velocityClient.program,
					config.userAccountPublicKey,
					{
						resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
						logResubMessages: config.accountSubscription?.logResubMessages,
					},
					config.accountSubscription?.commitment
				);
			}
		}
		this.eventEmitter = this.accountSubscriber.eventEmitter;
	}

	/**
	 * Subscribes to this `User` account (websocket/polling/gRPC/custom per
	 * `UserConfig.accountSubscription`) and awaits the initial account fetch.
	 * Must resolve before any `get*`/margin/PnL accessor is called — those
	 * throw `NotSubscribedError` until this has completed.
	 * @param userAccount Optional pre-fetched account to seed the subscriber with, skipping the initial RPC fetch.
	 * @returns True once the underlying subscriber reports subscribed.
	 */
	public async subscribe(userAccount?: UserAccount): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe(userAccount);
		return this.isSubscribed;
	}

	/** Forces the account subscriber to re-fetch the `User` account from RPC (bypassing any push/poll cadence). */
	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	/** Removes all event listeners and tears down the account subscription. */
	public async unsubscribe(): Promise<void> {
		this.eventEmitter.removeAllListeners();
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	/**
	 * Returns the cached user account.
	 *
	 * - **Throws** `NotSubscribedError` if the subscriber has not been subscribed
	 *   yet — reading the account before `subscribe()` resolves is a
	 *   programming error, not a missing-account condition.
	 * - Returns `undefined` when subscribed but no account was found on chain.
	 *   Because `subscribe()` awaits the initial fetch, an `undefined` here means
	 *   the account does not exist (or has not yet been observed), not that data
	 *   is "still loading".
	 */
	public getUserAccount(): UserAccount | undefined {
		return this.accountSubscriber.getUserAccountAndSlot()?.data;
	}

	/**
	 * Like `getUserAccount` but throws instead of returning `undefined`
	 * when the account was not found. Use at call sites that structurally
	 * require the account to exist. (Still propagates `NotSubscribedError` when
	 * called before subscribing.)
	 *
	 * Delegates to `getUserAccount` (rather than the subscriber directly)
	 * so callers that override `getUserAccount` see the override here too.
	 * @returns The current `UserAccount`.
	 */
	public getUserAccountOrThrow(): UserAccount {
		const userAccount = this.getUserAccount();
		if (!userAccount) {
			throw new Error(
				`User account not found: ${this.getUserAccountPublicKey().toString()}`
			);
		}
		return userAccount;
	}

	/**
	 * Bypasses the cached subscriber state and force-fetches the `User` account
	 * directly from the RPC (via `fetchAccounts`), then returns the freshly
	 * cached value. Useful right after sending a transaction, when the
	 * websocket/polling subscriber may not yet have observed the update.
	 * @returns The freshly fetched `UserAccount`, or `undefined` if the account does not exist on chain.
	 */
	public async forceGetUserAccount(): Promise<UserAccount | undefined> {
		await this.fetchAccounts();
		const account = this.accountSubscriber.getUserAccountAndSlot();
		return account?.data;
	}

	/**
	 * Returns the cached user account together with the slot at which it was
	 * last observed. Same `undefined`/`NotSubscribedError` contract as `getUserAccount`.
	 */
	public getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		return this.accountSubscriber.getUserAccountAndSlot();
	}

	/**
	 * Like `getUserAccountAndSlot` but throws instead of returning
	 * `undefined` when the account was not found. Use at call sites that
	 * structurally require the account to exist. (Still propagates
	 * `NotSubscribedError` when called before subscribing.)
	 */
	public getUserAccountAndSlotOrThrow(): DataAndSlot<UserAccount> {
		return assertDataAndSlot(
			this.accountSubscriber.getUserAccountAndSlot(),
			`User account not found: ${this.getUserAccountPublicKey().toString()}`
		);
	}

	/**
	 * Finds the perp position for `marketIndex` on an explicit `userAccount`
	 * snapshot rather than the cached account. Only matches "active" positions
	 * (see `getActivePerpPositionsForUserAccount`) — a market the user has never
	 * touched (or has fully closed and settled) returns `undefined` even though
	 * the on-chain array always has a fixed-size slot for every market.
	 * @param userAccount Account snapshot to search (does not have to be the subscribed account).
	 * @param marketIndex Perp market index to look up.
	 * @returns The matching `PerpPosition`, or `undefined` if the user has no active position in that market.
	 */
	public getPerpPositionForUserAccount(
		userAccount: UserAccount,
		marketIndex: number
	): PerpPosition | undefined {
		return this.getActivePerpPositionsForUserAccount(userAccount).find(
			(position) => position.marketIndex === marketIndex
		);
	}

	/**
	 * Gets the user's current position for a given perp market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userPerpPosition
	 */
	public getPerpPosition(marketIndex: number): PerpPosition | undefined {
		const userAccount = this.getUserAccountOrThrow();
		return this.getPerpPositionForUserAccount(userAccount, marketIndex);
	}

	/**
	 * Like `getPerpPosition`, but returns a zeroed-out placeholder position
	 * (see `getEmptyPosition`) instead of `undefined` when the user has no
	 * active position in `marketIndex`. Convenient for math helpers that need a
	 * `PerpPosition` shape unconditionally (e.g. buying-power/leverage calcs).
	 */
	public getPerpPositionOrEmpty(marketIndex: number): PerpPosition {
		const userAccount = this.getUserAccountOrThrow();
		return (
			this.getPerpPositionForUserAccount(userAccount, marketIndex) ??
			this.getEmptyPosition(marketIndex)
		);
	}

	/**
	 * Like `getPerpPosition`, but throws instead of returning `undefined` when
	 * the user has no active position in `marketIndex`.
	 */
	public getPerpPositionOrThrow(marketIndex: number): PerpPosition {
		const position = this.getPerpPosition(marketIndex);
		if (!position) {
			throw new Error(`No perp position found for market ${marketIndex}`);
		}
		return position;
	}

	/**
	 * Like `getPerpPosition`, but also returns the slot at which the underlying
	 * `UserAccount` was observed.
	 */
	public getPerpPositionAndSlot(
		marketIndex: number
	): DataAndSlot<PerpPosition | undefined> {
		const userAccount = this.getUserAccountAndSlotOrThrow();
		const perpPosition = this.getPerpPositionForUserAccount(
			userAccount.data,
			marketIndex
		);
		return {
			data: perpPosition,
			slot: userAccount.slot,
		};
	}

	/**
	 * Finds the spot position for `marketIndex` on an explicit `userAccount`
	 * snapshot. Unlike `getPerpPositionForUserAccount`, this does not filter to
	 * "active" positions first — it returns whatever fixed-size slot entry
	 * exists for that market index, even if the position is empty/available.
	 * @param userAccount Account snapshot to search (does not have to be the subscribed account).
	 * @param marketIndex Spot market index to look up.
	 */
	public getSpotPositionForUserAccount(
		userAccount: UserAccount,
		marketIndex: number
	): SpotPosition | undefined {
		return userAccount.spotPositions.find(
			(position) => position.marketIndex === marketIndex
		);
	}

	/**
	 * Gets the user's current position for a given spot market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userSpotPosition
	 */
	public getSpotPosition(marketIndex: number): SpotPosition | undefined {
		const userAccount = this.getUserAccountOrThrow();
		return this.getSpotPositionForUserAccount(userAccount, marketIndex);
	}

	/**
	 * Like `getSpotPosition`, but also returns the slot at which the underlying
	 * `UserAccount` was observed.
	 */
	public getSpotPositionAndSlot(
		marketIndex: number
	): DataAndSlot<SpotPosition | undefined> {
		const userAccount = this.getUserAccountAndSlotOrThrow();
		const spotPosition = this.getSpotPositionForUserAccount(
			userAccount.data,
			marketIndex
		);
		return {
			data: spotPosition,
			slot: userAccount.slot,
		};
	}

	/** Returns a zeroed-out (no deposit/borrow) placeholder `SpotPosition` for `marketIndex`. */
	getEmptySpotPosition(marketIndex: number): SpotPosition {
		return {
			marketIndex,
			scaledBalance: ZERO,
			balanceType: SpotBalanceType.DEPOSIT,
			cumulativeDeposits: ZERO,
			openAsks: ZERO,
			openBids: ZERO,
			openOrders: 0,
		};
	}

	/**
	 * Returns the token amount for a given market. The spot market precision is based on the token mint decimals.
	 * Positive if it is a deposit, negative if it is a borrow.
	 *
	 * @param marketIndex
	 * @returns Signed token amount, in the spot market's own token decimals (not QUOTE_PRECISION). `ZERO` if the user has no position in the market.
	 */
	public getTokenAmount(marketIndex: number): BN {
		const spotPosition = this.getSpotPosition(marketIndex);
		if (spotPosition === undefined) {
			return ZERO;
		}
		const spotMarket =
			this.velocityClient.getSpotMarketAccountOrThrow(marketIndex);
		return getSignedTokenAmount(
			getTokenAmount(
				spotPosition.scaledBalance,
				spotMarket,
				spotPosition.balanceType
			),
			spotPosition.balanceType
		);
	}

	/** Returns a zeroed-out placeholder `PerpPosition` for `marketIndex` (no size, no orders, cross margin). */
	public getEmptyPosition(marketIndex: number): PerpPosition {
		return {
			baseAssetAmount: ZERO,
			remainderBaseAssetAmount: 0,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			quoteEntryAmount: ZERO,
			quoteBreakEvenAmount: ZERO,
			openOrders: 0,
			openBids: ZERO,
			openAsks: ZERO,
			settledPnl: ZERO,
			maxMarginRatio: 0,
			isolatedPositionScaledBalance: ZERO,
			positionFlag: 0,
		};
	}

	/** Returns true if `position` has no size and no open orders (a market slot that can be treated as unused). */
	public isPositionEmpty(position: PerpPosition): boolean {
		return position.baseAssetAmount.eq(ZERO) && position.openOrders === 0;
	}

	/**
	 * Returns the isolated-margin quote deposit backing a given perp position,
	 * i.e. `PerpPosition.isolatedPositionScaledBalance` converted to a token
	 * amount. This is the collateral segregated to that single isolated
	 * position, separate from the user's cross-margin free collateral.
	 * @param perpMarketIndex
	 * @returns Quote token amount (the quote spot market's own decimals). `ZERO` if the user has no position or no isolated deposit in the market.
	 */
	public getIsolatePerpPositionTokenAmount(perpMarketIndex: number): BN {
		const perpPosition = this.getPerpPosition(perpMarketIndex);
		if (!perpPosition) return ZERO;
		const perpMarket =
			this.velocityClient.getPerpMarketAccountOrThrow(perpMarketIndex);
		const spotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
			perpMarket.quoteSpotMarketIndex
		);
		if (perpPosition === undefined) {
			return ZERO;
		}
		return getTokenAmount(
			perpPosition.isolatedPositionScaledBalance ?? ZERO, //TODO remove ? later
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
	}

	/**
	 * Returns the total USD value of deposits across all isolated perp positions.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	public getTotalIsolatedPositionDeposits(): BN {
		return this.getActivePerpPositions().reduce((total, perpPosition) => {
			if (!perpPosition.isolatedPositionScaledBalance?.gt(ZERO)) {
				return total;
			}

			const perpMarket = this.velocityClient.getPerpMarketAccountOrThrow(
				perpPosition.marketIndex
			);
			const quoteSpotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
				perpMarket.quoteSpotMarketIndex
			);
			const quoteOraclePriceData = this.getOracleDataForSpotMarket(
				perpMarket.quoteSpotMarketIndex
			);
			const strictOracle = new StrictOraclePrice(
				quoteOraclePriceData.price,
				quoteOraclePriceData.twap
			);

			const tokenAmount = getTokenAmount(
				perpPosition.isolatedPositionScaledBalance,
				quoteSpotMarket,
				SpotBalanceType.DEPOSIT
			);

			return total.add(
				getStrictTokenValue(tokenAmount, quoteSpotMarket.decimals, strictOracle)
			);
		}, ZERO);
	}

	/** Returns a shallow copy of `position`. Mutating the clone does not affect the cached account. */
	public getClonedPosition(position: PerpPosition): PerpPosition {
		const clonedPosition = Object.assign({}, position);
		return clonedPosition;
	}

	/** Finds an order by its program-assigned `orderId` on an explicit `userAccount` snapshot. */
	public getOrderForUserAccount(
		userAccount: UserAccount,
		orderId: number
	): Order | undefined {
		return userAccount.orders.find((order) => order.orderId === orderId);
	}

	/**
	 * Finds an order in the cached `UserAccount` by its program-assigned `orderId`.
	 * @param orderId
	 * @returns The matching `Order`, or `undefined` if no order with that id exists.
	 */
	public getOrder(orderId: number): Order | undefined {
		const userAccount = this.getUserAccountOrThrow();
		return this.getOrderForUserAccount(userAccount, orderId);
	}

	/** Like `getOrder`, but also returns the slot at which the underlying `UserAccount` was observed. */
	public getOrderAndSlot(orderId: number): DataAndSlot<Order | undefined> {
		const userAccount = this.getUserAccountAndSlotOrThrow();
		const order = this.getOrderForUserAccount(userAccount.data, orderId);
		return {
			data: order,
			slot: userAccount.slot,
		};
	}

	/**
	 * Finds an order by its caller-assigned `userOrderId` (a client-chosen tag,
	 * distinct from the program-assigned `orderId`) on an explicit `userAccount`
	 * snapshot.
	 */
	public getOrderByUserIdForUserAccount(
		userAccount: UserAccount,
		userOrderId: number
	): Order | undefined {
		return userAccount.orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	/**
	 * Finds an order in the cached `UserAccount` by its caller-assigned
	 * `userOrderId` (a client-chosen tag, distinct from the program-assigned `orderId`).
	 * @param userOrderId
	 * @returns The matching `Order`, or `undefined` if no order with that tag exists.
	 */
	public getOrderByUserOrderId(userOrderId: number): Order | undefined {
		const userAccount = this.getUserAccountOrThrow();
		return this.getOrderByUserIdForUserAccount(userAccount, userOrderId);
	}

	/** Like `getOrderByUserOrderId`, but also returns the slot at which the underlying `UserAccount` was observed. */
	public getOrderByUserOrderIdAndSlot(
		userOrderId: number
	): DataAndSlot<Order | undefined> {
		const userAccount = this.getUserAccountAndSlotOrThrow();
		const order = this.getOrderByUserIdForUserAccount(
			userAccount.data,
			userOrderId
		);
		return {
			data: order,
			slot: userAccount.slot,
		};
	}

	/**
	 * Filters an explicit `userAccount` snapshot's orders down to those with
	 * `OrderStatus.Open`.
	 * @returns `undefined` if `userAccount` is `undefined` (i.e. no account loaded), otherwise the array of open orders (possibly empty).
	 */
	public getOpenOrdersForUserAccount(
		userAccount?: UserAccount
	): Order[] | undefined {
		return userAccount?.orders.filter((order) =>
			isVariant(order.status, 'open')
		);
	}

	/** Returns all of the user's orders with `OrderStatus.Open`. Empty array (not `undefined`) if there are none or no account is loaded. */
	public getOpenOrders(): Order[] {
		const userAccount = this.getUserAccount();
		return this.getOpenOrdersForUserAccount(userAccount) ?? [];
	}

	/** Like `getOpenOrders`, but also returns the slot at which the underlying `UserAccount` was observed. */
	public getOpenOrdersAndSlot(): DataAndSlot<Order[]> {
		const userAccount = this.getUserAccountAndSlotOrThrow();
		const openOrders = this.getOpenOrdersForUserAccount(userAccount.data) ?? [];
		return {
			data: openOrders,
			slot: userAccount.slot,
		};
	}

	/** Returns this `User`'s account address (does not require the account to be subscribed or to exist on chain). */
	public getUserAccountPublicKey(): PublicKey {
		return this.userAccountPublicKey;
	}

	/** Checks directly via RPC (bypassing the subscriber cache) whether the `User` account exists on chain. */
	public async exists(): Promise<boolean> {
		const userAccountRPCResponse =
			await this.velocityClient.connection.getParsedAccountInfo(
				this.userAccountPublicKey
			);
		return userAccountRPCResponse.value !== null;
	}

	/**
	 * Returns the position's total resting open-order bid/ask size in a perp market.
	 * @param marketIndex
	 * @returns Tuple of `[openBids, openAsks]`, both `BASE_PRECISION` (1e9). Throws (via `getPerpPositionOrThrow`) if the user has no active position in `marketIndex`.
	 */
	public getPerpBidAsks(marketIndex: number): [BN, BN] {
		const position = this.getPerpPositionOrThrow(marketIndex);

		const totalOpenBids = position.openBids;
		const totalOpenAsks = position.openAsks;

		return [totalOpenBids, totalOpenAsks];
	}

	/**
	 * calculates Buying Power = free collateral / initial margin ratio
	 *
	 * For `positionType: 'isolated'`, the buying power is capped by the
	 * lesser of (a) the user's cross free collateral and (b) the free quote
	 * asset value in the perp's quote spot market — mirroring that an isolated
	 * position can only draw down as much quote collateral as is actually
	 * available to isolate into it.
	 * @param marketIndex Perp market to size buying power for.
	 * @param collateralBuffer Amount (QUOTE_PRECISION) subtracted from free collateral before sizing, e.g. to reserve for fees. Defaults to zero.
	 * @param maxMarginRatio Optional override for the max margin ratio component (see `resolveMaxMarginRatio`); defaults to the position's/user's configured ratio.
	 * @param positionType Whether to size for a cross or isolated-margin position. Defaults to `'cross'`.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	public getPerpBuyingPower(
		marketIndex: number,
		collateralBuffer = ZERO,
		maxMarginRatio: number | undefined = undefined,
		positionType: 'isolated' | 'cross' = 'cross'
	): BN {
		const perpPosition = this.getPerpPositionOrEmpty(marketIndex);

		const perpMarket =
			this.velocityClient.getPerpMarketAccountOrThrow(marketIndex);
		const oraclePriceData = this.getOracleDataForPerpMarket(marketIndex);
		const worstCaseBaseAssetAmount = perpPosition
			? calculateWorstCaseBaseAssetAmount(
					perpPosition,
					perpMarket,
					oraclePriceData.price
			  )
			: ZERO;

		// if position is isolated, we always add on available quote from the cross account
		let freeCollateral: BN = ZERO;
		if (positionType === 'isolated') {
			const {
				totalAssetValue: quoteSpotMarketAssetValue,
				totalLiabilityValue: quoteSpotMarketLiabilityValue,
			} = this.getSpotMarketAssetAndLiabilityValue(
				perpMarket.quoteSpotMarketIndex,
				'Initial',
				undefined,
				undefined,
				true
			);

			const usdcAvailableForIsolatedMargin = quoteSpotMarketAssetValue.sub(
				quoteSpotMarketLiabilityValue
			);
			const generalFreeCollateral = this.getFreeCollateral(
				'Initial',
				undefined
			);
			freeCollateral = BN.min(
				usdcAvailableForIsolatedMargin,
				generalFreeCollateral
			).sub(collateralBuffer);
		} else {
			// free collateral from the cross account only
			freeCollateral = this.getFreeCollateral('Initial', undefined).sub(
				collateralBuffer
			);
		}

		return this.getPerpBuyingPowerFromFreeCollateralAndBaseAssetAmount(
			marketIndex,
			freeCollateral,
			worstCaseBaseAssetAmount,
			maxMarginRatio || perpPosition.maxMarginRatio
		);
	}

	private resolveMaxMarginRatio(perpMarketMaxMarginRatio?: number): number {
		// 0 means "no custom margin ratio override", so Math.max returns
		// userAccount.maxMarginRatio unchanged — the expected semantic.
		return Math.max(
			perpMarketMaxMarginRatio ?? 0,
			this.getUserAccountOrThrow().maxMarginRatio
		);
	}

	/**
	 * Converts a free-collateral amount directly into buying power for a perp
	 * market, given the (hypothetical) resulting base position size — used
	 * internally so the margin ratio (which can vary with position size via the
	 * IMF factor) reflects the post-trade size rather than the current size.
	 * @param marketIndex
	 * @param freeCollateral QUOTE_PRECISION (1e6).
	 * @param baseAssetAmount Base size, BASE_PRECISION (1e9), used only to select the applicable margin ratio.
	 * @param perpMarketMaxMarginRatio Optional max-margin-ratio override, see `resolveMaxMarginRatio`.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	getPerpBuyingPowerFromFreeCollateralAndBaseAssetAmount(
		marketIndex: number,
		freeCollateral: BN,
		baseAssetAmount: BN,
		perpMarketMaxMarginRatio: number | undefined = undefined
	): BN {
		const maxMarginRatio = this.resolveMaxMarginRatio(perpMarketMaxMarginRatio);
		const marginRatio = calculateMarketMarginRatio(
			this.velocityClient.getPerpMarketAccountOrThrow(marketIndex),
			baseAssetAmount,
			'Initial',
			maxMarginRatio
		);

		return freeCollateral.mul(MARGIN_PRECISION).div(new BN(marginRatio));
	}

	/**
	 * calculates Free Collateral = Total collateral - margin requirement
	 *
	 * When `perpMarketIndex` is provided, returns the free collateral scoped to
	 * that market's isolated margin bucket (the isolated quote deposit plus its
	 * unrealized PnL, minus its own margin requirement) rather than the user's
	 * cross-margin free collateral. If the user has no isolated position open in
	 * that market, returns `ZERO` rather than throwing.
	 * @param marginCategory `'Initial'` or `'Maintenance'`. Defaults to `'Initial'`; `'Initial'` also enables strict (TWAP-bounded) oracle pricing.
	 * @param perpMarketIndex Optional isolated perp market to scope the calculation to; omit for cross margin.
	 * @returns Precision QUOTE_PRECISION (1e6). Can be negative (deficit).
	 */
	public getFreeCollateral(
		marginCategory: MarginCategory = 'Initial',
		perpMarketIndex?: number
	): BN {
		const calc = this.getMarginCalculation(marginCategory, {
			strict: marginCategory === 'Initial',
		});

		if (perpMarketIndex !== undefined) {
			// getIsolatedFreeCollateral will throw if no existing isolated position but we are fetching for potential new position, so we wrap in a try/catch
			try {
				return calc.getIsolatedFreeCollateral(perpMarketIndex);
			} catch (error) {
				return ZERO;
			}
		} else {
			return calc.getCrossFreeCollateral();
		}
	}

	/**
	 * @deprecated Use the overload that includes { marginType, perpMarketIndex }
	 */
	public getMarginRequirement(
		marginCategory: MarginCategory,
		liquidationBuffer?: BN,
		strict?: boolean,
		includeOpenOrders?: boolean
	): BN;

	/**
	 * Calculates the margin requirement based on the specified parameters.
	 *
	 * When `perpMarketIndex` is passed, returns the isolated margin requirement
	 * for that market's isolated position only (`ZERO` if none exists) rather
	 * than the cross-margin requirement. `liquidationBuffer`, when non-zero,
	 * selects the buffered variant (`marginRequirementPlusBuffer` /
	 * `MarginContext.liquidation`), which pads the requirement to build in the
	 * state account's `liquidationMarginBufferRatio` — the same buffer keepers
	 * apply so a position doesn't get flagged for liquidation and immediately
	 * clear again.
	 *
	 * @param marginCategory - The category of margin to calculate ('Initial' or 'Maintenance').
	 * @param liquidationBuffer - Optional buffer amount (MARGIN_PRECISION, 1e4, added to the margin ratio) to consider during liquidation scenarios.
	 * @param strict - Optional flag to enforce strict (TWAP-bounded) oracle pricing.
	 * @param includeOpenOrders - Optional flag to include open orders' worst-case margin impact.
	 * @param perpMarketIndex - Optional index of the perpetual market. Scopes the result to that market's isolated position.
	 *
	 * @returns The calculated margin requirement, QUOTE_PRECISION (1e6).
	 */
	public getMarginRequirement(
		marginCategory: MarginCategory,
		liquidationBuffer?: BN,
		strict?: boolean,
		includeOpenOrders?: boolean,
		perpMarketIndex?: number
	): BN;

	public getMarginRequirement(
		marginCategory: MarginCategory,
		liquidationBuffer?: BN,
		strict?: boolean,
		includeOpenOrders?: boolean,
		perpMarketIndex?: number
	): BN {
		const liquidationBufferMap = new Map();
		if (liquidationBuffer && perpMarketIndex !== undefined) {
			liquidationBufferMap.set(perpMarketIndex, liquidationBuffer);
		} else if (liquidationBuffer) {
			liquidationBufferMap.set('cross', liquidationBuffer);
		}

		const marginCalc = this.getMarginCalculation(marginCategory, {
			strict,
			includeOpenOrders,
			liquidationBufferMap,
		});

		// If perpMarketIndex is provided, compute only for that market index
		if (perpMarketIndex !== undefined) {
			const isolatedMarginCalculation =
				marginCalc.isolatedMarginCalculations.get(perpMarketIndex);
			if (!isolatedMarginCalculation) return ZERO;
			const { marginRequirement, marginRequirementPlusBuffer } =
				isolatedMarginCalculation;

			if (liquidationBuffer?.gt(ZERO)) {
				return marginRequirementPlusBuffer;
			}
			return marginRequirement;
		}

		// Default: Cross margin requirement
		if (liquidationBuffer?.gt(ZERO)) {
			return marginCalc.marginRequirementPlusBuffer;
		}
		return marginCalc.marginRequirement;
	}

	/**
	 * Initial margin requirement — the collateral needed to open/maintain a
	 * position at initial (as opposed to maintenance) margin ratios, using
	 * strict (TWAP-bounded) oracle pricing. This is what gates new orders and
	 * increases in leverage.
	 * @param perpMarketIndex Optional isolated perp market to scope to; omit for the cross-margin requirement.
	 * @returns The initial margin requirement in USDC. : QUOTE_PRECISION (1e6)
	 */
	public getInitialMarginRequirement(perpMarketIndex?: number): BN {
		return this.getMarginRequirement(
			'Initial',
			undefined,
			true,
			undefined,
			perpMarketIndex
		);
	}

	/**
	 * Maintenance margin requirement — the minimum collateral below which the
	 * position becomes eligible for liquidation. Uses non-strict oracle pricing
	 * and includes open orders' worst-case impact by default.
	 * @param liquidationBuffer Optional buffer (MARGIN_PRECISION, 1e4) added to the margin ratio, mirroring the state account's `liquidationMarginBufferRatio`.
	 * @param perpMarketIndex Optional isolated perp market to scope to; omit for the cross-margin requirement.
	 * @returns The maintenance margin requirement in USDC. : QUOTE_PRECISION (1e6)
	 */
	public getMaintenanceMarginRequirement(
		liquidationBuffer?: BN,
		perpMarketIndex?: number
	): BN {
		return this.getMarginRequirement(
			'Maintenance',
			liquidationBuffer,
			false, // strict default
			true, // includeOpenOrders default
			perpMarketIndex
		);
	}

	/**
	 * Filters an explicit `userAccount` snapshot's fixed-size perp position
	 * array down to slots that are actually "active": nonzero base or quote
	 * amount, an outstanding open order count, or a nonzero isolated-margin
	 * quote deposit (a position can be flat but still isolated-funded).
	 */
	public getActivePerpPositionsForUserAccount(
		userAccount: UserAccount
	): PerpPosition[] {
		return userAccount.perpPositions.filter(
			(pos) =>
				!pos.baseAssetAmount.eq(ZERO) ||
				!pos.quoteAssetAmount.eq(ZERO) ||
				!(pos.openOrders == 0) ||
				pos.isolatedPositionScaledBalance?.gt(ZERO)
		);
	}

	/** Returns the cached account's active perp positions. See `getActivePerpPositionsForUserAccount` for the activity criteria. */
	public getActivePerpPositions(): PerpPosition[] {
		const userAccount = this.getUserAccountOrThrow();
		return this.getActivePerpPositionsForUserAccount(userAccount);
	}
	/** Like `getActivePerpPositions`, but also returns the slot at which the underlying `UserAccount` was observed. */
	public getActivePerpPositionsAndSlot(): DataAndSlot<PerpPosition[]> {
		const userAccount = this.getUserAccountAndSlotOrThrow();
		const positions = this.getActivePerpPositionsForUserAccount(
			userAccount.data
		);
		return {
			data: positions,
			slot: userAccount.slot,
		};
	}

	/** Filters an explicit `userAccount` snapshot's spot positions to those that are not `isSpotPositionAvailable` (i.e. have a nonzero balance, orders, or cumulative deposits). */
	public getActiveSpotPositionsForUserAccount(
		userAccount: UserAccount
	): SpotPosition[] {
		return userAccount.spotPositions.filter(
			(pos) => !isSpotPositionAvailable(pos)
		);
	}

	/** Returns the cached account's active spot positions. See `getActiveSpotPositionsForUserAccount` for the activity criteria. */
	public getActiveSpotPositions(): SpotPosition[] {
		const userAccount = this.getUserAccountOrThrow();
		return this.getActiveSpotPositionsForUserAccount(userAccount);
	}
	/** Like `getActiveSpotPositions`, but also returns the slot at which the underlying `UserAccount` was observed. */
	public getActiveSpotPositionsAndSlot(): DataAndSlot<SpotPosition[]> {
		const userAccount = this.getUserAccountAndSlotOrThrow();
		const positions = this.getActiveSpotPositionsForUserAccount(
			userAccount.data
		);
		return {
			data: positions,
			slot: userAccount.slot,
		};
	}

	/**
	 * Calculates unrealized position price PnL, summed across all active perp
	 * positions (or a single one if `marketIndex` is given).
	 *
	 * When `withWeightMarginCategory` is supplied, the PnL is asset-weighted
	 * for margin purposes: profitable positions are scaled down by
	 * `calculateUnrealizedAssetWeight` (an unrealized gain is a less-trusted
	 * asset than settled collateral), and — for `'Initial'` margin specifically
	 * — the *per-position* weighted gain is additionally capped at
	 * `MAX_POSITIVE_UPNL_FOR_INITIAL_MARGIN` (**$100**, QUOTE_PRECISION), a
	 * safety guard against a single dangerously-configured or manipulated
	 * market inflating buying power. Losses are never capped, and a
	 * `liquidationBuffer` (if provided) further inflates negative PnL to
	 * mirror the on-chain liquidation-buffer treatment.
	 * @param withFunding If true, includes unsettled funding in each position's PnL.
	 * @param marketIndex Optional single perp market to scope to; omit to sum across all active positions.
	 * @param withWeightMarginCategory Optional `'Initial'` or `'Maintenance'` — applies the asset-weighting (and, for `'Initial'`, the $100-per-position cap) described above. Omit for raw, unweighted PnL.
	 * @param strict Use the worse of live oracle price vs 5-minute TWAP per position (gains use the lower price, losses use the higher price). Defaults to false.
	 * @param liquidationBuffer Optional buffer (MARGIN_PRECISION, 1e4) that further penalizes negative PnL; only applied when `withWeightMarginCategory` is set.
	 * @returns : Precision QUOTE_PRECISION (1e6)
	 */
	public getUnrealizedPNL(
		withFunding?: boolean,
		marketIndex?: number,
		withWeightMarginCategory?: MarginCategory,
		strict = false,
		liquidationBuffer?: BN
	): BN {
		return this.getActivePerpPositions()
			.filter((pos) =>
				marketIndex !== undefined ? pos.marketIndex === marketIndex : true
			)
			.reduce((unrealizedPnl, perpPosition) => {
				const market = this.velocityClient.getPerpMarketAccountOrThrow(
					perpPosition.marketIndex
				);
				const oraclePriceData = this.getMMOracleDataForPerpMarket(
					market.marketIndex
				);

				const quoteSpotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
					market.quoteSpotMarketIndex
				);
				const quoteOraclePriceData = this.getOracleDataForSpotMarket(
					market.quoteSpotMarketIndex
				);

				let positionUnrealizedPnl = calculatePositionPNL(
					market,
					perpPosition,
					withFunding,
					oraclePriceData
				);

				let quotePrice;
				if (strict && positionUnrealizedPnl.gt(ZERO)) {
					quotePrice = BN.min(
						quoteOraclePriceData.price,
						quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
					);
				} else if (strict && positionUnrealizedPnl.lt(ZERO)) {
					quotePrice = BN.max(
						quoteOraclePriceData.price,
						quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
					);
				} else {
					quotePrice = quoteOraclePriceData.price;
				}

				positionUnrealizedPnl = positionUnrealizedPnl
					.mul(quotePrice)
					.div(PRICE_PRECISION);

				if (withWeightMarginCategory !== undefined) {
					if (positionUnrealizedPnl.gt(ZERO)) {
						positionUnrealizedPnl = positionUnrealizedPnl
							.mul(
								calculateUnrealizedAssetWeight(
									market,
									quoteSpotMarket,
									positionUnrealizedPnl,
									withWeightMarginCategory,
									oraclePriceData
								)
							)
							.div(new BN(SPOT_MARKET_WEIGHT_PRECISION));
					}

					if (withWeightMarginCategory === 'Initial') {
						// safety guard for dangerously configured perp market
						positionUnrealizedPnl = BN.min(
							positionUnrealizedPnl,
							MAX_POSITIVE_UPNL_FOR_INITIAL_MARGIN
						);
					}

					if (liquidationBuffer && positionUnrealizedPnl.lt(ZERO)) {
						positionUnrealizedPnl = positionUnrealizedPnl.add(
							positionUnrealizedPnl.mul(liquidationBuffer).div(MARGIN_PRECISION)
						);
					}
				}

				return unrealizedPnl.add(positionUnrealizedPnl);
			}, ZERO);
	}

	/**
	 * Calculates unrealized funding payment PnL — the funding accrued since
	 * each position's `lastCumulativeFundingRate` was last settled, not yet
	 * reflected in `quoteAssetAmount`.
	 * @param marketIndex Optional single perp market to scope to; omit to sum across all positions.
	 * @returns : Precision QUOTE_PRECISION (1e6)
	 */
	public getUnrealizedFundingPNL(marketIndex?: number): BN {
		return this.getUserAccountOrThrow()
			.perpPositions.filter((pos) =>
				marketIndex !== undefined ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, perpPosition) => {
				const market = this.velocityClient.getPerpMarketAccountOrThrow(
					perpPosition.marketIndex
				);
				return pnl.add(calculateUnsettledFundingPnl(market, perpPosition));
			}, ZERO);
	}

	/**
	 * Computes the combined weighted asset value and weighted liability value
	 * across the user's spot positions (worst-case, including open-order
	 * exposure by default), plus the net quote balance. This is the core spot
	 * side of the margin system that `getTotalCollateral`/`getMarginRequirement`
	 * build on.
	 * @param marketIndex Optional single spot market to scope to; omit to sum across all spot markets.
	 * @param marginCategory `'Initial'` or `'Maintenance'` asset/liability weights; omit for unweighted (100%) values.
	 * @param liquidationBuffer Optional buffer (MARGIN_PRECISION, 1e4) added to the liability weight side.
	 * @param includeOpenOrders If false, ignores open bids/asks and only counts the current balance (faster, less conservative).
	 * @param strict Use the worse of live oracle price vs 5-minute TWAP. Defaults to false.
	 * @param now Unix timestamp (seconds) used for TWAP staleness when `strict` is set; defaults to current time.
	 * @returns `{ totalAssetValue, totalLiabilityValue }`, both QUOTE_PRECISION (1e6) and non-negative.
	 */
	public getSpotMarketAssetAndLiabilityValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): { totalAssetValue: BN; totalLiabilityValue: BN } {
		now = now || new BN(new Date().getTime() / 1000);
		let netQuoteValue = ZERO;
		let totalAssetValue = ZERO;
		let totalLiabilityValue = ZERO;
		for (const spotPosition of this.getUserAccountOrThrow().spotPositions) {
			const countForBase =
				marketIndex === undefined || spotPosition.marketIndex === marketIndex;

			const countForQuote =
				marketIndex === undefined ||
				marketIndex === QUOTE_SPOT_MARKET_INDEX ||
				(includeOpenOrders && spotPosition.openOrders !== 0);
			if (
				isSpotPositionAvailable(spotPosition) ||
				(!countForBase && !countForQuote)
			) {
				continue;
			}

			const spotMarketAccount: SpotMarketAccount =
				this.velocityClient.getSpotMarketAccountOrThrow(
					spotPosition.marketIndex
				);

			const oraclePriceData = this.getOracleDataForSpotMarket(
				spotPosition.marketIndex
			);

			let twap5min;
			if (strict) {
				twap5min = calculateLiveOracleTwap(
					spotMarketAccount.historicalOracleData,
					oraclePriceData,
					now,
					FIVE_MINUTE // 5MIN
				);
			}
			const strictOraclePrice = new StrictOraclePrice(
				oraclePriceData.price,
				twap5min
			);

			if (
				spotPosition.marketIndex === QUOTE_SPOT_MARKET_INDEX &&
				countForQuote
			) {
				const tokenAmount = getSignedTokenAmount(
					getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketAccount,
						spotPosition.balanceType
					),
					spotPosition.balanceType
				);

				if (isVariant(spotPosition.balanceType, 'borrow')) {
					const weightedTokenValue = this.getSpotLiabilityValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory,
						liquidationBuffer
					).abs();

					netQuoteValue = netQuoteValue.sub(weightedTokenValue);
				} else {
					const weightedTokenValue = this.getSpotAssetValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory
					);

					netQuoteValue = netQuoteValue.add(weightedTokenValue);
				}

				continue;
			}

			if (!includeOpenOrders && countForBase) {
				if (isVariant(spotPosition.balanceType, 'borrow')) {
					const tokenAmount = getSignedTokenAmount(
						getTokenAmount(
							spotPosition.scaledBalance,
							spotMarketAccount,
							spotPosition.balanceType
						),
						SpotBalanceType.BORROW
					);
					const liabilityValue = this.getSpotLiabilityValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory,
						liquidationBuffer
					).abs();
					totalLiabilityValue = totalLiabilityValue.add(liabilityValue);

					continue;
				} else {
					const tokenAmount = getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketAccount,
						spotPosition.balanceType
					);
					const assetValue = this.getSpotAssetValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory
					);
					totalAssetValue = totalAssetValue.add(assetValue);

					continue;
				}
			}

			const {
				tokenAmount: worstCaseTokenAmount,
				ordersValue: worstCaseQuoteTokenAmount,
			} = getWorstCaseTokenAmounts(
				spotPosition,
				spotMarketAccount,
				strictOraclePrice,
				marginCategory,
				this.getUserAccountOrThrow().maxMarginRatio
			);

			if (worstCaseTokenAmount.gt(ZERO) && countForBase) {
				const baseAssetValue = this.getSpotAssetValue(
					worstCaseTokenAmount,
					strictOraclePrice,
					spotMarketAccount,
					marginCategory
				);

				totalAssetValue = totalAssetValue.add(baseAssetValue);
			}

			if (worstCaseTokenAmount.lt(ZERO) && countForBase) {
				const baseLiabilityValue = this.getSpotLiabilityValue(
					worstCaseTokenAmount,
					strictOraclePrice,
					spotMarketAccount,
					marginCategory,
					liquidationBuffer
				).abs();

				totalLiabilityValue = totalLiabilityValue.add(baseLiabilityValue);
			}

			if (worstCaseQuoteTokenAmount.gt(ZERO) && countForQuote) {
				netQuoteValue = netQuoteValue.add(worstCaseQuoteTokenAmount);
			}

			if (worstCaseQuoteTokenAmount.lt(ZERO) && countForQuote) {
				let weight = SPOT_MARKET_WEIGHT_PRECISION;
				if (marginCategory === 'Initial') {
					weight = BN.max(
						weight,
						new BN(this.getUserAccountOrThrow().maxMarginRatio)
					);
				}

				const weightedTokenValue = worstCaseQuoteTokenAmount
					.abs()
					.mul(weight)
					.div(SPOT_MARKET_WEIGHT_PRECISION);

				netQuoteValue = netQuoteValue.sub(weightedTokenValue);
			}

			totalLiabilityValue = totalLiabilityValue.add(
				new BN(spotPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
			);
		}

		if (marketIndex === undefined || marketIndex === QUOTE_SPOT_MARKET_INDEX) {
			if (netQuoteValue.gt(ZERO)) {
				totalAssetValue = totalAssetValue.add(netQuoteValue);
			} else {
				totalLiabilityValue = totalLiabilityValue.add(netQuoteValue.abs());
			}
		}

		return { totalAssetValue, totalLiabilityValue };
	}

	/** Convenience wrapper around `getSpotMarketAssetAndLiabilityValue` returning only `totalLiabilityValue`. See that method for parameter semantics. Returns QUOTE_PRECISION (1e6). */
	public getSpotMarketLiabilityValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		const { totalLiabilityValue } = this.getSpotMarketAssetAndLiabilityValue(
			marketIndex,
			marginCategory,
			liquidationBuffer,
			includeOpenOrders,
			strict,
			now
		);
		return totalLiabilityValue;
	}

	/** Thin wrapper around the `math/spotBalance` `getSpotLiabilityValue` helper that supplies the user's `maxMarginRatio`. Returns QUOTE_PRECISION (1e6), negative. */
	getSpotLiabilityValue(
		tokenAmount: BN,
		strictOraclePrice: StrictOraclePrice,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN
	): BN {
		return getSpotLiabilityValue(
			tokenAmount,
			strictOraclePrice,
			spotMarketAccount,
			this.getUserAccountOrThrow().maxMarginRatio,
			marginCategory,
			liquidationBuffer
		);
	}

	/** Convenience wrapper around `getSpotMarketAssetAndLiabilityValue` returning only `totalAssetValue`. See that method for parameter semantics. Returns QUOTE_PRECISION (1e6), non-negative. */
	public getSpotMarketAssetValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		const { totalAssetValue } = this.getSpotMarketAssetAndLiabilityValue(
			marketIndex,
			marginCategory,
			undefined,
			includeOpenOrders,
			strict,
			now
		);
		return totalAssetValue;
	}

	/** Thin wrapper around the `math/spotBalance` `getSpotAssetValue` helper that supplies the user's `maxMarginRatio`. Returns QUOTE_PRECISION (1e6), non-negative. */
	getSpotAssetValue(
		tokenAmount: BN,
		strictOraclePrice: StrictOraclePrice,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory
	): BN {
		return getSpotAssetValue(
			tokenAmount,
			strictOraclePrice,
			spotMarketAccount,
			this.getUserAccountOrThrow().maxMarginRatio,
			marginCategory
		);
	}

	/** Net spot value (`totalAssetValue - totalLiabilityValue`) for a single spot market. See `getSpotMarketAssetAndLiabilityValue` for parameter semantics. Returns QUOTE_PRECISION (1e6), can be negative. */
	public getSpotPositionValue(
		marketIndex: number,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		const { totalAssetValue, totalLiabilityValue } =
			this.getSpotMarketAssetAndLiabilityValue(
				marketIndex,
				marginCategory,
				undefined,
				includeOpenOrders,
				strict,
				now
			);

		return totalAssetValue.sub(totalLiabilityValue);
	}

	/**
	 * Net spot value (`totalAssetValue - totalLiabilityValue`) across all spot
	 * markets combined.
	 * @param withWeightMarginCategory Optional `'Initial'`/`'Maintenance'` weighting; omit for unweighted values.
	 * @returns Precision QUOTE_PRECISION (1e6), can be negative.
	 */
	public getNetSpotMarketValue(withWeightMarginCategory?: MarginCategory): BN {
		const { totalAssetValue, totalLiabilityValue } =
			this.getSpotMarketAssetAndLiabilityValue(
				undefined,
				withWeightMarginCategory
			);

		return totalAssetValue.sub(totalLiabilityValue);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	/**
	 * Calculates Total Collateral: net spot collateral value plus weighted
	 * unrealized perp PnL (see `getUnrealizedPNL`'s `$100`-per-position cap
	 * under `'Initial'` margin). This is the numerator side of the margin
	 * system; `getFreeCollateral`/`getMarginRequirement` are derived from it.
	 *
	 * When `perpMarketIndex` is provided, returns the isolated total collateral
	 * for that market's isolated position bucket instead of the cross-margin
	 * total — and **throws** if the user has no isolated margin calculation for
	 * that market (unlike `getFreeCollateral`, which swallows the same case and
	 * returns `ZERO`).
	 * @param marginCategory `'Initial'` or `'Maintenance'`. Defaults to `'Initial'`.
	 * @param strict Use TWAP-bounded oracle pricing. Defaults to false.
	 * @param includeOpenOrders Include open orders' worst-case impact. Defaults to true.
	 * @param liquidationBuffer Optional buffer (MARGIN_PRECISION, 1e4); selects the buffered collateral variant when non-zero.
	 * @param perpMarketIndex Optional isolated perp market to scope to.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	public getTotalCollateral(
		marginCategory: MarginCategory = 'Initial',
		strict = false,
		includeOpenOrders = true,
		liquidationBuffer?: BN,
		perpMarketIndex?: number
	): BN {
		const liquidationBufferMap = (() => {
			if (liquidationBuffer && perpMarketIndex !== undefined) {
				return new Map([[perpMarketIndex, liquidationBuffer]]);
			} else if (liquidationBuffer) {
				return new Map([['cross', liquidationBuffer]]);
			}
			return new Map();
		})();
		const marginCalc = this.getMarginCalculation(marginCategory, {
			strict,
			includeOpenOrders,
			liquidationBufferMap,
		});

		if (perpMarketIndex !== undefined) {
			const isolatedMarginCalculation =
				marginCalc.isolatedMarginCalculations.get(perpMarketIndex);
			if (!isolatedMarginCalculation) {
				throw new Error(
					`No isolated margin calculation for perp market ${perpMarketIndex}`
				);
			}
			const { totalCollateral, totalCollateralBuffer } =
				isolatedMarginCalculation;
			if (liquidationBuffer?.gt(ZERO)) {
				return totalCollateralBuffer;
			}
			return totalCollateral;
		}

		if (liquidationBuffer?.gt(ZERO)) {
			return marginCalc.totalCollateralBuffer;
		}
		return marginCalc.totalCollateral;
	}

	/**
	 * Builds the liquidation-buffer map to pass into margin calculations while
	 * a liquidation is in progress: `'cross'` is set to the state account's
	 * `liquidationMarginBufferRatio` if cross margin is being liquidated, and
	 * each isolated perp position currently flagged `BeingLiquidated` or
	 * `Bankruptcy` gets the same buffer under its market index. Positions not
	 * currently being liquidated are omitted (no buffer applied).
	 * @returns Map from `'cross'` or a perp market index to the buffer amount (MARGIN_PRECISION, 1e4).
	 */
	public getLiquidationBuffer(): Map<number | 'cross', BN> {
		const liquidationBufferMap = new Map<number | 'cross', BN>();
		if (this.isBeingLiquidated()) {
			liquidationBufferMap.set(
				'cross',
				new BN(
					this.velocityClient.getStateAccount().liquidationMarginBufferRatio
				)
			);
		}
		for (const position of this.getActivePerpPositions()) {
			if (
				position.positionFlag &
				(PositionFlag.BeingLiquidated | PositionFlag.Bankruptcy)
			) {
				liquidationBufferMap.set(
					position.marketIndex,
					new BN(
						this.velocityClient.getStateAccount().liquidationMarginBufferRatio
					)
				);
			}
		}
		return liquidationBufferMap;
	}

	/**
	 * Calculates a user's health score by comparing total collateral against
	 * the maintenance margin requirement: `100 * (1 - maintenanceMarginReq / totalCollateral)`,
	 * clamped to `[0, 100]` and rounded to the nearest integer. `100` means no
	 * maintenance requirement (or a requirement of zero with non-negative
	 * collateral); `0` means at or past the maintenance threshold (liquidatable)
	 * or that collateral is non-positive.
	 *
	 * Short-circuits to `0` if the relevant scope is already flagged as being
	 * liquidated: cross margin via `isCrossMarginBeingLiquidated` (when
	 * `perpMarketIndex` is omitted), or the specific isolated position via
	 * `isIsolatedPositionBeingLiquidated` (when `perpMarketIndex` is given).
	 * @param perpMarketIndex Optional isolated perp market to scope health to; omit for the cross-margin account's health.
	 * @returns Health, an integer in `[0, 100]`.
	 */
	public getHealth(perpMarketIndex?: number): number {
		if (this.isCrossMarginBeingLiquidated() && !perpMarketIndex) {
			return 0;
		}
		if (
			perpMarketIndex &&
			this.isIsolatedPositionBeingLiquidated(perpMarketIndex)
		) {
			return 0;
		}

		const marginCalc = this.getMarginCalculation('Maintenance');

		let totalCollateral: BN = ZERO;
		let maintenanceMarginReq: BN = ZERO;

		if (perpMarketIndex != null) {
			const isolatedMarginCalc =
				marginCalc.isolatedMarginCalculations.get(perpMarketIndex);
			if (isolatedMarginCalc) {
				totalCollateral = isolatedMarginCalc.totalCollateral;
				maintenanceMarginReq = isolatedMarginCalc.marginRequirement;
			}
		} else {
			totalCollateral = marginCalc.totalCollateral;
			maintenanceMarginReq = marginCalc.marginRequirement;
		}

		let health: number;

		if (maintenanceMarginReq.eq(ZERO) && totalCollateral.gte(ZERO)) {
			health = 100;
		} else if (totalCollateral.lte(ZERO)) {
			health = 0;
		} else {
			health = Math.round(
				Math.min(
					100,
					Math.max(
						0,
						(1 - maintenanceMarginReq.toNumber() / totalCollateral.toNumber()) *
							100
					)
				)
			);
		}

		return health;
	}

	/**
	 * Computes a single perp position's margin-weighted liability value: worst-case
	 * (or current, if `includeOpenOrders` is false) base amount, valued at the
	 * oracle price (or `expiryPrice` if the market is in settlement, which also
	 * zeroes the margin ratio), scaled by the applicable margin ratio for
	 * `marginCategory`. Underlies `getPerpMarketLiabilityValue`,
	 * `getTotalPerpPositionLiability`, and the leverage/liquidation-price math.
	 * @returns Precision QUOTE_PRECISION (1e6); unweighted (raw notional, no margin ratio applied) if `marginCategory` is omitted.
	 */
	calculateWeightedPerpPositionLiability(
		perpPosition: PerpPosition,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false
	): BN {
		const market = this.velocityClient.getPerpMarketAccountOrThrow(
			perpPosition.marketIndex
		);

		let valuationPrice = this.getOracleDataForPerpMarket(
			market.marketIndex
		).price;

		if (isVariant(market.status, 'settlement')) {
			valuationPrice = market.expiryPrice;
		}

		let baseAssetAmount: BN;
		let liabilityValue;
		if (includeOpenOrders) {
			const { worstCaseBaseAssetAmount, worstCaseLiabilityValue } =
				calculateWorstCasePerpLiabilityValue(
					perpPosition,
					market,
					valuationPrice
				);
			baseAssetAmount = worstCaseBaseAssetAmount;
			liabilityValue = worstCaseLiabilityValue;
		} else {
			baseAssetAmount = perpPosition.baseAssetAmount;
			liabilityValue = calculatePerpLiabilityValue(
				baseAssetAmount,
				valuationPrice
			);
		}

		if (marginCategory) {
			const userCustomMargin = Math.max(
				perpPosition.maxMarginRatio,
				this.getUserAccountOrThrow().maxMarginRatio
			);
			let marginRatio = new BN(
				calculateMarketMarginRatio(
					market,
					baseAssetAmount.abs(),
					marginCategory,
					userCustomMargin
				)
			);

			if (liquidationBuffer !== undefined) {
				marginRatio = marginRatio.add(liquidationBuffer);
			}

			if (isVariant(market.status, 'settlement')) {
				marginRatio = ZERO;
			}

			const quoteSpotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
				market.quoteSpotMarketIndex
			);
			const quoteOraclePriceData =
				this.velocityClient.getOracleDataForSpotMarket(QUOTE_SPOT_MARKET_INDEX);

			let quotePrice;
			if (strict) {
				quotePrice = BN.max(
					quoteOraclePriceData.price,
					quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
				);
			} else {
				quotePrice = quoteOraclePriceData.price;
			}

			liabilityValue = liabilityValue
				.mul(quotePrice)
				.div(PRICE_PRECISION)
				.mul(marginRatio)
				.div(MARGIN_PRECISION);

			if (includeOpenOrders) {
				liabilityValue = liabilityValue.add(
					new BN(perpPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
				);
			}
		}

		return liabilityValue;
	}

	/**
	 * Margin-weighted liability value of a single perp position. Thin wrapper
	 * around `calculateWeightedPerpPositionLiability` for the position in
	 * `marketIndex`; see that method for the worst-case/margin-ratio semantics.
	 * @param marketIndex
	 * @param marginCategory `'Initial'`/`'Maintenance'` margin ratio to apply; omit for the raw unweighted notional.
	 * @param liquidationBuffer Optional buffer (MARGIN_PRECISION, 1e4) added to the margin ratio.
	 * @param includeOpenOrders If true (recommended for margin checks), uses the worst-case base amount including open bids/asks.
	 * @param strict Use TWAP-bounded quote pricing. Defaults to false.
	 * @returns Precision QUOTE_PRECISION (1e6). Throws (via `getPerpPositionOrThrow`) if the user has no active position in `marketIndex`.
	 */
	public getPerpMarketLiabilityValue(
		marketIndex: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false
	): BN {
		const perpPosition = this.getPerpPositionOrThrow(marketIndex);
		return this.calculateWeightedPerpPositionLiability(
			perpPosition,
			marginCategory,
			liquidationBuffer,
			includeOpenOrders,
			strict
		);
	}

	/**
	 * Sums `calculateWeightedPerpPositionLiability` across every active perp
	 * position — the perp side of the margin requirement (see `getMarginRequirement`).
	 * @param marginCategory `'Initial'`/`'Maintenance'` margin ratio to apply; omit for the raw unweighted notional.
	 * @param liquidationBuffer Optional buffer (MARGIN_PRECISION, 1e4) added to the margin ratio.
	 * @param includeOpenOrders If true, uses each position's worst-case base amount including open bids/asks.
	 * @param strict Use TWAP-bounded quote pricing. Defaults to false.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	getTotalPerpPositionLiability(
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false
	): BN {
		return this.getActivePerpPositions().reduce(
			(totalPerpValue, perpPosition) => {
				const baseAssetValue = this.calculateWeightedPerpPositionLiability(
					perpPosition,
					marginCategory,
					liquidationBuffer,
					includeOpenOrders,
					strict
				);
				return totalPerpValue.add(baseAssetValue);
			},
			ZERO
		);
	}

	/**
	 * Values a perp position's base-asset notional at a caller-supplied oracle
	 * price rather than looking one up internally — useful for pricing against
	 * a simulated/custom price. Returns `ZERO` (via `getPerpPositionOrEmpty`) if
	 * the user has no position in `marketIndex`.
	 * @param marketIndex
	 * @param oraclePriceData Price to value the position at, PRICE_PRECISION (1e6). Caller-supplied so callers can pass a custom/simulated price.
	 * @param includeOpenOrders If true, uses the worst-case base amount (including open bids/asks) instead of the current position size. Defaults to false.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	public getPerpPositionValue(
		marketIndex: number,
		oraclePriceData: Pick<OraclePriceData, 'price'>,
		includeOpenOrders = false
	): BN {
		const userPosition = this.getPerpPositionOrEmpty(marketIndex);
		const market = this.velocityClient.getPerpMarketAccountOrThrow(
			userPosition.marketIndex
		);
		return calculateBaseAssetValueWithOracle(
			market,
			userPosition,
			oraclePriceData,
			includeOpenOrders
		);
	}

	/**
	 * Unweighted (no margin ratio applied) perp liability notional at a
	 * caller-supplied oracle price. Returns `ZERO` (via `getPerpPositionOrEmpty`)
	 * if the user has no position in `marketIndex`.
	 * @param marketIndex
	 * @param oraclePriceData Price to value the position at, PRICE_PRECISION (1e6).
	 * @param includeOpenOrders If true, uses the worst-case (including open bids/asks) liability value; otherwise just the current position. Defaults to false.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	public getPerpLiabilityValue(
		marketIndex: number,
		oraclePriceData: OraclePriceData,
		includeOpenOrders = false
	): BN {
		const userPosition = this.getPerpPositionOrEmpty(marketIndex);
		const market = this.velocityClient.getPerpMarketAccountOrThrow(
			userPosition.marketIndex
		);

		if (includeOpenOrders) {
			return calculateWorstCasePerpLiabilityValue(
				userPosition,
				market,
				oraclePriceData.price
			).worstCaseLiabilityValue;
		} else {
			return calculatePerpLiabilityValue(
				userPosition.baseAssetAmount,
				oraclePriceData.price
			);
		}
	}

	/** Returns `PositionDirection.LONG`/`SHORT` from the sign of `baseAssetAmount`, or `undefined` if the position is flat. */
	public getPositionSide(
		currentPosition: Pick<PerpPosition, 'baseAssetAmount'>
	): PositionDirection | undefined {
		if (currentPosition.baseAssetAmount.gt(ZERO)) {
			return PositionDirection.LONG;
		} else if (currentPosition.baseAssetAmount.lt(ZERO)) {
			return PositionDirection.SHORT;
		} else {
			return undefined;
		}
	}

	/**
	 * calculates average exit price (optionally for closing up to 100% of position)
	 * @param position Position to estimate the close for.
	 * @param amountToClose Optional base amount (BASE_PRECISION, 1e9) to simulate closing; if omitted, closes the full position. Passing `ZERO` returns the current reserve price with zero PnL.
	 * @param useAMMClose If true, values the close against the AMM's own reserves (`calculateBaseAssetValue`) instead of the oracle-referenced value (`calculateBaseAssetValueWithOracle`). Defaults to false.
	 * @returns Tuple of `[exitPrice, pnl]` — exitPrice is PRICE_PRECISION (1e6), pnl is QUOTE_PRECISION (1e6).
	 */
	public getPositionEstimatedExitPriceAndPnl(
		position: PerpPosition,
		amountToClose?: BN,
		useAMMClose = false
	): [BN, BN] {
		const market = this.velocityClient.getPerpMarketAccountOrThrow(
			position.marketIndex
		);

		const entryPrice = calculateEntryPrice(position);

		const oraclePriceData = this.getMMOracleDataForPerpMarket(
			position.marketIndex
		);

		if (amountToClose) {
			if (amountToClose.eq(ZERO)) {
				return [calculateReservePrice(market, oraclePriceData), ZERO];
			}
			position = {
				baseAssetAmount: amountToClose,
				lastCumulativeFundingRate: position.lastCumulativeFundingRate,
				marketIndex: position.marketIndex,
				quoteAssetAmount: position.quoteAssetAmount,
			} as PerpPosition;
		}

		let baseAssetValue: BN;

		if (useAMMClose) {
			baseAssetValue = calculateBaseAssetValue(
				market,
				position,
				oraclePriceData
			);
		} else {
			baseAssetValue = calculateBaseAssetValueWithOracle(
				market,
				position,
				oraclePriceData
			);
		}
		if (position.baseAssetAmount.eq(ZERO)) {
			return [ZERO, ZERO];
		}

		const exitPrice = baseAssetValue
			.mul(AMM_TO_QUOTE_PRECISION_RATIO)
			.mul(PRICE_PRECISION)
			.div(position.baseAssetAmount.abs());

		const pnlPerBase = exitPrice.sub(entryPrice);
		const pnl = pnlPerBase
			.mul(position.baseAssetAmount)
			.div(PRICE_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);

		return [exitPrice, pnl];
	}

	/**
	 * calculates current user leverage which is (total liability size) / (net asset value)
	 * @param includeOpenOrders If true, sizes the perp liability using worst-case open-order exposure. Defaults to true.
	 * @param perpMarketIndex Optional single isolated perp market to scope leverage to (uses that position's own isolated deposit + PnL as its asset value); omit for account-wide leverage.
	 * @returns : Precision TEN_THOUSAND (1e4, i.e. `10000` = 1x leverage). `ZERO` if net asset value is zero.
	 */
	public getLeverage(includeOpenOrders = true, perpMarketIndex?: number): BN {
		return this.calculateLeverageFromComponents(
			this.getLeverageComponents(includeOpenOrders, undefined, perpMarketIndex)
		);
	}

	/** Combines the components from `getLeverageComponents` into a single leverage ratio: `(perpLiability + spotLiability) / (spotAsset + perpPnl - spotLiability)`. Returns TEN_THOUSAND (1e4) precision; `ZERO` if net asset value is zero. */
	calculateLeverageFromComponents({
		perpLiabilityValue,
		perpPnl,
		spotAssetValue,
		spotLiabilityValue,
	}: {
		perpLiabilityValue: BN;
		perpPnl: BN;
		spotAssetValue: BN;
		spotLiabilityValue: BN;
	}): BN {
		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);
		const totalAssetValue = spotAssetValue.add(perpPnl);
		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		return totalLiabilityValue.mul(TEN_THOUSAND).div(netAssetValue);
	}

	/**
	 * Gathers the four raw components (`perpLiabilityValue`, `perpPnl`,
	 * `spotAssetValue`, `spotLiabilityValue`, all QUOTE_PRECISION/1e6) that
	 * `calculateLeverageFromComponents` combines into a leverage ratio.
	 *
	 * When `perpMarketIndex` is given, scopes to a single isolated position:
	 * `spotAssetValue` becomes that position's isolated quote deposit and
	 * `spotLiabilityValue` is `ZERO` (isolated positions carry no spot
	 * liability of their own). Otherwise sums across the whole account, and
	 * folds in `getTotalIsolatedPositionDeposits` as additional spot asset
	 * value when `marginCategory` is unweighted.
	 */
	getLeverageComponents(
		includeOpenOrders = true,
		marginCategory: MarginCategory | undefined = undefined,
		perpMarketIndex?: number
	): {
		perpLiabilityValue: BN;
		perpPnl: BN;
		spotAssetValue: BN;
		spotLiabilityValue: BN;
	} {
		if (perpMarketIndex) {
			const perpPosition = this.getPerpPositionOrEmpty(perpMarketIndex);
			const perpLiability = this.calculateWeightedPerpPositionLiability(
				perpPosition,
				marginCategory,
				undefined,
				includeOpenOrders
			);
			const perpMarket = this.velocityClient.getPerpMarketAccountOrThrow(
				perpPosition.marketIndex
			);

			const oraclePriceData = this.getOracleDataForPerpMarket(
				perpPosition.marketIndex
			);
			const quoteSpotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
				perpMarket.quoteSpotMarketIndex
			);
			const quoteOraclePriceData = this.getOracleDataForSpotMarket(
				perpMarket.quoteSpotMarketIndex
			);
			const strictOracle = new StrictOraclePrice(
				quoteOraclePriceData.price,
				quoteOraclePriceData.twap
			);

			const positionUnrealizedPnl = calculatePositionPNL(
				perpMarket,
				perpPosition,
				true,
				oraclePriceData
			);

			const tokenAmount = getTokenAmount(
				perpPosition.isolatedPositionScaledBalance ?? ZERO,
				quoteSpotMarket,
				SpotBalanceType.DEPOSIT
			);

			const spotAssetValue = getStrictTokenValue(
				tokenAmount,
				quoteSpotMarket.decimals,
				strictOracle
			);

			return {
				perpLiabilityValue: perpLiability,
				perpPnl: positionUnrealizedPnl,
				spotAssetValue,
				spotLiabilityValue: ZERO,
			};
		}

		const perpLiability = this.getTotalPerpPositionLiability(
			marginCategory,
			undefined,
			includeOpenOrders
		);
		const perpPnl = this.getUnrealizedPNL(true, undefined, marginCategory);

		const {
			totalAssetValue: spotAssetValue,
			totalLiabilityValue: spotLiabilityValue,
		} = this.getSpotMarketAssetAndLiabilityValue(
			undefined,
			marginCategory,
			undefined,
			includeOpenOrders
		);

		const isolatedDeposits =
			marginCategory === undefined
				? this.getTotalIsolatedPositionDeposits()
				: ZERO;

		return {
			perpLiabilityValue: perpLiability,
			perpPnl,
			spotAssetValue: spotAssetValue.add(isolatedDeposits),
			spotLiabilityValue,
		};
	}

	/**
	 * Returns true if the user's deposit position in `spotMarketAccount` is
	 * non-empty but worth less than `DUST_POSITION_SIZE` (QUOTE_PRECISION) —
	 * i.e. too small to be economically worth withdrawing/settling. Only
	 * evaluates deposits (returns false for borrows or an empty position).
	 * @throws If the user has no spot position slot for the market (should not happen for a valid `SpotMarketAccount`).
	 */
	isDustDepositPosition(spotMarketAccount: SpotMarketAccount): boolean {
		const marketIndex = spotMarketAccount.marketIndex;

		const spotPosition = this.getSpotPosition(spotMarketAccount.marketIndex);

		if (!spotPosition) {
			throw new Error(
				`No spot position found for market ${spotMarketAccount.marketIndex}`
			);
		}

		if (isSpotPositionAvailable(spotPosition)) {
			return false;
		}

		const depositAmount = this.getTokenAmount(spotMarketAccount.marketIndex);

		if (depositAmount.lte(ZERO)) {
			return false;
		}

		const oraclePriceData = this.getOracleDataForSpotMarket(marketIndex);

		const strictOraclePrice = new StrictOraclePrice(
			oraclePriceData.price,
			oraclePriceData.twap
		);

		const balanceValue = this.getSpotAssetValue(
			depositAmount,
			strictOraclePrice,
			spotMarketAccount
		);

		if (balanceValue.lt(DUST_POSITION_SIZE)) {
			return true;
		}

		return false;
	}

	/** Returns every spot market where the user holds a dust-sized deposit; see `isDustDepositPosition`. */
	getSpotMarketAccountsWithDustPosition() {
		const spotMarketAccounts = this.velocityClient.getSpotMarketAccounts();

		const dustPositionAccounts: SpotMarketAccount[] = [];

		for (const spotMarketAccount of spotMarketAccounts) {
			const isDust = this.isDustDepositPosition(spotMarketAccount);
			if (isDust) {
				dustPositionAccounts.push(spotMarketAccount);
			}
		}

		return dustPositionAccounts;
	}

	/**
	 * Sum of the user's total perp position liability (worst-case, open orders
	 * included) and total spot liability value (worst-case, open orders included).
	 * @param marginCategory Optional `'Initial'`/`'Maintenance'` weighting; omit for unweighted values.
	 * @returns Precision QUOTE_PRECISION (1e6), non-negative.
	 */
	getTotalLiabilityValue(marginCategory?: MarginCategory): BN {
		return this.getTotalPerpPositionLiability(
			marginCategory,
			undefined,
			true
		).add(
			this.getSpotMarketLiabilityValue(
				undefined,
				marginCategory,
				undefined,
				true
			)
		);
	}

	/**
	 * Sum of the user's total spot asset value and total unrealized perp PnL
	 * (with funding). When `marginCategory` is omitted (unweighted), also
	 * includes `getTotalIsolatedPositionDeposits`.
	 * @param marginCategory Optional `'Initial'`/`'Maintenance'` weighting; omit for unweighted values.
	 * @returns Precision QUOTE_PRECISION (1e6), non-negative.
	 */
	getTotalAssetValue(marginCategory?: MarginCategory): BN {
		const value = this.getSpotMarketAssetValue(
			undefined,
			marginCategory,
			true
		).add(this.getUnrealizedPNL(true, undefined, marginCategory));
		if (marginCategory === undefined) {
			return value.add(this.getTotalIsolatedPositionDeposits());
		}
		return value;
	}

	/**
	 * Unweighted net USD value of the account: net spot market value, plus
	 * unrealized (funding-inclusive) perp PnL, plus isolated position deposits.
	 * @returns Precision QUOTE_PRECISION (1e6), can be negative.
	 */
	getNetUsdValue(): BN {
		const netSpotValue = this.getNetSpotMarketValue();
		const unrealizedPnl = this.getUnrealizedPNL(true, undefined, undefined);
		const isolatedDeposits = this.getTotalIsolatedPositionDeposits();
		return netSpotValue.add(unrealizedPnl).add(isolatedDeposits);
	}

	/**
	 * Calculates the all-time P&L of the user: current net USD value
	 * (`getNetUsdValue`), plus lifetime total withdraws, minus lifetime total
	 * deposits. Equivalent to "everything the account is worth now, plus
	 * everything ever taken out, minus everything ever put in".
	 * @returns Precision QUOTE_PRECISION (1e6), can be negative.
	 */
	getTotalAllTimePnl(): BN {
		const netUsdValue = this.getNetUsdValue();
		const totalDeposits = this.getUserAccountOrThrow().totalDeposits;
		const totalWithdraws = this.getUserAccountOrThrow().totalWithdraws;

		const totalPnl = netUsdValue.add(totalWithdraws).sub(totalDeposits);

		return totalPnl;
	}

	/**
	 * calculates max allowable leverage exceeding hitting requirement category
	 * for large sizes where imf factor activates, result is a lower bound
	 * @param marginCategory {Initial, Maintenance} — currently unused; the calculation always uses the max-tradeable-size ('Initial') buying power.
	 * @returns : Precision TEN_THOUSAND (1e4, i.e. `10000` = 1x)
	 */
	public getMaxLeverageForPerp(
		perpMarketIndex: number,
		_marginCategory: MarginCategory = 'Initial'
	): BN {
		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const totalAssetValue = spotAssetValue.add(perpPnl);

		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);

		// absolute max fesible size (upper bound)
		const maxSizeQuote = BN.max(
			BN.min(
				this.getMaxTradeSizeUSDCForPerp(perpMarketIndex, PositionDirection.LONG)
					.tradeSize,
				this.getMaxTradeSizeUSDCForPerp(
					perpMarketIndex,
					PositionDirection.SHORT
				).tradeSize
			),
			ZERO
		);

		return totalLiabilityValue
			.add(maxSizeQuote)
			.mul(TEN_THOUSAND)
			.div(netAssetValue);
	}

	/**
	 * calculates max allowable leverage exceeding hitting requirement category
	 * @param spotMarketIndex
	 * @param direction Whether to simulate a long (deposit-increasing) or short (borrow-increasing) trade.
	 * @returns : Precision TEN_THOUSAND (1e4, i.e. `10000` = 1x)
	 */
	public getMaxLeverageForSpot(
		spotMarketIndex: number,
		direction: PositionDirection
	): BN {
		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);
		const totalAssetValue = spotAssetValue.add(perpPnl);

		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const currentQuoteAssetValue = this.getSpotMarketAssetValue(
			QUOTE_SPOT_MARKET_INDEX
		);
		const currentQuoteLiabilityValue = this.getSpotMarketLiabilityValue(
			QUOTE_SPOT_MARKET_INDEX
		);
		const currentQuoteValue = currentQuoteAssetValue.sub(
			currentQuoteLiabilityValue
		);

		const currentSpotMarketAssetValue =
			this.getSpotMarketAssetValue(spotMarketIndex);
		const currentSpotMarketLiabilityValue =
			this.getSpotMarketLiabilityValue(spotMarketIndex);
		const currentSpotMarketNetValue = currentSpotMarketAssetValue.sub(
			currentSpotMarketLiabilityValue
		);

		const tradeQuoteAmount = this.getMaxTradeSizeUSDCForSpot(
			spotMarketIndex,
			direction,
			currentQuoteAssetValue,
			currentSpotMarketNetValue
		);

		let assetValueToAdd = ZERO;
		let liabilityValueToAdd = ZERO;

		const newQuoteNetValue = isVariant(direction, 'short')
			? currentQuoteValue.add(tradeQuoteAmount)
			: currentQuoteValue.sub(tradeQuoteAmount);
		const newQuoteAssetValue = BN.max(newQuoteNetValue, ZERO);
		const newQuoteLiabilityValue = BN.min(newQuoteNetValue, ZERO).abs();

		assetValueToAdd = assetValueToAdd.add(
			newQuoteAssetValue.sub(currentQuoteAssetValue)
		);
		liabilityValueToAdd = liabilityValueToAdd.add(
			newQuoteLiabilityValue.sub(currentQuoteLiabilityValue)
		);

		const newSpotMarketNetValue = isVariant(direction, 'long')
			? currentSpotMarketNetValue.add(tradeQuoteAmount)
			: currentSpotMarketNetValue.sub(tradeQuoteAmount);
		const newSpotMarketAssetValue = BN.max(newSpotMarketNetValue, ZERO);
		const newSpotMarketLiabilityValue = BN.min(
			newSpotMarketNetValue,
			ZERO
		).abs();

		assetValueToAdd = assetValueToAdd.add(
			newSpotMarketAssetValue.sub(currentSpotMarketAssetValue)
		);
		liabilityValueToAdd = liabilityValueToAdd.add(
			newSpotMarketLiabilityValue.sub(currentSpotMarketLiabilityValue)
		);

		const finalTotalAssetValue = totalAssetValue.add(assetValueToAdd);
		const finalTotalSpotLiability = spotLiabilityValue.add(liabilityValueToAdd);

		const finalTotalLiabilityValue =
			totalLiabilityValue.add(liabilityValueToAdd);

		const finalNetAssetValue = finalTotalAssetValue.sub(
			finalTotalSpotLiability
		);

		return finalTotalLiabilityValue.mul(TEN_THOUSAND).div(finalNetAssetValue);
	}

	/**
	 * calculates margin ratio: 1 / leverage
	 * @returns : Precision TEN_THOUSAND (1e4, i.e. `10000` = 100% margin ratio / 1x leverage). Returns `BN_MAX` if the account has no liabilities.
	 */
	public getMarginRatio(): BN {
		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);
		const totalAssetValue = spotAssetValue.add(perpPnl);

		if (totalLiabilityValue.eq(ZERO)) {
			return BN_MAX;
		}

		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		return netAssetValue.mul(TEN_THOUSAND).div(totalLiabilityValue);
	}

	/**
	 * @deprecated Use `getLiquidationStatuses` for the full cross + per-isolated-market breakdown. This method returns only the cross-margin status (plus the same isolated map, for convenience) for backward compatibility.
	 * @returns The cross-margin `AccountLiquidatableStatus`, plus `isolatedPositions` mapping each isolated perp market index to its own status.
	 */
	public canBeLiquidated(): AccountLiquidatableStatus & {
		isolatedPositions: Map<number, AccountLiquidatableStatus>;
	} {
		// Deprecated signature retained for backward compatibility in type only
		// but implementation now delegates to the new Map-based API and returns cross margin status.
		const map = this.getLiquidationStatuses();
		const cross = map.get('cross');
		const isolatedPositions: Map<number, AccountLiquidatableStatus> = new Map(
			Array.from(map.entries())
				.filter(
					(e): e is [number, AccountLiquidatableStatus] => e[0] !== 'cross'
				)
				.map(([key, value]) => [key, value])
		);
		return cross
			? { ...cross, isolatedPositions }
			: {
					canBeLiquidated: false,
					marginRequirement: ZERO,
					totalCollateral: ZERO,
					isolatedPositions,
			  };
	}

	/**
	 * New API: Returns liquidation status for cross and each isolated perp position.
	 * Map keys:
	 *  - 'cross' for cross margin
	 *  - marketIndex (number) for each isolated perp position
	 *
	 * Each `canBeLiquidated` compares maintenance total collateral against the
	 * maintenance margin requirement for that scope. If `marginCalc` is not
	 * supplied, one is computed under `'Maintenance'` with the account's
	 * current `getLiquidationBuffer()` applied — i.e. this defaults to the same
	 * buffered check the on-chain liquidation instructions use, not a bare
	 * maintenance-margin comparison.
	 * @param marginCalc Optional pre-computed `MarginCalculation` to reuse (avoids recomputing margin across repeated calls).
	 */
	public getLiquidationStatuses(
		marginCalc?: MarginCalculation
	): Map<'cross' | number, AccountLiquidatableStatus> {
		// If not provided, use buffer-aware calc for canBeLiquidated checks
		if (!marginCalc) {
			const liquidationBufferMap = this.getLiquidationBuffer();
			marginCalc = this.getMarginCalculation('Maintenance', {
				liquidationBufferMap,
			});
		}

		const result = new Map<'cross' | number, AccountLiquidatableStatus>();

		// Cross margin status
		const crossTotalCollateral = marginCalc.totalCollateral;
		const crossMarginRequirement = marginCalc.marginRequirement;
		result.set('cross', {
			canBeLiquidated: crossTotalCollateral.lt(crossMarginRequirement),
			marginRequirement: crossMarginRequirement,
			totalCollateral: crossTotalCollateral,
		});

		// Isolated positions status
		for (const [
			marketIndex,
			isoCalc,
		] of marginCalc.isolatedMarginCalculations) {
			const isoTotalCollateral = isoCalc.totalCollateral;
			const isoMarginRequirement = isoCalc.marginRequirement;
			result.set(marketIndex, {
				canBeLiquidated: isoTotalCollateral.lt(isoMarginRequirement),
				marginRequirement: isoMarginRequirement,
				totalCollateral: isoTotalCollateral,
			});
		}

		return result;
	}

	/** Returns true if cross margin or any isolated perp position is currently flagged as being liquidated or bankrupt. */
	public isBeingLiquidated(): boolean {
		return (
			this.isCrossMarginBeingLiquidated() ||
			this.hasIsolatedPositionBeingLiquidated()
		);
	}

	/** Returns true if the account-level `UserStatus` has `BEING_LIQUIDATED` or `BANKRUPT` set (cross margin, not per-isolated-position). */
	public isCrossMarginBeingLiquidated(): boolean {
		return (
			(this.getUserAccountOrThrow().status &
				(UserStatus.BEING_LIQUIDATED | UserStatus.BANKRUPT)) >
			0
		);
	}

	/** Returns true if cross margin is currently below maintenance requirement (no buffer). */
	public canCrossMarginBeLiquidated(marginCalc?: MarginCalculation): boolean {
		const calc = marginCalc ?? this.getMarginCalculation('Maintenance');
		return calc.totalCollateral.lt(calc.marginRequirement);
	}

	/** Returns true if any active perp position has `PositionFlag.BeingLiquidated` or `PositionFlag.Bankruptcy` set. */
	public hasIsolatedPositionBeingLiquidated(): boolean {
		return this.getActivePerpPositions().some(
			(position) =>
				(position.positionFlag &
					(PositionFlag.BeingLiquidated | PositionFlag.Bankruptcy)) >
				0
		);
	}

	/** Returns true if the specific perp position in `perpMarketIndex` has `PositionFlag.BeingLiquidated` or `PositionFlag.Bankruptcy` set. False (not throw) if the user has no position there. */
	public isIsolatedPositionBeingLiquidated(perpMarketIndex: number): boolean {
		const position = this.getActivePerpPositions().find(
			(position) => position.marketIndex === perpMarketIndex
		);

		return (
			((position?.positionFlag ?? 0) &
				(PositionFlag.BeingLiquidated | PositionFlag.Bankruptcy)) >
			0
		);
	}

	/** Returns true if any isolated perp position is currently below its maintenance requirement (no buffer). */
	public getLiquidatableIsolatedPositions(
		marginCalc?: MarginCalculation
	): number[] {
		const liquidatableIsolatedPositions = [];
		const calc = marginCalc ?? this.getMarginCalculation('Maintenance');
		for (const [marketIndex, isoCalc] of calc.isolatedMarginCalculations) {
			if (this.canIsolatedPositionMarginBeLiquidated(isoCalc)) {
				liquidatableIsolatedPositions.push(marketIndex);
			}
		}
		return liquidatableIsolatedPositions;
	}

	/** Returns true if `isolatedMarginCalculation`'s collateral is below its margin requirement (no buffer). */
	public canIsolatedPositionMarginBeLiquidated(
		isolatedMarginCalculation: IsolatedMarginCalculation
	): boolean {
		return isolatedMarginCalculation.totalCollateral.lt(
			isolatedMarginCalculation.marginRequirement
		);
	}

	/** Returns true if the account's `UserStatus` bitmask has `status` set. */
	public hasStatus(status: UserStatus): boolean {
		return (this.getUserAccountOrThrow().status & status) > 0;
	}

	/** Returns true if the account's `UserStatus` has `BANKRUPT` set (equity insufficient to cover liabilities; awaiting bankruptcy resolution). */
	public isBankrupt(): boolean {
		return (this.getUserAccountOrThrow().status & UserStatus.BANKRUPT) > 0;
	}

	/**
	 * Checks if any user position cumulative funding differs from respective market cumulative funding
	 * @returns True if at least one non-flat perp position has stale `lastCumulativeFundingRate` relative to the market's current long/short cumulative funding rate.
	 */
	public needsToSettleFundingPayment(): boolean {
		for (const userPosition of this.getUserAccountOrThrow().perpPositions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			const market = this.velocityClient.getPerpMarketAccountOrThrow(
				userPosition.marketIndex
			);
			if (
				market.cumulativeFundingRateLong.eq(
					userPosition.lastCumulativeFundingRate
				) ||
				market.cumulativeFundingRateShort.eq(
					userPosition.lastCumulativeFundingRate
				)
			) {
				continue;
			}

			return true;
		}
		return false;
	}

	/**
	 * Calculate the liquidation price of a spot position — the oracle price at
	 * which maintenance free collateral would hit zero, extrapolating linearly
	 * from the current free collateral and the position's per-unit-price
	 * sensitivity (`calculateFreeCollateralDeltaForSpot`). If a perp market
	 * shares the same oracle as this spot market, that perp position's
	 * sensitivity is folded in too (scaled for any oracle-source unit
	 * difference), since a single price move affects both simultaneously.
	 * @param marketIndex Spot market to compute the liquidation price for.
	 * @param positionBaseSizeChange Optional simulated change to the position size, in the spot market's own token decimals. Defaults to no change.
	 * @returns Precision PRICE_PRECISION (1e6). Returns `new BN(-1)` as a sentinel when there is no position, the position (after `positionBaseSizeChange`) is flat, the price sensitivity is zero, or the computed liquidation price would be negative (position cannot be liquidated by a price move alone).
	 */
	public spotLiquidationPrice(
		marketIndex: number,
		positionBaseSizeChange: BN = ZERO
	): BN {
		const currentSpotPosition = this.getSpotPosition(marketIndex);

		if (!currentSpotPosition) {
			return new BN(-1);
		}

		const totalCollateral = this.getTotalCollateral('Maintenance');
		const maintenanceMarginRequirement = this.getMaintenanceMarginRequirement();
		const freeCollateral = BN.max(
			ZERO,
			totalCollateral.sub(maintenanceMarginRequirement)
		);

		const market = this.velocityClient.getSpotMarketAccountOrThrow(marketIndex);
		let signedTokenAmount = getSignedTokenAmount(
			getTokenAmount(
				currentSpotPosition.scaledBalance,
				market,
				currentSpotPosition.balanceType
			),
			currentSpotPosition.balanceType
		);
		signedTokenAmount = signedTokenAmount.add(positionBaseSizeChange);

		if (signedTokenAmount.eq(ZERO)) {
			return new BN(-1);
		}

		let freeCollateralDelta = this.calculateFreeCollateralDeltaForSpot(
			market,
			signedTokenAmount
		);

		const oracle = market.oracle;
		const perpMarketWithSameOracle = this.velocityClient
			.getPerpMarketAccounts()
			.find((market) => market.oracle.equals(oracle));
		const oraclePrice =
			this.velocityClient.getOracleDataForSpotMarket(marketIndex).price;
		if (perpMarketWithSameOracle) {
			const perpPosition = this.getPerpPositionOrEmpty(
				perpMarketWithSameOracle.marketIndex
			);
			if (perpPosition) {
				let freeCollateralDeltaForPerp =
					this.calculateFreeCollateralDeltaForPerp(
						perpMarketWithSameOracle,
						perpPosition,
						ZERO,
						oraclePrice
					);

				if (freeCollateralDeltaForPerp) {
					const { numerator, denominator } = getMultipleBetweenOracleSources(
						market.oracleSource,
						perpMarketWithSameOracle.oracleSource
					);
					freeCollateralDeltaForPerp = freeCollateralDeltaForPerp
						.mul(numerator)
						.div(denominator);
				}

				freeCollateralDelta = freeCollateralDelta.add(
					freeCollateralDeltaForPerp || ZERO
				);
			}
		}

		if (freeCollateralDelta.eq(ZERO)) {
			return new BN(-1);
		}

		const liqPriceDelta = freeCollateral
			.mul(QUOTE_PRECISION)
			.div(freeCollateralDelta);

		const liqPrice = oraclePrice.sub(liqPriceDelta);

		if (liqPrice.lt(ZERO)) {
			return new BN(-1);
		}

		return liqPrice;
	}

	/**
	 * Calculate the liquidation price of a perp position, with optional parameter to calculate the liquidation price after a trade.
	 *
	 * Like `spotLiquidationPrice`, this extrapolates linearly from current free
	 * collateral (`totalCollateral - marginRequirement`, plus `offsetCollateral`)
	 * and the position's price sensitivity; if a spot market shares the same
	 * oracle, its sensitivity is folded in too. When `marginType === 'Isolated'`,
	 * free collateral and the margin requirement are scoped to that market's
	 * isolated bucket instead of the cross-margin account (and the spot-oracle
	 * cross-contribution above is skipped).
	 * @param marketIndex
	 * @param positionBaseSizeChange Change in position size to calculate the liquidation price for, standardized to the market's order step size. Precision BASE_PRECISION (1e9).
	 * @param estimatedEntryPrice Entry price for `positionBaseSizeChange`, PRICE_PRECISION (1e6); only affects the result under `marginCategory: 'Maintenance'` (it adjusts free collateral for the estimated realized PnL and taker fee of entering at this price rather than at the oracle price).
	 * @param marginCategory Allow `'Initial'` to be passed in if we are trying to calculate price for DLP de-risking. Defaults to `'Maintenance'` (the actual liquidation threshold).
	 * @param includeOpenOrders Include open orders' worst-case exposure when sizing the position. Defaults to false.
	 * @param offsetCollateral Allows calculating the liquidation price after this offset collateral (QUOTE_PRECISION, 1e6) is added to the user's account (e.g. : what will the liquidation price be for this position AFTER I deposit $x worth of collateral). Defaults to zero.
	 * @param marginType `'Isolated'` to scope the calculation to `marketIndex`'s isolated margin bucket; omit/`'Cross'` for the cross-margin account.
	 * @returns Precision : PRICE_PRECISION (1e6). Returns `new BN(-1)` as a sentinel when there is no isolated margin calculation for the market (isolated mode), the price sensitivity is zero, or the computed price would be negative (position cannot be liquidated by a price move alone).
	 */
	public liquidationPrice(
		marketIndex: number,
		positionBaseSizeChange: BN = ZERO,
		estimatedEntryPrice: BN = ZERO,
		marginCategory: MarginCategory = 'Maintenance',
		includeOpenOrders = false,
		offsetCollateral = ZERO,
		marginType?: MarginType
	): BN {
		const market = this.velocityClient.getPerpMarketAccountOrThrow(marketIndex);

		const oracle = market.oracle;

		const oraclePrice =
			this.velocityClient.getOracleDataForPerpMarket(marketIndex).price;

		const currentPerpPosition = this.getPerpPositionOrEmpty(marketIndex);

		if (marginType === 'Isolated') {
			const marginCalculation = this.getMarginCalculation(marginCategory, {
				strict: false,
				includeOpenOrders,
			});
			const isolatedMarginCalculation =
				marginCalculation.isolatedMarginCalculations.get(marketIndex);
			if (!isolatedMarginCalculation) return new BN(-1);
			const { totalCollateral, marginRequirement } = isolatedMarginCalculation;

			const freeCollateral = BN.max(
				ZERO,
				totalCollateral.sub(marginRequirement)
			).add(offsetCollateral);

			const freeCollateralDelta = this.calculateFreeCollateralDeltaForPerp(
				market,
				currentPerpPosition,
				positionBaseSizeChange,
				oraclePrice,
				marginCategory,
				includeOpenOrders
			);

			if (!freeCollateralDelta || freeCollateralDelta.eq(ZERO)) {
				return new BN(-1);
			}

			const liqPriceDelta = freeCollateral
				.mul(QUOTE_PRECISION)
				.div(freeCollateralDelta);

			const liqPrice = oraclePrice.sub(liqPriceDelta);

			if (liqPrice.lt(ZERO)) {
				return new BN(-1);
			}

			return liqPrice;
		}

		const totalCollateral = this.getTotalCollateral(
			marginCategory,
			false,
			includeOpenOrders
		);

		const marginRequirement = this.getMarginRequirement(
			marginCategory,
			undefined,
			false,
			includeOpenOrders
		);

		let freeCollateral = BN.max(
			ZERO,
			totalCollateral.sub(marginRequirement)
		).add(offsetCollateral);

		positionBaseSizeChange = standardizeBaseAssetAmount(
			positionBaseSizeChange,
			market.orderStepSize
		);

		const freeCollateralChangeFromNewPosition =
			this.calculateEntriesEffectOnFreeCollateral(
				market,
				oraclePrice,
				currentPerpPosition,
				positionBaseSizeChange,
				estimatedEntryPrice,
				includeOpenOrders
			);

		freeCollateral = freeCollateral.add(freeCollateralChangeFromNewPosition);

		let freeCollateralDelta = this.calculateFreeCollateralDeltaForPerp(
			market,
			currentPerpPosition,
			positionBaseSizeChange,
			oraclePrice,
			marginCategory,
			includeOpenOrders
		);

		if (!freeCollateralDelta) {
			return new BN(-1);
		}

		const spotMarketWithSameOracle = this.velocityClient
			.getSpotMarketAccounts()
			.find((market) => market.oracle.equals(oracle));
		if (spotMarketWithSameOracle) {
			const spotPosition = this.getSpotPosition(
				spotMarketWithSameOracle.marketIndex
			);
			if (spotPosition) {
				const signedTokenAmount = getSignedTokenAmount(
					getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketWithSameOracle,
						spotPosition.balanceType
					),
					spotPosition.balanceType
				);

				let spotFreeCollateralDelta = this.calculateFreeCollateralDeltaForSpot(
					spotMarketWithSameOracle,
					signedTokenAmount,
					marginCategory
				);

				if (spotFreeCollateralDelta) {
					const { numerator, denominator } = getMultipleBetweenOracleSources(
						market.oracleSource,
						spotMarketWithSameOracle.oracleSource
					);
					spotFreeCollateralDelta = spotFreeCollateralDelta
						.mul(numerator)
						.div(denominator);
				}

				freeCollateralDelta = freeCollateralDelta.add(
					spotFreeCollateralDelta || ZERO
				);
			}
		}

		if (freeCollateralDelta.eq(ZERO)) {
			return new BN(-1);
		}

		const liqPriceDelta = freeCollateral
			.mul(QUOTE_PRECISION)
			.div(freeCollateralDelta);

		const liqPrice = oraclePrice.sub(liqPriceDelta);

		if (liqPrice.lt(ZERO)) {
			return new BN(-1);
		}

		return liqPrice;
	}

	/**
	 * Helper for `liquidationPrice`: estimates the net change to free collateral
	 * from simultaneously (a) realizing PnL on `positionBaseSizeChange` entered
	 * at `estimatedEntryPrice` (assuming the worst/taker fee tier) versus the
	 * oracle price, and (b) the resulting change in margin requirement from the
	 * new position size. Only component (a) applies under `'Maintenance'`
	 * (matching `liquidationPrice`'s default); under other margin categories
	 * only the margin-requirement delta is applied.
	 * @returns Precision QUOTE_PRECISION (1e6); can be negative.
	 */
	calculateEntriesEffectOnFreeCollateral(
		market: PerpMarketAccount,
		oraclePrice: BN,
		perpPosition: PerpPosition,
		positionBaseSizeChange: BN,
		estimatedEntryPrice: BN,
		includeOpenOrders: boolean,
		marginCategory: MarginCategory = 'Maintenance'
	): BN {
		let freeCollateralChange = ZERO;

		// update free collateral to account for change in pnl from new position
		if (
			!estimatedEntryPrice.eq(ZERO) &&
			!positionBaseSizeChange.eq(ZERO) &&
			marginCategory === 'Maintenance'
		) {
			const costBasis = oraclePrice
				.mul(positionBaseSizeChange.abs())
				.div(BASE_PRECISION);
			const newPositionValue = estimatedEntryPrice
				.mul(positionBaseSizeChange.abs())
				.div(BASE_PRECISION);
			if (positionBaseSizeChange.gt(ZERO)) {
				freeCollateralChange = costBasis.sub(newPositionValue);
			} else {
				freeCollateralChange = newPositionValue.sub(costBasis);
			}

			// assume worst fee tier; ceil-divide to match calculate_taker_fee's safe_div_ceil
			const takerFeeTier =
				this.velocityClient.getStateAccount().perpFeeStructure.feeTiers[0];
			const takerFee = divCeil(
				newPositionValue.muln(takerFeeTier.feeNumerator),
				new BN(takerFeeTier.feeDenominator)
			);
			freeCollateralChange = freeCollateralChange.sub(takerFee);
		}

		const calculateMarginRequirement = (perpPosition: PerpPosition) => {
			let baseAssetAmount: BN;
			let liabilityValue: BN;
			if (includeOpenOrders) {
				const { worstCaseBaseAssetAmount, worstCaseLiabilityValue } =
					calculateWorstCasePerpLiabilityValue(
						perpPosition,
						market,
						oraclePrice
					);
				baseAssetAmount = worstCaseBaseAssetAmount;
				liabilityValue = worstCaseLiabilityValue;
			} else {
				baseAssetAmount = perpPosition.baseAssetAmount;
				liabilityValue = calculatePerpLiabilityValue(
					baseAssetAmount,
					oraclePrice
				);
			}

			const userCustomMargin = Math.max(
				perpPosition.maxMarginRatio,
				this.getUserAccountOrThrow().maxMarginRatio
			);
			const marginRatio = calculateMarketMarginRatio(
				market,
				baseAssetAmount.abs(),
				marginCategory,
				userCustomMargin
			);

			return liabilityValue.mul(new BN(marginRatio)).div(MARGIN_PRECISION);
		};

		const freeCollateralConsumptionBefore =
			calculateMarginRequirement(perpPosition);

		const perpPositionAfter = Object.assign({}, perpPosition);
		perpPositionAfter.baseAssetAmount = perpPositionAfter.baseAssetAmount.add(
			positionBaseSizeChange
		);

		const freeCollateralConsumptionAfter =
			calculateMarginRequirement(perpPositionAfter);

		return freeCollateralChange.sub(
			freeCollateralConsumptionAfter.sub(freeCollateralConsumptionBefore)
		);
	}

	/**
	 * Helper for `liquidationPrice`: the derivative of free collateral with
	 * respect to the perp market's oracle price, for the proposed post-trade
	 * position (`positionBaseSizeChange` applied to the current, or worst-case
	 * if `includeOpenOrders`, base amount). Used as the linear-extrapolation
	 * slope to solve for the price at which free collateral hits zero.
	 * @returns Precision QUOTE_PRECISION (1e6) per unit of PRICE_PRECISION move, or `undefined` if the proposed position is flat (no defined liquidation price).
	 */
	calculateFreeCollateralDeltaForPerp(
		market: PerpMarketAccount,
		perpPosition: PerpPosition,
		positionBaseSizeChange: BN,
		oraclePrice: BN,
		marginCategory: MarginCategory = 'Maintenance',
		includeOpenOrders = false
	): BN | undefined {
		const baseAssetAmount = includeOpenOrders
			? calculateWorstCaseBaseAssetAmount(perpPosition, market, oraclePrice)
			: perpPosition.baseAssetAmount;

		// zero if include orders == false
		const orderBaseAssetAmount = baseAssetAmount.sub(
			perpPosition.baseAssetAmount
		);

		const proposedBaseAssetAmount = baseAssetAmount.add(positionBaseSizeChange);

		const userCustomMargin = Math.max(
			perpPosition.maxMarginRatio,
			this.getUserAccountOrThrow().maxMarginRatio
		);

		const marginRatio = calculateMarketMarginRatio(
			market,
			proposedBaseAssetAmount.abs(),
			marginCategory,
			userCustomMargin
		);

		const marginRatioQuotePrecision = new BN(marginRatio)
			.mul(QUOTE_PRECISION)
			.div(MARGIN_PRECISION);

		if (proposedBaseAssetAmount.eq(ZERO)) {
			return undefined;
		}

		let freeCollateralDelta = ZERO;

		if (proposedBaseAssetAmount.gt(ZERO)) {
			freeCollateralDelta = QUOTE_PRECISION.sub(marginRatioQuotePrecision)
				.mul(proposedBaseAssetAmount)
				.div(BASE_PRECISION);
		} else {
			freeCollateralDelta = QUOTE_PRECISION.neg()
				.sub(marginRatioQuotePrecision)
				.mul(proposedBaseAssetAmount.abs())
				.div(BASE_PRECISION);
		}

		if (!orderBaseAssetAmount.eq(ZERO)) {
			freeCollateralDelta = freeCollateralDelta.sub(
				marginRatioQuotePrecision
					.mul(orderBaseAssetAmount.abs())
					.div(BASE_PRECISION)
			);
		}

		return freeCollateralDelta;
	}

	/**
	 * Helper for `spotLiquidationPrice`/`liquidationPrice`: the derivative of
	 * free collateral with respect to the spot market's oracle price, for a
	 * position of `signedTokenAmount` (positive = deposit, negative = borrow).
	 * @returns Precision QUOTE_PRECISION (1e6) per unit of PRICE_PRECISION move.
	 */
	calculateFreeCollateralDeltaForSpot(
		market: SpotMarketAccount,
		signedTokenAmount: BN,
		marginCategory: MarginCategory = 'Maintenance'
	): BN {
		const tokenPrecision = new BN(Math.pow(10, market.decimals));

		if (signedTokenAmount.gt(ZERO)) {
			const assetWeight = calculateAssetWeight(
				signedTokenAmount,
				this.velocityClient.getOracleDataForSpotMarket(market.marketIndex)
					.price,
				market,
				marginCategory
			);

			return QUOTE_PRECISION.mul(assetWeight)
				.div(SPOT_MARKET_WEIGHT_PRECISION)
				.mul(signedTokenAmount)
				.div(tokenPrecision);
		} else {
			const liabilityWeight = calculateLiabilityWeight(
				signedTokenAmount.abs(),
				market,
				marginCategory
			);

			return QUOTE_PRECISION.neg()
				.mul(liabilityWeight)
				.div(SPOT_MARKET_WEIGHT_PRECISION)
				.mul(signedTokenAmount.abs())
				.div(tokenPrecision);
		}
	}

	/**
	 * Calculates the estimated liquidation price for a position after closing a quote amount of the position.
	 * @param positionMarketIndex
	 * @param closeQuoteAmount Quote-denominated amount of the position to close, QUOTE_PRECISION (1e6). Converted proportionally to a base-size reduction via the position's current cost basis.
	 * @param estimatedEntryPrice Forwarded to `liquidationPrice` as the entry price for the (negative, i.e. closing) size change. PRICE_PRECISION (1e6). Defaults to zero.
	 * @returns : Precision PRICE_PRECISION (1e6). See `liquidationPrice` for the `-1` sentinel cases.
	 */
	public liquidationPriceAfterClose(
		positionMarketIndex: number,
		closeQuoteAmount: BN,
		estimatedEntryPrice: BN = ZERO
	): BN {
		const currentPosition = this.getPerpPositionOrEmpty(positionMarketIndex);

		const closeBaseAmount = currentPosition.baseAssetAmount
			.mul(closeQuoteAmount)
			.div(currentPosition.quoteAssetAmount.abs())
			.add(
				currentPosition.baseAssetAmount
					.mul(closeQuoteAmount)
					.mod(currentPosition.quoteAssetAmount.abs())
			)
			.neg();

		return this.liquidationPrice(
			positionMarketIndex,
			closeBaseAmount,
			estimatedEntryPrice
		);
	}

	/**
	 * Calculates the margin required to open a trade of `baseSize` in `targetMarketIndex`, scalar only — does not account for trade direction or existing positions/whether the trade is actually risk-increasing.
	 * @param baseSize BASE_PRECISION (1e9).
	 * @param estEntryPrice Optional entry price to value the trade at, PRICE_PRECISION (1e6); defaults to the oracle price.
	 * @param perpMarketMaxMarginRatio Optional max-margin-ratio override, see `resolveMaxMarginRatio`.
	 * @returns Precision QUOTE_PRECISION (1e6).
	 */
	public getMarginUSDCRequiredForTrade(
		targetMarketIndex: number,
		baseSize: BN,
		estEntryPrice?: BN,
		perpMarketMaxMarginRatio?: number
	): BN {
		const maxMarginRatio = this.resolveMaxMarginRatio(perpMarketMaxMarginRatio);
		return calculateMarginUSDCRequiredForTrade(
			this.velocityClient,
			targetMarketIndex,
			baseSize,
			maxMarginRatio,
			estEntryPrice
		);
	}

	/**
	 * Converts `getMarginUSDCRequiredForTrade`'s USDC margin requirement into
	 * how much of `collateralIndex`'s token a user would need to deposit to
	 * cover it, accounting for that collateral's scaled initial asset weight
	 * (a lower-weighted asset requires proportionally more deposited).
	 * @param baseSize BASE_PRECISION (1e9).
	 * @param collateralIndex Spot market to size the deposit in.
	 * @param perpMarketMaxMarginRatio Optional max-margin-ratio override, see `resolveMaxMarginRatio`.
	 * @returns Token amount in `collateralIndex`'s own decimals.
	 */
	public getCollateralDepositRequiredForTrade(
		targetMarketIndex: number,
		baseSize: BN,
		collateralIndex: number,
		perpMarketMaxMarginRatio?: number
	): BN {
		const maxMarginRatio = this.resolveMaxMarginRatio(perpMarketMaxMarginRatio);
		return calculateCollateralDepositRequiredForTrade(
			this.velocityClient,
			targetMarketIndex,
			baseSize,
			collateralIndex,
			maxMarginRatio
		);
	}

	/**
	 * Separates the max trade size into two parts:
	 * - tradeSize: The maximum trade size for target direction
	 * - oppositeSideTradeSize: the trade size for closing the opposite direction
	 * @param targetMarketIndex
	 * @param tradeSide
	 * @param maxMarginRatio Optional max-margin-ratio override, see `resolveMaxMarginRatio`.
	 * @param positionType Whether to size for a cross or isolated-margin position (forwarded to `getPerpBuyingPower`). Defaults to `'cross'`.
	 * @returns { tradeSize: BN, oppositeSideTradeSize: BN} : Precision QUOTE_PRECISION (1e6)
	 */
	public getMaxTradeSizeUSDCForPerp(
		targetMarketIndex: number,
		tradeSide: PositionDirection,
		maxMarginRatio: number | undefined = undefined,
		positionType: 'isolated' | 'cross' = 'cross'
	): { tradeSize: BN; oppositeSideTradeSize: BN } {
		let tradeSize = ZERO;
		let oppositeSideTradeSize = ZERO;
		const currentPosition = this.getPerpPositionOrEmpty(targetMarketIndex);

		const targetSide = isVariant(tradeSide, 'short') ? 'short' : 'long';

		const currentPositionSide = currentPosition?.baseAssetAmount.isNeg()
			? 'short'
			: 'long';

		const targetingSameSide = !currentPosition
			? true
			: targetSide === currentPositionSide;

		const oracleData = this.getMMOracleDataForPerpMarket(targetMarketIndex);

		const marketAccount =
			this.velocityClient.getPerpMarketAccountOrThrow(targetMarketIndex);

		// add any position we have on the opposite side of the current trade, because we can "flip" the size of this position without taking any extra leverage.
		const oppositeSizeLiabilityValue = targetingSameSide
			? ZERO
			: calculatePerpLiabilityValue(
					currentPosition.baseAssetAmount,
					oracleData.price
			  );

		const maxPositionSize = this.getPerpBuyingPower(
			targetMarketIndex,
			ZERO,
			maxMarginRatio,
			positionType
		);

		if (maxPositionSize.gte(ZERO)) {
			if (oppositeSizeLiabilityValue.eq(ZERO)) {
				// case 1 : Regular trade where current total position less than max, and no opposite position to account for
				// do nothing
				tradeSize = maxPositionSize;
			} else {
				// case 2 : trade where current total position less than max, but need to account for flipping the current position over to the other side
				tradeSize = maxPositionSize.add(oppositeSizeLiabilityValue);
				oppositeSideTradeSize = oppositeSizeLiabilityValue;
			}
		} else {
			// current leverage is greater than max leverage - can only reduce position size

			if (!targetingSameSide) {
				const perpLiabilityValue = calculatePerpLiabilityValue(
					currentPosition.baseAssetAmount,
					oracleData.price
				);
				const totalCollateral = this.getTotalCollateral();
				const marginRequirement = this.getInitialMarginRequirement();
				const marginRatio = Math.max(
					currentPosition.maxMarginRatio,
					this.getUserAccountOrThrow().maxMarginRatio
				);
				const marginFreedByClosing = perpLiabilityValue
					.mul(new BN(marginRatio))
					.div(MARGIN_PRECISION);
				const marginRequirementAfterClosing =
					marginRequirement.sub(marginFreedByClosing);

				if (marginRequirementAfterClosing.gt(totalCollateral)) {
					oppositeSideTradeSize = perpLiabilityValue;
				} else {
					const freeCollateralAfterClose = totalCollateral.sub(
						marginRequirementAfterClosing
					);

					const buyingPowerAfterClose =
						this.getPerpBuyingPowerFromFreeCollateralAndBaseAssetAmount(
							targetMarketIndex,
							freeCollateralAfterClose,
							ZERO,
							currentPosition.maxMarginRatio
						);
					oppositeSideTradeSize = perpLiabilityValue;
					tradeSize = buyingPowerAfterClose;
				}
			} else {
				// do nothing if targetting same side
				tradeSize = maxPositionSize;
			}
		}

		const freeCollateral = this.getFreeCollateral('Initial');

		let baseTradeSize =
			targetSide === 'long'
				? tradeSize.mul(BASE_PRECISION).div(oracleData.price)
				: tradeSize.mul(BASE_PRECISION).div(oracleData.price).neg();

		let freeCollateralChangeFromNewPosition =
			this.calculateEntriesEffectOnFreeCollateral(
				marketAccount,
				oracleData.price,
				currentPosition,
				baseTradeSize,
				oracleData.price,
				false,
				'Initial'
			);

		while (
			freeCollateralChangeFromNewPosition.isNeg() &&
			freeCollateralChangeFromNewPosition.abs().gt(freeCollateral)
		) {
			tradeSize = tradeSize.mul(new BN(99)).div(new BN(100));
			baseTradeSize =
				targetSide === 'long'
					? tradeSize.mul(BASE_PRECISION).div(oracleData.price)
					: tradeSize.mul(BASE_PRECISION).div(oracleData.price).neg();
			freeCollateralChangeFromNewPosition =
				this.calculateEntriesEffectOnFreeCollateral(
					marketAccount,
					oracleData.price,
					currentPosition,
					baseTradeSize,
					oracleData.price,
					false,
					'Initial'
				);
		}

		return { tradeSize, oppositeSideTradeSize };
	}

	/**
	 * Get the maximum trade size for a given market, taking into account the user's current leverage, positions, collateral, etc.
	 *
	 * @param targetMarketIndex
	 * @param direction Long (increase deposit / reduce borrow) or short (increase borrow / reduce deposit).
	 * @param currentQuoteAssetValue Ignored — always recomputed internally from `getSpotMarketAssetValue(QUOTE_SPOT_MARKET_INDEX)`.
	 * @param currentSpotMarketNetValue Optional pre-computed net value for `targetMarketIndex` (QUOTE_PRECISION, 1e6); if omitted, computed via `getSpotPositionValue`.
	 * @returns tradeSizeAllowed : Precision QUOTE_PRECISION (1e6)
	 */
	public getMaxTradeSizeUSDCForSpot(
		targetMarketIndex: number,
		direction: PositionDirection,
		currentQuoteAssetValue?: BN,
		currentSpotMarketNetValue?: BN
	): BN {
		const market =
			this.velocityClient.getSpotMarketAccountOrThrow(targetMarketIndex);
		const oraclePrice =
			this.velocityClient.getOracleDataForSpotMarket(targetMarketIndex).price;

		currentQuoteAssetValue = this.getSpotMarketAssetValue(
			QUOTE_SPOT_MARKET_INDEX
		);

		currentSpotMarketNetValue =
			currentSpotMarketNetValue ?? this.getSpotPositionValue(targetMarketIndex);

		let freeCollateral = this.getFreeCollateral();
		const marginRatio = calculateSpotMarketMarginRatio(
			market,
			oraclePrice,
			'Initial',
			ZERO,
			isVariant(direction, 'long')
				? SpotBalanceType.DEPOSIT
				: SpotBalanceType.BORROW,
			this.getUserAccountOrThrow().maxMarginRatio
		);

		let tradeAmount = ZERO;
		if (this.getUserAccountOrThrow().isMarginTradingEnabled) {
			// if the user is buying/selling and already short/long, need to account for closing out short/long
			if (isVariant(direction, 'long') && currentSpotMarketNetValue.lt(ZERO)) {
				tradeAmount = currentSpotMarketNetValue.abs();
				const marginRatio = calculateSpotMarketMarginRatio(
					market,
					oraclePrice,
					'Initial',
					this.getTokenAmount(targetMarketIndex).abs(),
					SpotBalanceType.BORROW,
					this.getUserAccountOrThrow().maxMarginRatio
				);
				freeCollateral = freeCollateral.add(
					tradeAmount.mul(new BN(marginRatio)).div(MARGIN_PRECISION)
				);
			} else if (
				isVariant(direction, 'short') &&
				currentSpotMarketNetValue.gt(ZERO)
			) {
				tradeAmount = currentSpotMarketNetValue;
				const marginRatio = calculateSpotMarketMarginRatio(
					market,
					oraclePrice,
					'Initial',
					this.getTokenAmount(targetMarketIndex),
					SpotBalanceType.DEPOSIT,
					this.getUserAccountOrThrow().maxMarginRatio
				);
				freeCollateral = freeCollateral.add(
					tradeAmount.mul(new BN(marginRatio)).div(MARGIN_PRECISION)
				);
			}

			tradeAmount = tradeAmount.add(
				freeCollateral.mul(MARGIN_PRECISION).div(new BN(marginRatio))
			);
		} else if (isVariant(direction, 'long')) {
			tradeAmount = BN.min(
				currentQuoteAssetValue,
				freeCollateral.mul(MARGIN_PRECISION).div(new BN(marginRatio))
			);
		} else {
			tradeAmount = BN.max(ZERO, currentSpotMarketNetValue);
		}

		return tradeAmount;
	}

	/**
	 * Calculates the max amount of token that can be swapped from inMarket to outMarket
	 * Assumes swap happens at oracle price
	 *
	 * @param inMarketIndex
	 * @param outMarketIndex
	 * @param calculateSwap Optional function to simulate the in-to-out conversion (e.g. to model swap fees/slippage); defaults to a 1:1 oracle-price conversion.
	 * @param iterationLimit How many binary-search iterations to run before erroring out. Defaults to 1000.
	 * @returns `inAmount`/`outAmount` in each market's own token decimals, and the resulting `leverage` (TEN_THOUSAND, 1e4 precision) after the swap.
	 */
	public getMaxSwapAmount({
		inMarketIndex,
		outMarketIndex,
		calculateSwap,
		iterationLimit = 1000,
	}: {
		inMarketIndex: number;
		outMarketIndex: number;
		calculateSwap?: (inAmount: BN) => BN;
		iterationLimit?: number;
	}): { inAmount: BN; outAmount: BN; leverage: BN } {
		const inMarket =
			this.velocityClient.getSpotMarketAccountOrThrow(inMarketIndex);
		const outMarket =
			this.velocityClient.getSpotMarketAccountOrThrow(outMarketIndex);

		const inOraclePriceData = this.getOracleDataForSpotMarket(inMarketIndex);
		const inOraclePrice = inOraclePriceData.price;
		const outOraclePriceData = this.getOracleDataForSpotMarket(outMarketIndex);
		const outOraclePrice = outOraclePriceData.price;

		const inStrictOraclePrice = new StrictOraclePrice(inOraclePrice);
		const outStrictOraclePrice = new StrictOraclePrice(outOraclePrice);

		const inPrecision = new BN(10 ** inMarket.decimals);
		const outPrecision = new BN(10 ** outMarket.decimals);

		const inSpotPosition =
			this.getSpotPosition(inMarketIndex) ||
			this.getEmptySpotPosition(inMarketIndex);
		const outSpotPosition =
			this.getSpotPosition(outMarketIndex) ||
			this.getEmptySpotPosition(outMarketIndex);

		const freeCollateral = this.getFreeCollateral();

		const inContributionInitial =
			this.calculateSpotPositionFreeCollateralContribution(
				inSpotPosition,
				inStrictOraclePrice
			);
		const {
			totalAssetValue: inTotalAssetValueInitial,
			totalLiabilityValue: inTotalLiabilityValueInitial,
		} = this.calculateSpotPositionLeverageContribution(
			inSpotPosition,
			inStrictOraclePrice
		);
		const outContributionInitial =
			this.calculateSpotPositionFreeCollateralContribution(
				outSpotPosition,
				outStrictOraclePrice
			);
		const {
			totalAssetValue: outTotalAssetValueInitial,
			totalLiabilityValue: outTotalLiabilityValueInitial,
		} = this.calculateSpotPositionLeverageContribution(
			outSpotPosition,
			outStrictOraclePrice
		);
		const initialContribution = inContributionInitial.add(
			outContributionInitial
		);

		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		if (!calculateSwap) {
			calculateSwap = (inSwap: BN) => {
				return inSwap
					.mul(outPrecision)
					.mul(inOraclePrice)
					.div(outOraclePrice)
					.div(inPrecision);
			};
		}

		let inSwap = ZERO;
		let outSwap = ZERO;
		const inTokenAmount = this.getTokenAmount(inMarketIndex);
		const outTokenAmount = this.getTokenAmount(outMarketIndex);

		const inAssetWeight = calculateAssetWeight(
			inTokenAmount,
			inOraclePriceData.price,
			inMarket,
			'Initial'
		);
		const outAssetWeight = calculateAssetWeight(
			outTokenAmount,
			outOraclePriceData.price,
			outMarket,
			'Initial'
		);

		const outSaferThanIn =
			// selling asset to close borrow
			(inTokenAmount.gt(ZERO) && outTokenAmount.lt(ZERO)) ||
			// buying asset with higher initial asset weight
			inAssetWeight.lte(outAssetWeight);

		if (freeCollateral.lt(PRICE_PRECISION.divn(100))) {
			if (outSaferThanIn && inTokenAmount.gt(ZERO)) {
				inSwap = inTokenAmount;
				outSwap = calculateSwap(inSwap);
			}
		} else {
			let minSwap = ZERO;
			let maxSwap = BN.max(
				freeCollateral.mul(inPrecision).mul(new BN(100)).div(inOraclePrice), // 100x current free collateral
				inTokenAmount.abs().mul(new BN(10)) // 10x current position
			);
			inSwap = maxSwap.div(TWO);
			const error = freeCollateral.div(new BN(10000));

			let i = 0;
			let freeCollateralAfter = freeCollateral;
			while (freeCollateralAfter.gt(error) || freeCollateralAfter.isNeg()) {
				outSwap = calculateSwap(inSwap);

				const inPositionAfter = this.cloneAndUpdateSpotPosition(
					inSpotPosition,
					inSwap.neg(),
					inMarket
				);
				const outPositionAfter = this.cloneAndUpdateSpotPosition(
					outSpotPosition,
					outSwap,
					outMarket
				);

				const inContributionAfter =
					this.calculateSpotPositionFreeCollateralContribution(
						inPositionAfter,
						inStrictOraclePrice
					);
				const outContributionAfter =
					this.calculateSpotPositionFreeCollateralContribution(
						outPositionAfter,
						outStrictOraclePrice
					);

				const contributionAfter = inContributionAfter.add(outContributionAfter);

				const contributionDelta = contributionAfter.sub(initialContribution);

				freeCollateralAfter = freeCollateral.add(contributionDelta);

				if (freeCollateralAfter.gt(error)) {
					minSwap = inSwap;
					inSwap = minSwap.add(maxSwap).div(TWO);
				} else if (freeCollateralAfter.isNeg()) {
					maxSwap = inSwap;
					inSwap = minSwap.add(maxSwap).div(TWO);
				}

				if (i++ > iterationLimit) {
					console.log('getMaxSwapAmount iteration limit reached');
					break;
				}
			}
		}

		const inPositionAfter = this.cloneAndUpdateSpotPosition(
			inSpotPosition,
			inSwap.neg(),
			inMarket
		);
		const outPositionAfter = this.cloneAndUpdateSpotPosition(
			outSpotPosition,
			outSwap,
			outMarket
		);

		const {
			totalAssetValue: inTotalAssetValueAfter,
			totalLiabilityValue: inTotalLiabilityValueAfter,
		} = this.calculateSpotPositionLeverageContribution(
			inPositionAfter,
			inStrictOraclePrice
		);

		const {
			totalAssetValue: outTotalAssetValueAfter,
			totalLiabilityValue: outTotalLiabilityValueAfter,
		} = this.calculateSpotPositionLeverageContribution(
			outPositionAfter,
			outStrictOraclePrice
		);

		const spotAssetValueDelta = inTotalAssetValueAfter
			.add(outTotalAssetValueAfter)
			.sub(inTotalAssetValueInitial)
			.sub(outTotalAssetValueInitial);
		const spotLiabilityValueDelta = inTotalLiabilityValueAfter
			.add(outTotalLiabilityValueAfter)
			.sub(inTotalLiabilityValueInitial)
			.sub(outTotalLiabilityValueInitial);

		const spotAssetValueAfter = spotAssetValue.add(spotAssetValueDelta);
		const spotLiabilityValueAfter = spotLiabilityValue.add(
			spotLiabilityValueDelta
		);

		const leverage = this.calculateLeverageFromComponents({
			perpLiabilityValue,
			perpPnl,
			spotAssetValue: spotAssetValueAfter,
			spotLiabilityValue: spotLiabilityValueAfter,
		});

		return { inAmount: inSwap, outAmount: outSwap, leverage };
	}

	/**
	 * Returns a cloned `SpotPosition` with `tokenAmount` (signed, positive =
	 * deposit / negative = borrow) applied on top of the existing balance —
	 * used to simulate the post-trade/post-swap position without mutating the
	 * cached account.
	 * @param tokenAmount Signed delta in `market`'s own token decimals.
	 */
	public cloneAndUpdateSpotPosition(
		position: SpotPosition,
		tokenAmount: BN,
		market: SpotMarketAccount
	): SpotPosition {
		const clonedPosition = Object.assign({}, position);
		if (tokenAmount.eq(ZERO)) {
			return clonedPosition;
		}

		const preTokenAmount = getSignedTokenAmount(
			getTokenAmount(position.scaledBalance, market, position.balanceType),
			position.balanceType
		);

		if (sigNum(preTokenAmount).eq(sigNum(tokenAmount))) {
			const scaledBalanceDelta = getBalance(
				tokenAmount.abs(),
				market,
				position.balanceType
			);
			clonedPosition.scaledBalance =
				clonedPosition.scaledBalance.add(scaledBalanceDelta);
			return clonedPosition;
		}

		const updateDirection = tokenAmount.isNeg()
			? SpotBalanceType.BORROW
			: SpotBalanceType.DEPOSIT;

		if (tokenAmount.abs().gte(preTokenAmount.abs())) {
			clonedPosition.scaledBalance = getBalance(
				tokenAmount.abs().sub(preTokenAmount.abs()),
				market,
				updateDirection
			);
			clonedPosition.balanceType = updateDirection;
		} else {
			const scaledBalanceDelta = getBalance(
				tokenAmount.abs(),
				market,
				position.balanceType
			);

			clonedPosition.scaledBalance =
				clonedPosition.scaledBalance.sub(scaledBalanceDelta);
		}
		return clonedPosition;
	}

	/** Worst-case free-collateral contribution (under `'Initial'` margin) of a single spot position. Returns QUOTE_PRECISION (1e6). */
	calculateSpotPositionFreeCollateralContribution(
		spotPosition: SpotPosition,
		strictOraclePrice: StrictOraclePrice
	): BN {
		const marginCategory = 'Initial';

		const spotMarketAccount: SpotMarketAccount =
			this.velocityClient.getSpotMarketAccountOrThrow(spotPosition.marketIndex);

		const { freeCollateralContribution } = getWorstCaseTokenAmounts(
			spotPosition,
			spotMarketAccount,
			strictOraclePrice,
			marginCategory,
			this.getUserAccountOrThrow().maxMarginRatio
		);

		return freeCollateralContribution;
	}

	/** Worst-case (under `'Initial'` margin) asset/liability value split of a single spot position, for use in leverage calculations. Both fields QUOTE_PRECISION (1e6), non-negative. */
	calculateSpotPositionLeverageContribution(
		spotPosition: SpotPosition,
		strictOraclePrice: StrictOraclePrice
	): {
		totalAssetValue: BN;
		totalLiabilityValue: BN;
	} {
		let totalAssetValue = ZERO;
		let totalLiabilityValue = ZERO;

		const spotMarketAccount: SpotMarketAccount =
			this.velocityClient.getSpotMarketAccountOrThrow(spotPosition.marketIndex);

		const { tokenValue, ordersValue } = getWorstCaseTokenAmounts(
			spotPosition,
			spotMarketAccount,
			strictOraclePrice,
			'Initial',
			this.getUserAccountOrThrow().maxMarginRatio
		);

		if (tokenValue.gte(ZERO)) {
			totalAssetValue = tokenValue;
		} else {
			totalLiabilityValue = tokenValue.abs();
		}

		if (ordersValue.gt(ZERO)) {
			totalAssetValue = totalAssetValue.add(ordersValue);
		} else {
			totalLiabilityValue = totalLiabilityValue.add(ordersValue.abs());
		}

		return {
			totalAssetValue,
			totalLiabilityValue,
		};
	}

	/**
	 * Estimates what the user leverage will be after swap
	 * @param inMarketIndex Market being sold/paid from.
	 * @param outMarketIndex Market being bought/received.
	 * @param inAmount Amount removed from `inMarketIndex`, that market's own token decimals.
	 * @param outAmount Amount added to `outMarketIndex`, that market's own token decimals.
	 * @returns Precision TEN_THOUSAND (1e4, i.e. `10000` = 1x).
	 */
	public accountLeverageAfterSwap({
		inMarketIndex,
		outMarketIndex,
		inAmount,
		outAmount,
	}: {
		inMarketIndex: number;
		outMarketIndex: number;
		inAmount: BN;
		outAmount: BN;
	}): BN {
		const inMarket =
			this.velocityClient.getSpotMarketAccountOrThrow(inMarketIndex);
		const outMarket =
			this.velocityClient.getSpotMarketAccountOrThrow(outMarketIndex);

		const inOraclePriceData = this.getOracleDataForSpotMarket(inMarketIndex);
		const inOraclePrice = inOraclePriceData.price;
		const outOraclePriceData = this.getOracleDataForSpotMarket(outMarketIndex);
		const outOraclePrice = outOraclePriceData.price;
		const inStrictOraclePrice = new StrictOraclePrice(inOraclePrice);
		const outStrictOraclePrice = new StrictOraclePrice(outOraclePrice);

		const inSpotPosition =
			this.getSpotPosition(inMarketIndex) ||
			this.getEmptySpotPosition(inMarketIndex);
		const outSpotPosition =
			this.getSpotPosition(outMarketIndex) ||
			this.getEmptySpotPosition(outMarketIndex);

		const {
			totalAssetValue: inTotalAssetValueInitial,
			totalLiabilityValue: inTotalLiabilityValueInitial,
		} = this.calculateSpotPositionLeverageContribution(
			inSpotPosition,
			inStrictOraclePrice
		);
		const {
			totalAssetValue: outTotalAssetValueInitial,
			totalLiabilityValue: outTotalLiabilityValueInitial,
		} = this.calculateSpotPositionLeverageContribution(
			outSpotPosition,
			outStrictOraclePrice
		);

		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const inPositionAfter = this.cloneAndUpdateSpotPosition(
			inSpotPosition,
			inAmount.abs().neg(),
			inMarket
		);
		const outPositionAfter = this.cloneAndUpdateSpotPosition(
			outSpotPosition,
			outAmount.abs(),
			outMarket
		);

		const {
			totalAssetValue: inTotalAssetValueAfter,
			totalLiabilityValue: inTotalLiabilityValueAfter,
		} = this.calculateSpotPositionLeverageContribution(
			inPositionAfter,
			inStrictOraclePrice
		);

		const {
			totalAssetValue: outTotalAssetValueAfter,
			totalLiabilityValue: outTotalLiabilityValueAfter,
		} = this.calculateSpotPositionLeverageContribution(
			outPositionAfter,
			outStrictOraclePrice
		);

		const spotAssetValueDelta = inTotalAssetValueAfter
			.add(outTotalAssetValueAfter)
			.sub(inTotalAssetValueInitial)
			.sub(outTotalAssetValueInitial);
		const spotLiabilityValueDelta = inTotalLiabilityValueAfter
			.add(outTotalLiabilityValueAfter)
			.sub(inTotalLiabilityValueInitial)
			.sub(outTotalLiabilityValueInitial);

		const spotAssetValueAfter = spotAssetValue.add(spotAssetValueDelta);
		const spotLiabilityValueAfter = spotLiabilityValue.add(
			spotLiabilityValueDelta
		);

		return this.calculateLeverageFromComponents({
			perpLiabilityValue,
			perpPnl,
			spotAssetValue: spotAssetValueAfter,
			spotLiabilityValue: spotLiabilityValueAfter,
		});
	}

	// TODO - should this take the price impact of the trade into account for strict accuracy?

	/**
	 * Returns the leverage ratio for the account after adding (or subtracting) the given quote size to the given position
	 * @param targetMarketIndex
	 * @param targetMarketType Whether the trade is on a perp or spot market — the two use different valuation paths.
	 * @param tradeQuoteAmount Quote size of the simulated trade, QUOTE_PRECISION (1e6).
	 * @param tradeSide Direction of the simulated trade.
	 * @param includeOpenOrders Include existing open orders' worst-case impact in both the before/after values. Defaults to true.
	 * @returns leverageRatio : Precision TEN_THOUSAND (1e4, i.e. `10000` = 1x)
	 */
	public accountLeverageRatioAfterTrade(
		targetMarketIndex: number,
		targetMarketType: MarketType,
		tradeQuoteAmount: BN,
		tradeSide: PositionDirection,
		includeOpenOrders = true
	): BN {
		const tradeIsPerp = isVariant(targetMarketType, 'perp');

		if (!tradeIsPerp) {
			// calculate new asset/liability values for base and quote market to find new account leverage
			const totalLiabilityValue = this.getTotalLiabilityValue();
			const totalAssetValue = this.getTotalAssetValue();
			const spotLiabilityValue = this.getSpotMarketLiabilityValue(
				undefined,
				undefined,
				undefined,
				includeOpenOrders
			);

			const currentQuoteAssetValue = this.getSpotMarketAssetValue(
				QUOTE_SPOT_MARKET_INDEX,
				undefined,
				includeOpenOrders
			);
			const currentQuoteLiabilityValue = this.getSpotMarketLiabilityValue(
				QUOTE_SPOT_MARKET_INDEX,
				undefined,
				undefined,
				includeOpenOrders
			);
			const currentQuoteValue = currentQuoteAssetValue.sub(
				currentQuoteLiabilityValue
			);

			const currentSpotMarketAssetValue = this.getSpotMarketAssetValue(
				targetMarketIndex,
				undefined,
				includeOpenOrders
			);
			const currentSpotMarketLiabilityValue = this.getSpotMarketLiabilityValue(
				targetMarketIndex,
				undefined,
				undefined,
				includeOpenOrders
			);
			const currentSpotMarketNetValue = currentSpotMarketAssetValue.sub(
				currentSpotMarketLiabilityValue
			);

			let assetValueToAdd = ZERO;
			let liabilityValueToAdd = ZERO;

			const newQuoteNetValue =
				tradeSide == PositionDirection.SHORT
					? currentQuoteValue.add(tradeQuoteAmount)
					: currentQuoteValue.sub(tradeQuoteAmount);
			const newQuoteAssetValue = BN.max(newQuoteNetValue, ZERO);
			const newQuoteLiabilityValue = BN.min(newQuoteNetValue, ZERO).abs();

			assetValueToAdd = assetValueToAdd.add(
				newQuoteAssetValue.sub(currentQuoteAssetValue)
			);
			liabilityValueToAdd = liabilityValueToAdd.add(
				newQuoteLiabilityValue.sub(currentQuoteLiabilityValue)
			);

			const newSpotMarketNetValue =
				tradeSide == PositionDirection.LONG
					? currentSpotMarketNetValue.add(tradeQuoteAmount)
					: currentSpotMarketNetValue.sub(tradeQuoteAmount);
			const newSpotMarketAssetValue = BN.max(newSpotMarketNetValue, ZERO);
			const newSpotMarketLiabilityValue = BN.min(
				newSpotMarketNetValue,
				ZERO
			).abs();

			assetValueToAdd = assetValueToAdd.add(
				newSpotMarketAssetValue.sub(currentSpotMarketAssetValue)
			);
			liabilityValueToAdd = liabilityValueToAdd.add(
				newSpotMarketLiabilityValue.sub(currentSpotMarketLiabilityValue)
			);

			const totalAssetValueAfterTrade = totalAssetValue.add(assetValueToAdd);
			const totalSpotLiabilityValueAfterTrade =
				spotLiabilityValue.add(liabilityValueToAdd);

			const totalLiabilityValueAfterTrade =
				totalLiabilityValue.add(liabilityValueToAdd);

			const netAssetValueAfterTrade = totalAssetValueAfterTrade.sub(
				totalSpotLiabilityValueAfterTrade
			);

			if (netAssetValueAfterTrade.eq(ZERO)) {
				return ZERO;
			}

			const newLeverage = totalLiabilityValueAfterTrade
				.mul(TEN_THOUSAND)
				.div(netAssetValueAfterTrade);

			return newLeverage;
		}

		const currentPosition = this.getPerpPositionOrEmpty(targetMarketIndex);

		const perpMarket =
			this.velocityClient.getPerpMarketAccountOrThrow(targetMarketIndex);
		const oracleData = this.getOracleDataForPerpMarket(targetMarketIndex);

		let {
			// eslint-disable-next-line prefer-const
			worstCaseBaseAssetAmount: worstCaseBase,
			worstCaseLiabilityValue: currentPositionQuoteAmount,
		} = calculateWorstCasePerpLiabilityValue(
			currentPosition,
			perpMarket,
			oracleData.price
		);

		// current side is short if position base asset amount is negative OR there is no position open but open orders are short
		const currentSide =
			currentPosition.baseAssetAmount.isNeg() ||
			(currentPosition.baseAssetAmount.eq(ZERO) && worstCaseBase.isNeg())
				? PositionDirection.SHORT
				: PositionDirection.LONG;

		if (currentSide === PositionDirection.SHORT)
			currentPositionQuoteAmount = currentPositionQuoteAmount.neg();

		if (tradeSide === PositionDirection.SHORT)
			tradeQuoteAmount = tradeQuoteAmount.neg();

		const currentPerpPositionAfterTrade = currentPositionQuoteAmount
			.add(tradeQuoteAmount)
			.abs();

		const totalPositionAfterTradeExcludingTargetMarket =
			this.getTotalPerpPositionValueExcludingMarket(
				targetMarketIndex,
				undefined,
				undefined,
				includeOpenOrders
			);

		const totalAssetValue = this.getTotalAssetValue();

		const totalPerpPositionLiability = currentPerpPositionAfterTrade
			.add(totalPositionAfterTradeExcludingTargetMarket)
			.abs();

		const totalSpotLiability = this.getSpotMarketLiabilityValue(
			undefined,
			undefined,
			undefined,
			includeOpenOrders
		);

		const totalLiabilitiesAfterTrade =
			totalPerpPositionLiability.add(totalSpotLiability);

		const netAssetValue = totalAssetValue.sub(totalSpotLiability);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const newLeverage = totalLiabilitiesAfterTrade
			.mul(TEN_THOUSAND)
			.div(netAssetValue);

		return newLeverage;
	}

	/**
	 * Looks up the user's fee tier from the state account's fee structure.
	 *
	 * For perp markets, the tier is selected by the user's rolling 30-day
	 * volume (`getUser30dRollingVolumeEstimate`, QUOTE_PRECISION) against fixed
	 * breakpoints — $2M, $10M, $20M, $80M, $200M — picking the lowest-index
	 * tier whose breakpoint the user's volume is still under (tier 5, the
	 * lowest fees, if volume meets or exceeds the top breakpoint). Spot markets
	 * always use tier 0 (no volume-based discount).
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`.
	 * @param now Optional unix timestamp (seconds) to evaluate the rolling volume window as of; defaults to current time.
	 * @returns The matching `FeeTier` (numerator/denominator fee fractions and referee-discount fractions).
	 */
	public getUserFeeTier(marketType: MarketType, now?: BN) {
		const state = this.velocityClient.getStateAccount();

		if (isVariant(marketType, 'perp')) {
			const userStatsAccount: UserStatsAccount = this.velocityClient
				.getUserStatsOrThrow()
				.getAccountOrThrow();

			const total30dVolume = getUser30dRollingVolumeEstimate(
				userStatsAccount,
				now
			);

			const volumeThresholds = [
				new BN(2_000_000).mul(QUOTE_PRECISION),
				new BN(10_000_000).mul(QUOTE_PRECISION),
				new BN(20_000_000).mul(QUOTE_PRECISION),
				new BN(80_000_000).mul(QUOTE_PRECISION),
				new BN(200_000_000).mul(QUOTE_PRECISION),
			];

			let feeTierIndex = 5;
			for (let i = 0; i < volumeThresholds.length; i++) {
				if (total30dVolume.lt(volumeThresholds[i])) {
					feeTierIndex = i;
					break;
				}
			}

			return state.perpFeeStructure.feeTiers[feeTierIndex];
		}

		return state.spotFeeStructure.feeTiers[0];
	}

	/**
	 * Calculates how much perp fee will be taken for a given sized trade.
	 *
	 * When `marketIndex` is provided, delegates to `VelocityClient.getMarketFees`
	 * for that specific market's taker-fee multiplier (which itself applies the
	 * market's `feeAdjustment`, the referee discount, and — when `builderInfo` is
	 * passed — the builder fee). Otherwise uses the volume-based fee tier from
	 * `getUserFeeTier(MarketType.PERP)`; if the user is a referee (determined
	 * from `UserStats.referrerStatus`'s `IsReferred` flag unless `isReferee` is
	 * explicitly passed), the tier's `refereeFeeNumerator`/`refereeFeeDenominator`
	 * proportion is subtracted from the fee as a discount, and — when `builderInfo`
	 * carries a builder code — the builder fee (`quoteAmount * builderFeeTenthBps /
	 * 100_000`) is added on top, mirroring the program's `builder_fee` (`math/fees.rs`).
	 * @param quoteAmount Trade size, QUOTE_PRECISION (1e6).
	 * @param marketIndex Optional perp market to use `VelocityClient.getMarketFees` for instead of the volume-tier fee structure.
	 * @param isReferee Optional override for whether the referee discount applies; defaults to the user's actual `UserStats` referred status. Ignored on the `marketIndex` path (which reads referee status inside `getMarketFees`).
	 * @param builderInfo Optional builder code; when it carries `builderIdx` + `builderFeeTenthBps`, the builder fee is added on top of the tiered fee.
	 * @returns feeForQuote : Precision QUOTE_PRECISION (1e6)
	 */
	public calculatePerpTakerFee(
		quoteAmount: BN,
		marketIndex?: number,
		isReferee?: boolean,
		builderInfo?: Pick<OrderParams, 'builderIdx' | 'builderFeeTenthBps'>
	): BN {
		if (marketIndex !== undefined) {
			const takerFeeMultiplier = this.velocityClient.getMarketFees(
				MarketType.PERP,
				marketIndex,
				this,
				builderInfo
			).takerFee;
			const feeAmountNum =
				BigNum.from(quoteAmount, QUOTE_PRECISION_EXP).toNum() *
				takerFeeMultiplier;
			return BigNum.fromPrint(feeAmountNum.toString(), QUOTE_PRECISION_EXP).val;
		} else {
			const feeTier = this.getUserFeeTier(MarketType.PERP);
			let fee = divCeil(
				quoteAmount.mul(new BN(feeTier.feeNumerator)),
				new BN(feeTier.feeDenominator)
			);

			const isUserReferee =
				isReferee ??
				(this.velocityClient.getUserStatsOrThrow().getAccountOrThrow()
					.referrerStatus &
					ReferrerStatus.IsReferred) >
					0;

			if (isUserReferee) {
				const refereeDiscount = getProportion128(
					fee,
					new BN(feeTier.refereeFeeNumerator),
					new BN(feeTier.refereeFeeDenominator)
				);
				fee = fee.sub(refereeDiscount);
			}

			// Builder fee (M12): charged on top of the tiered fee, on the raw quote
			// (independent of the referee discount), mirroring `builder_fee` in `math/fees.rs`.
			if (builderInfo && hasBuilderParams(builderInfo)) {
				fee = fee.add(
					calculateBuilderFee(quoteAmount, builderInfo.builderFeeTenthBps!)
				);
			}

			return fee;
		}
	}

	/**
	 * Calculates a user's max withdrawal amounts for a spot market. If reduceOnly is true,
	 * it will return the max withdrawal amount without opening a liability for the user.
	 *
	 * Combines three caps: the market-wide withdraw/borrow guard
	 * (`calculateWithdrawLimit`, a rolling-window rate limit on the spot
	 * market), the user's own deposit balance, and how much their free
	 * collateral supports withdrawing/borrowing. If `canBypassWithdrawLimits`
	 * returns `canBypass: true` (see that method), the market-wide withdraw
	 * limit floor is raised to the user's full deposit amount — letting a
	 * small, healthy, always-net-positive depositor withdraw in full even if
	 * the market-wide guard would otherwise throttle them.
	 * @param marketIndex
	 * @param reduceOnly If true, caps the result so the withdrawal cannot open a borrow (never exceeds the user's current deposit). If false/omitted, may return an amount larger than the deposit, up to the user's max allowed new liability.
	 * @returns withdrawalLimit : Precision is the token precision for the chosen SpotMarket
	 */
	public getWithdrawalLimit(marketIndex: number, reduceOnly?: boolean): BN {
		const nowTs = new BN(Math.floor(Date.now() / 1000));
		const spotMarket =
			this.velocityClient.getSpotMarketAccountOrThrow(marketIndex);

		// eslint-disable-next-line prefer-const
		let { borrowLimit, withdrawLimit } = calculateWithdrawLimit(
			spotMarket,
			nowTs
		);

		const freeCollateral = this.getFreeCollateral();
		const initialMarginRequirement = this.getInitialMarginRequirement();
		const oracleData = this.getOracleDataForSpotMarket(marketIndex);
		const { numeratorScale, denominatorScale } =
			spotMarket.decimals > 6
				? {
						numeratorScale: new BN(10).pow(new BN(spotMarket.decimals - 6)),
						denominatorScale: new BN(1),
				  }
				: {
						numeratorScale: new BN(1),
						denominatorScale: new BN(10).pow(new BN(6 - spotMarket.decimals)),
				  };

		const { canBypass, depositAmount: userDepositAmount } =
			this.canBypassWithdrawLimits(marketIndex);
		if (canBypass) {
			withdrawLimit = BN.max(withdrawLimit, userDepositAmount);
		}

		const assetWeight = calculateAssetWeight(
			userDepositAmount,
			oracleData.price,
			spotMarket,
			'Initial'
		);

		let amountWithdrawable;
		if (assetWeight.eq(ZERO)) {
			amountWithdrawable = userDepositAmount;
		} else if (initialMarginRequirement.eq(ZERO)) {
			amountWithdrawable = userDepositAmount;
		} else {
			amountWithdrawable = divCeil(
				divCeil(freeCollateral.mul(MARGIN_PRECISION), assetWeight).mul(
					PRICE_PRECISION
				),
				oracleData.price
			)
				.mul(numeratorScale)
				.div(denominatorScale);
		}

		const maxWithdrawValue = BN.min(
			BN.min(amountWithdrawable, userDepositAmount),
			withdrawLimit.abs()
		);

		if (reduceOnly) {
			return BN.max(maxWithdrawValue, ZERO);
		} else {
			const weightedAssetValue = this.getSpotMarketAssetValue(
				marketIndex,
				'Initial',
				false
			);

			const freeCollatAfterWithdraw = userDepositAmount.gt(ZERO)
				? freeCollateral.sub(weightedAssetValue)
				: freeCollateral;

			const maxLiabilityAllowed = freeCollatAfterWithdraw
				.mul(MARGIN_PRECISION)
				.div(new BN(spotMarket.initialLiabilityWeight))
				.mul(PRICE_PRECISION)
				.div(oracleData.price)
				.mul(numeratorScale)
				.div(denominatorScale);

			const maxBorrowValue = BN.min(
				maxWithdrawValue.add(maxLiabilityAllowed),
				borrowLimit.abs()
			);

			return BN.max(maxBorrowValue, ZERO);
		}
	}

	/**
	 * Determines whether the user can bypass the spot market's rolling
	 * withdraw-guard limit for `marketIndex`. `canBypass` is true only when
	 * **all** of the following hold:
	 *   - The user currently holds a deposit (not a borrow) in the market.
	 *   - Their lifetime net deposits (`totalDeposits - totalWithdraws`) are
	 *     non-negative — they have never net-withdrawn more than they net-deposited.
	 *   - Their `cumulativeDeposits` for the position has never gone negative
	 *     (no history of having borrowed and repaid in this market).
	 *   - Their current deposit amount is below `maxDepositAmount`, i.e. 10% of
	 *     the spot market's `withdrawGuardThreshold`.
	 *
	 * This lets a small, well-behaved depositor withdraw their own funds in
	 * full even while the market-wide withdraw guard is actively throttling
	 * larger movements. Used by `getWithdrawalLimit`.
	 * @param marketIndex
	 * @returns `canBypass`; `netDeposits` (lifetime `totalDeposits - totalWithdraws`, QUOTE_PRECISION, 1e6); `depositAmount` and `maxDepositAmount`, both in the spot market's own token decimals.
	 */
	public canBypassWithdrawLimits(marketIndex: number): {
		canBypass: boolean;
		netDeposits: BN;
		depositAmount: BN;
		maxDepositAmount: BN;
	} {
		const spotMarket =
			this.velocityClient.getSpotMarketAccountOrThrow(marketIndex);
		const maxDepositAmount = spotMarket.withdrawGuardThreshold.div(new BN(10));
		const position = this.getSpotPosition(marketIndex);

		const netDeposits = this.getUserAccountOrThrow().totalDeposits.sub(
			this.getUserAccountOrThrow().totalWithdraws
		);

		if (!position) {
			return {
				canBypass: false,
				maxDepositAmount,
				depositAmount: ZERO,
				netDeposits,
			};
		}

		if (isVariant(position.balanceType, 'borrow')) {
			return {
				canBypass: false,
				maxDepositAmount,
				netDeposits,
				depositAmount: ZERO,
			};
		}

		const depositAmount = getTokenAmount(
			position.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		if (netDeposits.lt(ZERO)) {
			return {
				canBypass: false,
				maxDepositAmount,
				depositAmount,
				netDeposits,
			};
		}

		if (position.cumulativeDeposits.lt(ZERO)) {
			return {
				canBypass: false,
				maxDepositAmount,
				depositAmount,
				netDeposits,
			};
		}

		return {
			canBypass: depositAmount.lt(maxDepositAmount),
			maxDepositAmount,
			netDeposits,
			depositAmount,
		};
	}

	/**
	 * Determines whether the user can be marked idle (excluded from userMap
	 * subscriptions by default, and skipped by most keeper crank passes) as of
	 * `slot`. Requires: not already idle; inactive for the required window
	 * since `lastActiveSlot` (1 hour / 9,000 slots if equity is under $1,000,
	 * otherwise 1 week / 1,512,000 slots); not currently being liquidated; and
	 * no open perp positions, borrows, spot open orders, or open orders of any kind.
	 * @param slot Current slot to evaluate inactivity against.
	 */
	public canMakeIdle(slot: BN): boolean {
		const userAccount = this.getUserAccountOrThrow();
		if (userAccount.idle) {
			return false;
		}

		const { totalAssetValue, totalLiabilityValue } =
			this.getSpotMarketAssetAndLiabilityValue();
		const equity = totalAssetValue.sub(totalLiabilityValue);

		let slotsBeforeIdle: BN;
		if (equity.lt(QUOTE_PRECISION.muln(1000))) {
			slotsBeforeIdle = new BN(9000); // 1 hour
		} else {
			slotsBeforeIdle = new BN(1512000); // 1 week
		}

		const userLastActiveSlot = userAccount.lastActiveSlot;
		const slotsSinceLastActive = slot.sub(userLastActiveSlot);
		if (slotsSinceLastActive.lt(slotsBeforeIdle)) {
			return false;
		}

		if (this.isBeingLiquidated()) {
			return false;
		}

		for (const perpPosition of userAccount.perpPositions) {
			if (!positionIsAvailable(perpPosition)) {
				return false;
			}
		}

		for (const spotPosition of userAccount.spotPositions) {
			if (
				isVariant(spotPosition.balanceType, 'borrow') &&
				spotPosition.scaledBalance.gt(ZERO)
			) {
				return false;
			}

			if (spotPosition.openOrders !== 0) {
				return false;
			}
		}

		for (const order of userAccount.orders) {
			if (isVariant(order.status, 'open')) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Determines whether this `User` (sub)account can be deleted (checked
	 * before sending a delete-user instruction, to give a friendlier error than
	 * an on-chain revert). Returns `canDelete: false` with a `reason` string if
	 * any of the following hold: it's a referrer's sub-account 0 (referrers
	 * cannot delete their primary account); the account is bankrupt or being
	 * liquidated; it has any non-empty perp/spot position or open order; or
	 * (when the state account charges an initialize-user fee) the account is a
	 * "fresh" account — younger than `ACCOUNT_AGE_DELETION_CUTOFF_SECONDS`,
	 * measured from its earliest recorded filler/maker/taker volume timestamp —
	 * that is not currently idle.
	 * @param userStatsAccount Optional pre-fetched `UserStatsAccount`; defaults to `VelocityClient.getUserStatsOrThrow().getAccount()`.
	 * @param now Optional unix timestamp (seconds) to evaluate account age against; defaults to current time.
	 */
	public canBeDeleted(
		userStatsAccount?: UserStatsAccount,
		now?: BN
	): { canDelete: boolean; reason?: string } {
		const userAccount = this.getUserAccountOrThrow();
		const userStatsAccountToUse =
			userStatsAccount ??
			this.velocityClient.getUserStatsOrThrow().getAccount();
		const nowInSeconds = now || new BN(Math.floor(Date.now() / 1000));
		const stateAccount = this.velocityClient.getStateAccount();

		// Referrer cannot delete sub_account_id 0
		const isReferrer =
			userStatsAccountToUse !== undefined &&
			(userStatsAccountToUse.referrerStatus & ReferrerStatus.IsReferrer) > 0;
		if (isReferrer && userAccount.subAccountId === 0) {
			return { canDelete: false, reason: 'is-subaccount-0-referrer' };
		}

		if (this.isBankrupt()) {
			return { canDelete: false, reason: 'is-bankrupt' };
		}

		if (this.isBeingLiquidated()) {
			return { canDelete: false, reason: 'is-being-liquidated' };
		}

		// Any perp positions available
		for (const perpPosition of userAccount.perpPositions) {
			if (!positionIsAvailable(perpPosition)) {
				return { canDelete: false, reason: 'has-perp-position' };
			}
		}

		// Any spot positions available
		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				return { canDelete: false, reason: 'has-spot-position' };
			}
		}

		// No open orders
		for (const order of userAccount.orders) {
			if (isVariant(order.status, 'open')) {
				return { canDelete: false, reason: 'has-open-order' };
			}
		}

		// Fresh account (< 13 days) with init fee must be idle
		if (stateAccount.maxInitializeUserFee > 0 && userStatsAccountToUse) {
			const minActionTs = BN.min(
				userStatsAccountToUse.lastFillerVolume30DTs,
				BN.min(
					userStatsAccountToUse.lastMakerVolume30DTs,
					userStatsAccountToUse.lastTakerVolume30DTs
				)
			);
			const estimatedAge = BN.max(nowInSeconds.sub(minActionTs), ZERO);
			if (estimatedAge.lt(new BN(ACCOUNT_AGE_DELETION_CUTOFF_SECONDS))) {
				if (!userAccount.idle) {
					return {
						canDelete: false,
						reason: 'is-not-idle-fresh-account',
					};
				}
			}
		}

		return { canDelete: true };
	}

	/**
	 * Returns the numerically-lowest (i.e. safest) contract/asset tier across
	 * the user's active positions — perp tiers from active perp positions,
	 * spot tiers only from spot **borrows** (deposits are skipped, since asset
	 * tier only restricts borrowing exposure). Defaults to `4` (the
	 * second-riskiest tier index) when the user has no positions of that kind —
	 * this is a permissive default intended for callers doing tier-safety
	 * comparisons (see `perpTierIsAsSafeAs` in `math/tiers`), not a claim that
	 * "no position" is itself a risky tier.
	 * @returns Lower `perpTier`/`spotTier` numbers indicate a safer tier; see `math/tiers` (`getPerpMarketTierNumber`/`getSpotMarketTierNumber`) for the numbering.
	 */
	public getSafestTiers(): { perpTier: number; spotTier: number } {
		let safestPerpTier = 4;
		let safestSpotTier = 4;

		for (const perpPosition of this.getActivePerpPositions()) {
			safestPerpTier = Math.min(
				safestPerpTier,
				getPerpMarketTierNumber(
					this.velocityClient.getPerpMarketAccountOrThrow(
						perpPosition.marketIndex
					)
				)
			);
		}

		for (const spotPosition of this.getActiveSpotPositions()) {
			if (isVariant(spotPosition.balanceType, 'deposit')) {
				continue;
			}

			safestSpotTier = Math.min(
				safestSpotTier,
				getSpotMarketTierNumber(
					this.velocityClient.getSpotMarketAccountOrThrow(
						spotPosition.marketIndex
					)
				)
			);
		}

		return {
			perpTier: safestPerpTier,
			spotTier: safestSpotTier,
		};
	}

	/**
	 * Breaks down a single perp position's contribution to the margin system
	 * as a `HealthComponent`: worst-case base size, its unweighted liability
	 * value, the applicable margin ratio (`weight`), and the resulting
	 * weighted margin requirement (`weightedValue`, which includes the
	 * position's open-order margin add-on). Used to build up
	 * `getHealthComponents`' `perpPositions` array (e.g. for UI breakdowns of
	 * "what's consuming my margin").
	 * @param marginCategory `'Initial'` or `'Maintenance'`.
	 * @param perpPosition Position to evaluate.
	 * @param oraclePriceData Optional oracle price override for the perp market; defaults to the live oracle price.
	 * @param quoteOraclePriceData Optional oracle price override for the quote spot market; defaults to the live oracle price.
	 * @param includeOpenOrders Include worst-case open-order exposure. Defaults to true.
	 * @returns `size` is BASE_PRECISION (1e9); `value`/`weightedValue` are QUOTE_PRECISION (1e6); `weight` is MARGIN_PRECISION (1e4).
	 */
	public getPerpPositionHealth({
		marginCategory,
		perpPosition,
		oraclePriceData,
		quoteOraclePriceData,
		includeOpenOrders = true,
	}: {
		marginCategory: MarginCategory;
		perpPosition: PerpPosition;
		oraclePriceData?: OraclePriceData;
		quoteOraclePriceData?: OraclePriceData;
		includeOpenOrders?: boolean;
	}): HealthComponent {
		const perpMarket = this.velocityClient.getPerpMarketAccountOrThrow(
			perpPosition.marketIndex
		);
		const _oraclePriceData =
			oraclePriceData ||
			this.velocityClient.getOracleDataForPerpMarket(perpMarket.marketIndex);
		const oraclePrice = _oraclePriceData.price;

		let worstCaseBaseAmount;
		let worstCaseLiabilityValue;
		if (includeOpenOrders) {
			const worstCaseIncludeOrders = calculateWorstCasePerpLiabilityValue(
				perpPosition,
				perpMarket,
				oraclePrice
			);
			worstCaseBaseAmount = worstCaseIncludeOrders.worstCaseBaseAssetAmount;
			worstCaseLiabilityValue = worstCaseIncludeOrders.worstCaseLiabilityValue;
		} else {
			worstCaseBaseAmount = perpPosition.baseAssetAmount;
			worstCaseLiabilityValue = calculatePerpLiabilityValue(
				perpPosition.baseAssetAmount,
				oraclePrice
			);
		}

		const userCustomMargin = Math.max(
			perpPosition.maxMarginRatio,
			this.getUserAccountOrThrow().maxMarginRatio
		);
		const marginRatio = new BN(
			calculateMarketMarginRatio(
				perpMarket,
				worstCaseBaseAmount.abs(),
				marginCategory,
				userCustomMargin
			)
		);

		const _quoteOraclePriceData =
			quoteOraclePriceData ||
			this.velocityClient.getOracleDataForSpotMarket(QUOTE_SPOT_MARKET_INDEX);

		let marginRequirement = worstCaseLiabilityValue
			.mul(_quoteOraclePriceData.price)
			.div(PRICE_PRECISION)
			.mul(marginRatio)
			.div(MARGIN_PRECISION);

		marginRequirement = marginRequirement.add(
			new BN(perpPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
		);

		return {
			marketIndex: perpMarket.marketIndex,
			size: worstCaseBaseAmount,
			value: worstCaseLiabilityValue,
			weight: marginRatio,
			weightedValue: marginRequirement,
		};
	}

	/**
	 * Builds a full breakdown of every component feeding into the user's
	 * margin calculation, for UI/diagnostic display: `deposits` and `borrows`
	 * (one `HealthComponent` per non-quote spot market with a nonzero
	 * worst-case position, plus a synthetic entry for the net quote balance),
	 * `perpPositions` (via `getPerpPositionHealth`, one per active perp
	 * position), and `perpPnl` (each position's weighted unrealized PnL — see
	 * `getUnrealizedPNL` for the `'Initial'`-margin $100 cap that also applies
	 * here).
	 * @param marginCategory `'Initial'` or `'Maintenance'` — determines which asset/liability weights are applied.
	 * @returns `HealthComponents` with `size`/`value`/`weightedValue` in each entry using the same precisions as `getPerpPositionHealth`.
	 */
	public getHealthComponents({
		marginCategory,
	}: {
		marginCategory: MarginCategory;
	}): HealthComponents {
		const healthComponents: HealthComponents = {
			deposits: [],
			borrows: [],
			perpPositions: [],
			perpPnl: [],
		};

		for (const perpPosition of this.getActivePerpPositions()) {
			const perpMarket = this.velocityClient.getPerpMarketAccountOrThrow(
				perpPosition.marketIndex
			);

			const oraclePriceData = this.velocityClient.getOracleDataForPerpMarket(
				perpMarket.marketIndex
			);

			const quoteOraclePriceData =
				this.velocityClient.getOracleDataForSpotMarket(QUOTE_SPOT_MARKET_INDEX);

			healthComponents.perpPositions.push(
				this.getPerpPositionHealth({
					marginCategory,
					perpPosition,
					oraclePriceData,
					quoteOraclePriceData,
				})
			);

			const quoteSpotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
				perpMarket.quoteSpotMarketIndex
			);

			const positionUnrealizedPnl = calculatePositionPNL(
				perpMarket,
				perpPosition,
				true,
				oraclePriceData
			);

			let pnlWeight;
			if (positionUnrealizedPnl.gt(ZERO)) {
				pnlWeight = calculateUnrealizedAssetWeight(
					perpMarket,
					quoteSpotMarket,
					positionUnrealizedPnl,
					marginCategory,
					oraclePriceData
				);
			} else {
				pnlWeight = SPOT_MARKET_WEIGHT_PRECISION;
			}

			const pnlValue = positionUnrealizedPnl
				.mul(quoteOraclePriceData.price)
				.div(PRICE_PRECISION);

			const wegithedPnlValue = pnlValue
				.mul(pnlWeight)
				.div(SPOT_MARKET_WEIGHT_PRECISION);

			healthComponents.perpPnl.push({
				marketIndex: perpMarket.marketIndex,
				size: positionUnrealizedPnl,
				value: pnlValue,
				weight: pnlWeight,
				weightedValue: wegithedPnlValue,
			});
		}

		let netQuoteValue = ZERO;
		for (const spotPosition of this.getActiveSpotPositions()) {
			const spotMarketAccount: SpotMarketAccount =
				this.velocityClient.getSpotMarketAccountOrThrow(
					spotPosition.marketIndex
				);

			const oraclePriceData = this.getOracleDataForSpotMarket(
				spotPosition.marketIndex
			);

			const strictOraclePrice = new StrictOraclePrice(oraclePriceData.price);

			if (spotPosition.marketIndex === QUOTE_SPOT_MARKET_INDEX) {
				const tokenAmount = getSignedTokenAmount(
					getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketAccount,
						spotPosition.balanceType
					),
					spotPosition.balanceType
				);

				netQuoteValue = netQuoteValue.add(tokenAmount);
				continue;
			}

			const {
				tokenAmount: worstCaseTokenAmount,
				tokenValue: tokenValue,
				weight,
				weightedTokenValue: weightedTokenValue,
				ordersValue: ordersValue,
			} = getWorstCaseTokenAmounts(
				spotPosition,
				spotMarketAccount,
				strictOraclePrice,
				marginCategory,
				this.getUserAccountOrThrow().maxMarginRatio
			);

			netQuoteValue = netQuoteValue.add(ordersValue);

			const baseAssetValue = tokenValue.abs();
			const weightedValue = weightedTokenValue.abs();

			if (weightedTokenValue.lt(ZERO)) {
				healthComponents.borrows.push({
					marketIndex: spotMarketAccount.marketIndex,
					size: worstCaseTokenAmount,
					value: baseAssetValue,
					weight: weight,
					weightedValue: weightedValue,
				});
			} else {
				healthComponents.deposits.push({
					marketIndex: spotMarketAccount.marketIndex,
					size: worstCaseTokenAmount,
					value: baseAssetValue,
					weight: weight,
					weightedValue: weightedValue,
				});
			}
		}

		if (!netQuoteValue.eq(ZERO)) {
			const spotMarketAccount = this.velocityClient.getQuoteSpotMarketAccount();
			const oraclePriceData = this.getOracleDataForSpotMarket(
				QUOTE_SPOT_MARKET_INDEX
			);

			const baseAssetValue = getTokenValue(
				netQuoteValue,
				spotMarketAccount.decimals,
				oraclePriceData
			);

			const { weight, weightedTokenValue } = calculateWeightedTokenValue(
				netQuoteValue,
				baseAssetValue,
				oraclePriceData.price,
				spotMarketAccount,
				marginCategory,
				this.getUserAccountOrThrow().maxMarginRatio
			);

			if (netQuoteValue.lt(ZERO)) {
				healthComponents.borrows.push({
					marketIndex: spotMarketAccount.marketIndex,
					size: netQuoteValue,
					value: baseAssetValue.abs(),
					weight: weight,
					weightedValue: weightedTokenValue.abs(),
				});
			} else {
				healthComponents.deposits.push({
					marketIndex: spotMarketAccount.marketIndex,
					size: netQuoteValue,
					value: baseAssetValue,
					weight: weight,
					weightedValue: weightedTokenValue,
				});
			}
		}

		return healthComponents;
	}

	/**
	 * Get the total position value, excluding any position coming from the given target market
	 * @param marketToIgnore
	 * @returns positionValue : Precision QUOTE_PRECISION
	 */
	private getTotalPerpPositionValueExcludingMarket(
		marketToIgnore: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean
	): BN {
		const currentPerpPosition = this.getPerpPositionOrEmpty(marketToIgnore);

		const oracleData = this.getOracleDataForPerpMarket(marketToIgnore);

		let currentPerpPositionValueUSDC = ZERO;
		if (currentPerpPosition) {
			currentPerpPositionValueUSDC = this.getPerpLiabilityValue(
				marketToIgnore,
				oracleData,
				includeOpenOrders
			);
		}

		return this.getTotalPerpPositionLiability(
			marginCategory,
			liquidationBuffer,
			includeOpenOrders
		).sub(currentPerpPositionValueUSDC);
	}

	private getMMOracleDataForPerpMarket(marketIndex: number): MMOraclePriceData {
		return this.velocityClient.getMMOracleDataForPerpMarket(marketIndex);
	}

	private getOracleDataForPerpMarket(marketIndex: number): OraclePriceData {
		return this.velocityClient.getOracleDataForPerpMarket(marketIndex);
	}

	private getOracleDataForSpotMarket(marketIndex: number): OraclePriceData {
		return this.velocityClient.getOracleDataForSpotMarket(marketIndex);
	}

	/**
	 * Get the active perp and spot positions of the user.
	 * @returns Market indices only (not full position objects); see `getActivePerpPositions`/`getActiveSpotPositions` for the "active" criteria.
	 */
	public getActivePositions(): {
		activePerpPositions: number[];
		activeSpotPositions: number[];
	} {
		const activePerpMarkets = this.getActivePerpPositions().map(
			(position) => position.marketIndex
		);

		const activeSpotMarkets = this.getActiveSpotPositions().map(
			(position) => position.marketIndex
		);

		return {
			activePerpPositions: activePerpMarkets,
			activeSpotPositions: activeSpotMarkets,
		};
	}

	/**
	 * Compute the full margin calculation for the user's account.
	 * Prioritize using this function instead of calling getMarginRequirement or getTotalCollateral multiple times.
	 * Consumers can use this to avoid duplicating work across separate calls.
	 *
	 * Mirrors the on-chain margin accumulation in `math/margin.rs`, splitting
	 * contributions into cross-margin and per-market isolated buckets
	 * (`MarginCalculation.isolatedMarginCalculations`, keyed by perp market
	 * index — see `isPerpPositionIsolated`) and tracking whether the account
	 * holds any isolated-tier liability (`withPerpIsolatedLiability` /
	 * `withSpotIsolatedLiability`, consumed by
	 * `validateAnyIsolatedTierRequirements`). A perp position's isolated
	 * quote-deposit collateral only counts toward that position's own isolated
	 * bucket, never the cross-margin total.
	 *
	 * Also enforces pool-id consistency: every spot/perp position's market must
	 * match the user's `poolId`, **except** a pool-1 user is allowed to hold a
	 * quote-asset deposit (not borrow) even though the quote spot market itself
	 * belongs to pool 0 — throws `InvalidPoolId: ...` otherwise.
	 * @param marginCategory `'Initial'` or `'Maintenance'`. Defaults to `'Initial'`.
	 * @param opts.strict Apply TWAP-bounded (`StrictOraclePrice`) oracle pricing, mirroring the on-chain strict-price gating. Defaults to false.
	 * @param opts.includeOpenOrders Include open orders' worst-case impact. Defaults to true.
	 * @param opts.liquidationBufferMap Per-scope buffer (MARGIN_PRECISION, 1e4) to pad margin requirements with — `'cross'` for the cross-margin bucket, or a perp market index for that market's isolated bucket. See `getLiquidationBuffer`.
	 */
	public getMarginCalculation(
		marginCategory: MarginCategory = 'Initial',
		opts?: {
			strict?: boolean; // mirror StrictOraclePrice application
			includeOpenOrders?: boolean;
			liquidationBufferMap?: Map<number | 'cross', BN>; // margin_buffer analog for buffer mode
		}
	): MarginCalculation {
		const strict = opts?.strict ?? false;
		const liquidationBufferMap = opts?.liquidationBufferMap ?? new Map();
		const includeOpenOrders = opts?.includeOpenOrders ?? true;

		// Equivalent to on-chain user_custom_margin_ratio
		const userCustomMarginRatio =
			marginCategory === 'Initial'
				? this.getUserAccountOrThrow().maxMarginRatio
				: 0;

		// Initialize calc via JS mirror of Rust/on-chain MarginCalculation
		const isolatedMarginBuffers = new Map<number, BN>();
		for (const [
			marketIndex,
			isolatedMarginBuffer,
		] of opts?.liquidationBufferMap ?? new Map()) {
			if (marketIndex !== 'cross') {
				isolatedMarginBuffers.set(marketIndex, isolatedMarginBuffer);
			}
		}
		const ctx = MarginContext.standard(marginCategory)
			.strictMode(strict)
			.setCrossMarginBuffer(opts?.liquidationBufferMap?.get('cross') ?? ZERO)
			.setIsolatedMarginBuffers(isolatedMarginBuffers);
		const calc = new MarginCalculation(ctx);

		const userPoolId = this.getUserAccountOrThrow().poolId;

		// SPOT POSITIONS
		for (const spotPosition of this.getUserAccountOrThrow().spotPositions) {
			if (isSpotPositionAvailable(spotPosition)) continue;

			const isQuote = spotPosition.marketIndex === QUOTE_SPOT_MARKET_INDEX;
			const isBorrow = isVariant(spotPosition.balanceType, 'borrow');

			const spotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
				spotPosition.marketIndex
			);

			// the pool-1/quote-deposit carve-out lets a pool-1 user *hold* a quote
			// deposit without matching the quote market's own pool id (no
			// InvalidPoolId throw); every other combination requires an exact pool
			// match. Note the deposit still contributes ZERO collateral in this case
			// (skipTokenValue below) — this faithfully mirrors margin.rs:319-321,
			// which sets token_value = 0 before add_cross_margin_total_collateral.
			let skipTokenValue = false;
			if (!(userPoolId === 1 && isQuote && !isBorrow)) {
				if (userPoolId !== spotMarket.poolId) {
					throw new Error(
						`InvalidPoolId: user pool id (${userPoolId}) does not match spot market pool id (${spotMarket.poolId}) for market index ${spotMarket.marketIndex}`
					);
				}
			} else {
				skipTokenValue = true;
			}

			const oraclePriceData = this.getOracleDataForSpotMarket(
				spotPosition.marketIndex
			);
			const twap5 = strict
				? calculateLiveOracleTwap(
						spotMarket.historicalOracleData,
						oraclePriceData,
						new BN(Math.floor(Date.now() / 1000)),
						FIVE_MINUTE
				  )
				: undefined;
			const strictOracle = new StrictOraclePrice(oraclePriceData.price, twap5);

			if (isQuote) {
				const tokenAmount = getSignedTokenAmount(
					getTokenAmount(
						spotPosition.scaledBalance,
						spotMarket,
						spotPosition.balanceType
					),
					spotPosition.balanceType
				);
				// mirrors margin.rs's `market_index == 0` block: the quote market uses the
				// raw strict token value on both sides — no asset/liability weight, and the
				// cross-margin buffer is applied inside addCrossMarginRequirement (from
				// context.crossMarginBuffer), not folded into the value here
				const tokenValue = getStrictTokenValue(
					tokenAmount,
					spotMarket.decimals,
					strictOracle
				);
				if (isVariant(spotPosition.balanceType, 'deposit')) {
					// add deposit value to total collateral
					calc.addCrossMarginTotalCollateral(
						skipTokenValue ? ZERO : tokenValue
					);
				} else {
					// borrow on quote contributes to margin requirement
					const tokenValueAbs = tokenValue.abs();
					calc.addCrossMarginRequirement(tokenValueAbs, tokenValueAbs);
					calc.addSpotLiability();
				}
				continue;
			}

			// Non-quote spot: worst-case simulation
			const {
				tokenAmount: worstCaseTokenAmount,
				ordersValue: worstCaseOrdersValue,
			} = getWorstCaseTokenAmounts(
				spotPosition,
				spotMarket,
				strictOracle,
				marginCategory,
				userCustomMarginRatio,
				includeOpenOrders
				// false
			);

			if (includeOpenOrders) {
				// open order IM
				calc.addCrossMarginRequirement(
					new BN(spotPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT),
					ZERO
				);
			}

			const isIsolatedSpotTier = isVariant(spotMarket.assetTier, 'isolated');

			if (worstCaseTokenAmount.gt(ZERO)) {
				const baseAssetValue = this.getSpotAssetValue(
					worstCaseTokenAmount,
					strictOracle,
					spotMarket,
					marginCategory
				);
				// asset side increases total collateral (weighted)
				calc.addCrossMarginTotalCollateral(baseAssetValue);
			} else if (worstCaseTokenAmount.lt(ZERO)) {
				// liability side increases margin requirement (weighted >= abs(token_value))
				const getSpotLiabilityValue = this.getSpotLiabilityValue(
					worstCaseTokenAmount,
					strictOracle,
					spotMarket,
					marginCategory,
					liquidationBufferMap.get('cross')
				);

				calc.addCrossMarginRequirement(
					getSpotLiabilityValue.abs(),
					getSpotLiabilityValue.abs()
				);
				calc.addSpotLiability();
				calc.updateWithSpotIsolatedLiability(isIsolatedSpotTier);
			} else if (
				spotPosition.openOrders !== 0 ||
				!spotPosition.openBids.isZero() ||
				!spotPosition.openAsks.isZero()
			) {
				calc.addSpotLiability();
				calc.updateWithSpotIsolatedLiability(isIsolatedSpotTier);
			}

			// orders value contributes to collateral or requirement
			if (worstCaseOrdersValue.gt(ZERO)) {
				calc.addCrossMarginTotalCollateral(worstCaseOrdersValue);
			} else if (worstCaseOrdersValue.lt(ZERO)) {
				const absVal = worstCaseOrdersValue.abs();
				calc.addCrossMarginRequirement(absVal, absVal);
			}
		}

		// PERP POSITIONS
		for (const marketPosition of this.getActivePerpPositions()) {
			const market = this.velocityClient.getPerpMarketAccountOrThrow(
				marketPosition.marketIndex
			);

			if (userPoolId !== market.poolId) {
				throw new Error(
					`InvalidPoolId: user pool id (${userPoolId}) does not match perp market pool id (${market.poolId}) for market index ${market.marketIndex}`
				);
			}

			const quoteSpotMarket = this.velocityClient.getSpotMarketAccountOrThrow(
				market.quoteSpotMarketIndex
			);
			const quoteOraclePriceData = this.getOracleDataForSpotMarket(
				market.quoteSpotMarketIndex
			);
			const oraclePriceData = this.getMMOracleDataForPerpMarket(
				market.marketIndex
			);

			const nonMmmOraclePriceData = this.getOracleDataForPerpMarket(
				market.marketIndex
			);

			// Worst-case perp liability and weighted pnl
			const { worstCaseBaseAssetAmount, worstCaseLiabilityValue } =
				calculateWorstCasePerpLiabilityValue(
					marketPosition,
					market,
					nonMmmOraclePriceData.price,
					includeOpenOrders
				);

			// margin ratio for this perp
			const customMarginRatio = Math.max(
				userCustomMarginRatio,
				marketPosition.maxMarginRatio
			);
			let marginRatio = new BN(
				calculateMarketMarginRatio(
					market,
					worstCaseBaseAssetAmount.abs(),
					marginCategory,
					customMarginRatio
				)
			);
			if (isVariant(market.status, 'settlement')) {
				marginRatio = ZERO;
			}

			// convert liability to quote value and apply margin ratio; since this is
			// a liability, use the larger of the twap and current quote price
			const quotePrice = strict
				? BN.max(
						quoteOraclePriceData.price,
						quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
				  )
				: quoteOraclePriceData.price;
			const worstCaseLiabilityValueQuote = worstCaseLiabilityValue
				.mul(quotePrice)
				.div(PRICE_PRECISION);
			let perpMarginRequirement = worstCaseLiabilityValueQuote
				.mul(marginRatio)
				.div(MARGIN_PRECISION);
			// add open orders IM
			if (includeOpenOrders) {
				perpMarginRequirement = perpMarginRequirement.add(
					new BN(marketPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
				);
			}

			// weighted unrealized pnl
			let positionUnrealizedPnl = calculatePositionPNL(
				market,
				marketPosition,
				true,
				oraclePriceData
			);
			let pnlQuotePrice: BN;
			if (strict && positionUnrealizedPnl.gt(ZERO)) {
				pnlQuotePrice = BN.min(
					quoteOraclePriceData.price,
					quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
				);
			} else if (strict && positionUnrealizedPnl.lt(ZERO)) {
				pnlQuotePrice = BN.max(
					quoteOraclePriceData.price,
					quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
				);
			} else {
				pnlQuotePrice = quoteOraclePriceData.price;
			}
			positionUnrealizedPnl = positionUnrealizedPnl
				.mul(pnlQuotePrice)
				.div(PRICE_PRECISION);

			if (marginCategory !== undefined) {
				if (positionUnrealizedPnl.gt(ZERO)) {
					positionUnrealizedPnl = positionUnrealizedPnl
						.mul(
							calculateUnrealizedAssetWeight(
								market,
								quoteSpotMarket,
								positionUnrealizedPnl,
								marginCategory,
								oraclePriceData
							)
						)
						.div(new BN(SPOT_MARKET_WEIGHT_PRECISION));
				}
			}

			if (marginCategory === 'Initial') {
				// safety guard for dangerously configured perp market
				positionUnrealizedPnl = BN.min(
					positionUnrealizedPnl,
					MAX_POSITIVE_UPNL_FOR_INITIAL_MARGIN
				);
			}

			const hasPerpLiability =
				!marketPosition.baseAssetAmount.isZero() ||
				marketPosition.quoteAssetAmount.isNeg() ||
				marketPosition.openOrders !== 0 ||
				!marketPosition.openBids.isZero() ||
				!marketPosition.openAsks.isZero();
			if (hasPerpLiability) {
				calc.addPerpLiability();
				calc.updateWithPerpIsolatedLiability(
					isVariant(market.contractTier, 'isolated')
				);
			}

			// Add perp contribution: isolated vs cross
			const isIsolated = this.isPerpPositionIsolated(marketPosition);
			if (isIsolated) {
				// derive isolated quote deposit value, mirroring on-chain logic
				let depositValue = ZERO;
				if (marketPosition.isolatedPositionScaledBalance?.gt(ZERO)) {
					const quoteSpotMarket =
						this.velocityClient.getSpotMarketAccountOrThrow(
							market.quoteSpotMarketIndex
						);
					const quoteOraclePriceData = this.getOracleDataForSpotMarket(
						market.quoteSpotMarketIndex
					);
					const strictQuote = new StrictOraclePrice(
						quoteOraclePriceData.price,
						strict
							? quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
							: undefined
					);
					const quoteTokenAmount = getTokenAmount(
						marketPosition.isolatedPositionScaledBalance ?? ZERO,
						quoteSpotMarket,
						SpotBalanceType.DEPOSIT
					);
					depositValue = getStrictTokenValue(
						quoteTokenAmount,
						quoteSpotMarket.decimals,
						strictQuote
					);
				}
				calc.addIsolatedMarginCalculation(
					market.marketIndex,
					depositValue,
					positionUnrealizedPnl,
					worstCaseLiabilityValueQuote,
					perpMarginRequirement
				);
			} else {
				// cross: add to global requirement and collateral
				calc.addCrossMarginRequirement(
					perpMarginRequirement,
					worstCaseLiabilityValueQuote
				);
				calc.addCrossMarginTotalCollateral(positionUnrealizedPnl);
			}

			// mirrors margin.rs:616-617 — perp liability value accumulates for every
			// position regardless of the isolated/cross split, so it must run outside
			// the branch above (previously only the isolated branch accumulated it,
			// underreporting totalPerpLiabilityValue for cross positions)
			calc.addPerpLiabilityValue(worstCaseLiabilityValueQuote);
		}
		return calc;
	}

	/**
	 * Returns true if `perpPosition` was opened/is held under isolated margin
	 * (`PositionFlag.IsolatedPosition` set) — segregated to its own margin
	 * bucket (see `getMarginCalculation`) rather than sharing cross-margin
	 * collateral with the rest of the account.
	 */
	public isPerpPositionIsolated(perpPosition: PerpPosition): boolean {
		return (perpPosition.positionFlag & PositionFlag.IsolatedPosition) !== 0;
	}

	/**
	 * Pre-flight check for `IsolatedAssetTierViolation`: mirrors
	 * `validate_any_isolated_tier_requirements` in `math/margin.rs`. A user
	 * holding an isolated-tier perp or spot liability may not simultaneously
	 * carry other liabilities (besides a single usdc borrow, for a perp
	 * isolated liability), unless they are reduce-only.
	 *
	 * Specifically, if `calculation.withPerpIsolatedLiability` is set (an
	 * isolated-*contract-tier* perp liability exists) and the user is not
	 * `UserStatus.REDUCE_ONLY`: more than one perp liability is invalid; margin
	 * trading enabled is invalid; and any spot liability other than a single
	 * USDC borrow is invalid. If `calculation.withSpotIsolatedLiability` is set
	 * (an isolated-*asset-tier* spot liability exists) and not reduce-only: any
	 * perp liability, or more than the one isolated-tier spot liability, is invalid.
	 * @param calculation A `MarginCalculation` from `getMarginCalculation` (any margin category — only the isolated-liability flags and liability counts are read).
	 * @returns `{ valid: true }` if the account satisfies isolated-tier requirements, else `{ valid: false, reason }` with a human-readable reason.
	 */
	public validateAnyIsolatedTierRequirements(calculation: MarginCalculation): {
		valid: boolean;
		reason?: string;
	} {
		const userAccount = this.getUserAccountOrThrow();
		const isReduceOnly = this.hasStatus(UserStatus.REDUCE_ONLY);

		if (calculation.withPerpIsolatedLiability && !isReduceOnly) {
			if (calculation.numPerpLiabilities > 1) {
				return {
					valid: false,
					reason:
						'User attempting to increase perp liabilities above 1 with a isolated tier liability',
				};
			}

			if (userAccount.isMarginTradingEnabled) {
				return {
					valid: false,
					reason:
						'User attempting isolated tier liability with margin trading enabled',
				};
			}

			if (calculation.numSpotLiabilities > 0) {
				const quoteSpotPosition = this.getSpotPosition(QUOTE_SPOT_MARKET_INDEX);
				const quoteIsBorrow =
					!!quoteSpotPosition &&
					isVariant(quoteSpotPosition.balanceType, 'borrow');
				if (!(calculation.numSpotLiabilities === 1 && quoteIsBorrow)) {
					return {
						valid: false,
						reason:
							'User attempting to increase spot liabilities beyond usdc with a isolated tier liability',
					};
				}
			}
		}

		if (calculation.withSpotIsolatedLiability && !isReduceOnly) {
			if (
				!(
					calculation.numPerpLiabilities === 0 &&
					calculation.numSpotLiabilities === 1
				)
			) {
				return {
					valid: false,
					reason:
						'User attempting to increase perp liabilities above 0 with a isolated tier liability',
				};
			}
		}

		return { valid: true };
	}
}
