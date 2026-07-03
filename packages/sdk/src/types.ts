/**
 * Shared TypeScript types for the Velocity SDK.
 *
 * Contains TypeScript mirrors of all on-chain account structs (UserAccount, PerpMarketAccount,
 * SpotMarketAccount, StateAccount, OracleData, etc.), instruction parameter types (OrderParams,
 * ModifyOrderParams), enums (MarketType, OrderType, PositionDirection, OracleSource), and
 * precision constants used throughout the SDK.
 *
 * The authoritative layout source is `sdk/src/idl/velocity.json` (generated from the program).
 * Do not edit struct shapes here without a corresponding on-chain change.
 */
import {
	Keypair,
	PublicKey,
	Transaction,
	TransactionVersion,
	VersionedTransaction,
} from '@solana/web3.js';
import { BN } from './isomorphic/anchor';
import { ZERO } from './constants/numericConstants';

/** Utility type that maps every key of `A` to the same-shaped record with all values replaced by type `B`. */
export type MappedRecord<A extends Record<string, unknown>, B> = {
	[K in keyof A]: B;
};

// # Utility Types / Enums / Constants

/**
 * Bitmask mirror of `State.exchangeStatus`. Each non-zero member pauses one class of
 * instructions protocol-wide; multiple bits may be set simultaneously (e.g. deposits and
 * withdrawals paused together). `PAUSED` (255) is the "pause everything" value, not a flag
 * combinable with the others. Only `coldAdmin`/`warmAdmin` may clear bits; `pauseAdmin` may
 * only set them (see `StateAccount.pauseAdmin`).
 */
export enum ExchangeStatus {
	ACTIVE = 0,
	DEPOSIT_PAUSED = 1,
	WITHDRAW_PAUSED = 2,
	AMM_PAUSED = 4,
	FILL_PAUSED = 8,
	LIQ_PAUSED = 16,
	FUNDING_PAUSED = 32,
	SETTLE_PNL_PAUSED = 64,
	AMM_IMMEDIATE_FILL_PAUSED = 128,
	PAUSED = 255,
}

/**
 * Mirror of the Rust `SolvencyStatus` bitflag (`StateAccount.solvencyStatus`). Gates internal
 * solvency-repair flows (bankruptcy / pnl-deficit resolution) independently of
 * `ExchangeStatus.WITHDRAW_PAUSED`, so withdrawals can be halted while repair keeps running, or
 * repair can be frozen on its own (e.g. when an oracle is suspect) without touching withdrawals.
 * `ACTIVE` (0) means repair is allowed.
 */
export enum SolvencyStatus {
	ACTIVE = 0,
	SOLVENCY_REPAIR_PAUSED = 1,
}

/** Bitmask mirror of `StateAccount.featureBitFlags`, gating protocol-wide optional features. */
export enum FeatureBitFlags {
	MM_ORACLE_UPDATE = 1,
	MEDIAN_TRIGGER_PRICE = 2,
	BUILDER_CODES = 4,
}

/**
 * Mirrors the Rust `MarketStatus` enum on `PerpMarketAccount.status` / `SpotMarketAccount.status`.
 * Controls which operations a market allows: `INITIALIZED` (warm-up, fills paused), `ACTIVE` (all
 * operations allowed), `REDUCE_ONLY` (fills may only shrink a liability), `SETTLEMENT` (market has
 * a determined settlement price; positions must be settled), `DELISTED` (no participants remain).
 * Velocity's on-chain discriminants (`Initialized`=0, `Active`=1, `ReduceOnly`=2, `Settlement`=3,
 * `Delisted`=4) are **shifted down from upstream Drift's** (`ReduceOnly`=6, `Settlement`=7,
 * `Delisted`=8) after the deprecated `FundingPaused`/`AmmPaused`/`FillPaused`/`WithdrawPaused`
 * variants were removed — any decoder built against the old Drift discriminants will silently
 * misread these states.
 */
export class MarketStatus {
	static readonly INITIALIZED = { initialized: {} };
	static readonly ACTIVE = { active: {} };
	static readonly REDUCE_ONLY = { reduceOnly: {} };
	static readonly SETTLEMENT = { settlement: {} };
	static readonly DELISTED = { delisted: {} };
}

/** Bitmask mirror of `PerpMarketAccount.pausedOperations`; each bit disables one perp-market operation. */
export enum PerpOperation {
	UPDATE_FUNDING = 1,
	AMM_FILL = 2,
	FILL = 4,
	SETTLE_PNL = 8,
	SETTLE_PNL_WITH_POSITION = 16,
	LIQUIDATION = 32,
	AMM_IMMEDIATE_FILL = 64,
	SETTLE_REV_POOL = 128,
}

/** Bitmask mirror of `SpotMarketAccount.pausedOperations`; each bit disables one spot-market operation. */
export enum SpotOperation {
	UPDATE_CUMULATIVE_INTEREST = 1,
	FILL = 2,
	DEPOSIT = 4,
	WITHDRAW = 8,
	LIQUIDATION = 16,
}

/** Bitmask mirror of `SpotMarketAccount.ifPausedOperations`; each bit disables one insurance-fund-stake operation. */
export enum InsuranceFundOperation {
	INIT = 1,
	ADD = 2,
	REQUEST_REMOVE = 4,
	REMOVE = 8,
}

/**
 * Bitmask mirror of `UserAccount.status`. Multiple bits can be set at once (e.g. a bankrupt user
 * is also `BEING_LIQUIDATED`). `0` (unset) means active/normal. Bit `16` (was `PROTECTED_MAKER`)
 * is reserved and no longer assigned.
 */
export enum UserStatus {
	BEING_LIQUIDATED = 1,
	BANKRUPT = 2,
	REDUCE_ONLY = 4,
	ADVANCED_LP = 8,
	// 16 reserved (was PROTECTED_MAKER)
}

/** Bitmask mirror of `UserAccount.specialUserStatus`. `VAMM_HEDGER` marks the account used by the protocol's own vAMM-hedging bot. */
export enum SpecialUserStatus {
	VAMM_HEDGER = 1,
}

/** Bitmask mirror of `UserStatsAccount.pausedOperations`; each bit disables one per-user-stats update path. */
export enum UserStatsPausedOperation {
	UPDATE_BID_ASK_TWAP = 1,
	AMM_ATOMIC_FILL = 2,
	AMM_ATOMIC_RISK_INCREASING_FILL = 4,
}

/** Bitmask mirror of `PerpMarketAccount.marketConfig`. `DISABLE_FORMULAIC_K_UPDATE` turns off the AMM's automatic `k` (liquidity depth) adjustments for that market. */
export enum MarketConfigFlag {
	DISABLE_FORMULAIC_K_UPDATE = 1,
}

/** Margin-mode enum-class. Currently only `DEFAULT` (cross margin) exists; isolated margin is expressed per-position via `PositionFlag.IsolatedPosition`, not a distinct margin mode. */
export class MarginMode {
	static readonly DEFAULT = { default: {} };
}

/**
 * Mirrors the on-chain `ContractType` on `PerpMarketAccount.contractType`. Only `PERPETUAL` is
 * live; `DEPRECATED_FUTURE` and `DEPRECATED_PREDICTION` are inert stubs kept for IDL/discriminant
 * compatibility and are never assigned to a market.
 */
export class ContractType {
	static readonly PERPETUAL = { perpetual: {} };
	static readonly DEPRECATED_FUTURE = { deprecatedFuture: {} };
	static readonly DEPRECATED_PREDICTION = { deprecatedPrediction: {} };
}

/**
 * A perp market's speculativeness tier (`PerpMarketAccount.contractTier`). Determines how much of
 * the insurance fund the market may draw on during bankruptcy and the order markets are
 * liquidated in — `ISOLATED` markets receive no shared insurance coverage; `A` is safest.
 */
export class ContractTier {
	static readonly A = { a: {} };
	static readonly B = { b: {} };
	static readonly C = { c: {} };
	static readonly SPECULATIVE = { speculative: {} };
	static readonly HIGHLY_SPECULATIVE = { highlySpeculative: {} };
	static readonly ISOLATED = { isolated: {} };
}

/**
 * A spot market's collateral-safety tier (`SpotMarketAccount.assetTier`). Determines whether a
 * deposit can be used as cross-margin collateral alongside other assets: `COLLATERAL` may back
 * any borrow, `PROTECTED`/`CROSS` have restrictions on being borrowed against, `ISOLATED` deposits
 * can't be combined with other borrows, and `UNLISTED` deposits count for nothing.
 */
export class AssetTier {
	static readonly COLLATERAL = { collateral: {} };
	static readonly PROTECTED = { protected: {} };
	static readonly CROSS = { cross: {} };
	static readonly ISOLATED = { isolated: {} };
	static readonly UNLISTED = { unlisted: {} };
}

/** Bitmask mirror of `SpotMarketAccount.tokenProgramFlag`, recording which SPL token-program features the market's mint uses. */
export enum TokenProgramFlag {
	Token2022 = 1,
	TransferHook = 2,
}

/** Direction of an LP-pool constituent swap (add liquidity vs remove liquidity). */
export class SwapDirection {
	static readonly ADD = { add: {} };
	static readonly REMOVE = { remove: {} };
}

/** Whether a `SpotPosition`/`PoolBalance`'s scaled balance represents a deposit (positive token claim) or a borrow (liability). */
export class SpotBalanceType {
	static readonly DEPOSIT = { deposit: {} };
	static readonly BORROW = { borrow: {} };
}

/** Long (bid) or short (ask) side of a perp/spot order or position. */
export class PositionDirection {
	static readonly LONG = { long: {} };
	static readonly SHORT = { short: {} };
}

/** Direction of a `DepositRecord` / `LPBorrowLendDepositRecord` event: funds entering or leaving the protocol. */
export class DepositDirection {
	static readonly DEPOSIT = { deposit: {} };
	static readonly WITHDRAW = { withdraw: {} };
}

/**
 * Mirrors the on-chain `OracleSource` enum, identifying which oracle provider/decoder to use for
 * a market's `oracle` account. The `1K`/`1M` suffixes scale the raw feed price by 1e3/1e6 (used
 * for low-priced assets like BONK). `DEPRECATED_SWITCHBOARD`/`DEPRECATED_SWITCHBOARD_ON_DEMAND`
 * are inert stubs — using them returns `InvalidOracle`. `Prelaunch` reads from a `PrelaunchOracle`
 * account instead of an external feed.
 */
export class OracleSource {
	static readonly PYTH = { pyth: {} };
	static readonly PYTH_1K = { pyth1K: {} };
	static readonly PYTH_1M = { pyth1M: {} };
	static readonly PYTH_PULL = { pythPull: {} };
	static readonly PYTH_1K_PULL = { pyth1KPull: {} };
	static readonly PYTH_1M_PULL = { pyth1MPull: {} };
	static readonly DEPRECATED_SWITCHBOARD = { deprecatedSwitchboard: {} };
	static readonly QUOTE_ASSET = { quoteAsset: {} };
	static readonly PYTH_STABLE_COIN = { pythStableCoin: {} };
	static readonly PYTH_STABLE_COIN_PULL = { pythStableCoinPull: {} };
	static readonly Prelaunch = { prelaunch: {} };
	static readonly DEPRECATED_SWITCHBOARD_ON_DEMAND = {
		deprecatedSwitchboardOnDemand: {},
	};
	static readonly PYTH_LAZER = { pythLazer: {} };
	static readonly PYTH_LAZER_1K = { pythLazer1K: {} };
	static readonly PYTH_LAZER_1M = { pythLazer1M: {} };
	static readonly PYTH_LAZER_STABLE_COIN = { pythLazerStableCoin: {} };
}

/**
 * Stable SDK-internal numeric encoding of `OracleSource`, used only for oracle-id string
 * round-tripping (`getOracleSourceNum` ↔ `getOracleSourceFromNum` in `oracles/oracleId.ts`).
 * NOTE: these numbers are **not** the on-chain Borsh discriminants and are **not** in the
 * on-chain enum's declaration order — do not use them for raw memcmp filters against chain
 * data. They only need to be self-consistent within the SDK.
 */
export class OracleSourceNum {
	static readonly PYTH = 0;
	static readonly PYTH_1K = 1;
	static readonly PYTH_1M = 2;
	static readonly PYTH_PULL = 3;
	static readonly PYTH_1K_PULL = 4;
	static readonly PYTH_1M_PULL = 5;
	static readonly DEPRECATED_SWITCHBOARD = 6;
	static readonly QUOTE_ASSET = 7;
	static readonly PYTH_STABLE_COIN = 8;
	static readonly PYTH_STABLE_COIN_PULL = 9;
	static readonly PRELAUNCH = 10;
	static readonly DEPRECATED_SWITCHBOARD_ON_DEMAND = 11;
	static readonly PYTH_LAZER = 12;
	static readonly PYTH_LAZER_1K = 13;
	static readonly PYTH_LAZER_1M = 14;
	static readonly PYTH_LAZER_STABLE_COIN = 15;
}

/** The order's price-determination mechanism: `LIMIT`/`TRIGGER_LIMIT` use `Order.price`, `MARKET`/`TRIGGER_MARKET` fill at the best available price (subject to any auction), and `ORACLE` prices relative to the oracle via `Order.oraclePriceOffset`. `TRIGGER_*` variants only become active once `Order.triggerPrice` is crossed. */
export class OrderType {
	static readonly LIMIT = { limit: {} };
	static readonly TRIGGER_MARKET = { triggerMarket: {} };
	static readonly TRIGGER_LIMIT = { triggerLimit: {} };
	static readonly MARKET = { market: {} };
	static readonly ORACLE = { oracle: {} };
}

/** String-literal twin of `MarketType`, used where a plain `'perp' | 'spot'` string (not the `{variant: {}}` shape) is more convenient, e.g. UI/query params. */
export declare type MarketTypeStr = 'perp' | 'spot';
/** Whether an order/position/market is on the spot or perp side of the protocol. */
export class MarketType {
	static readonly SPOT = { spot: {} };
	static readonly PERP = { perp: {} };
}

/** Lifecycle state of an `Order`: `INIT` (unused slot), `OPEN` (live, may still be filled), `FILLED` (fully filled), `CANCELED`. */
export class OrderStatus {
	static readonly INIT = { init: {} };
	static readonly OPEN = { open: {} };
	static readonly FILLED = { filled: {} };
	static readonly CANCELED = { canceled: {} };
}

/**
 * Bitmask mirror of `Order.bitFlags` / `OrderParams.bitFlags`.
 * - `SignedMessage`: order originated from a signed off-chain message (swift/signed-msg flow).
 * - `OracleTriggerMarket`: a `TriggerMarket` order whose trigger condition is evaluated against
 *   the oracle price rather than the last mark/fill price.
 * - `SafeTriggerOrder`: exempts the order from the AMM's low-risk-fill slot-delay gate — it may
 *   be immediately filled by the AMM once triggered, or when the order itself is a liquidation.
 * - `NewTriggerReduceOnly`: for a reduce-only order that has triggered, suppresses updating the
 *   user's `openBids`/`openAsks` counters (avoids double-counting margin already reserved).
 * - `HasBuilder`: the order carries a `builderIdx`/`builderFeeTenthBps` builder-code fee split.
 * - `IsIsolatedPosition`: the order trades against/opens an isolated-margin position rather than cross margin.
 */
export class OrderBitFlag {
	static readonly SignedMessage = 1;
	static readonly OracleTriggerMarket = 2;
	static readonly SafeTriggerOrder = 4;
	static readonly NewTriggerReduceOnly = 8;
	static readonly HasBuilder = 16;
	static readonly IsIsolatedPosition = 32;
}

/** The kind of action an `OrderActionRecord` event describes. */
export class OrderAction {
	static readonly PLACE = { place: {} };
	static readonly CANCEL = { cancel: {} };
	static readonly EXPIRE = { expire: {} };
	static readonly FILL = { fill: {} };
	static readonly TRIGGER = { trigger: {} };
}

/** Why an `OrderActionRecord` event happened — the specific reason a fill/cancel/expire/trigger occurred (e.g. which fulfillment method filled the order, or why it was rejected/canceled). */
export class OrderActionExplanation {
	static readonly NONE = { none: {} };
	static readonly INSUFFICIENT_FREE_COLLATERAL = {
		insufficientFreeCollateral: {},
	};
	static readonly ORACLE_PRICE_BREACHED_LIMIT_PRICE = {
		oraclePriceBreachedLimitPrice: {},
	};
	static readonly MARKET_ORDER_FILLED_TO_LIMIT_PRICE = {
		marketOrderFilledToLimitPrice: {},
	};
	static readonly ORDER_EXPIRED = {
		orderExpired: {},
	};
	static readonly LIQUIDATION = {
		liquidation: {},
	};
	static readonly ORDER_FILLED_WITH_AMM = {
		orderFilledWithAmm: {},
	};
	static readonly ORDER_FILLED_WITH_AMM_JIT = {
		orderFilledWithAmmJit: {},
	};
	static readonly ORDER_FILLED_WITH_AMM_JIT_LP_SPLIT = {
		orderFilledWithAmmJitLpSplit: {},
	};
	static readonly ORDER_FILLED_WITH_LP_JIT = {
		orderFilledWithLpJit: {},
	};
	static readonly ORDER_FILLED_WITH_MATCH = {
		orderFilledWithMatch: {},
	};
	static readonly ORDER_FILLED_WITH_MATCH_JIT = {
		orderFilledWithMatchJit: {},
	};
	static readonly MARKET_EXPIRED = {
		marketExpired: {},
	};
	static readonly RISK_INCREASING_ORDER = {
		riskingIncreasingOrder: {},
	};
	static readonly REDUCE_ONLY_ORDER_INCREASED_POSITION = {
		reduceOnlyOrderIncreasedPosition: {},
	};
	static readonly DERISK_LP = {
		deriskLp: {},
	};
	static readonly TRANSFER_PERP_POSITION = {
		transferPerpPosition: {},
	};
}

/** Trigger-order condition on `Order.triggerCondition`. `ABOVE`/`BELOW` are the pending (not-yet-triggered) states; `TRIGGERED_ABOVE`/`TRIGGERED_BELOW` record that the condition has already fired, so the order is now live for filling. */
export class OrderTriggerCondition {
	static readonly ABOVE = { above: {} };
	static readonly BELOW = { below: {} };
	static readonly TRIGGERED_ABOVE = { triggeredAbove: {} }; // above condition has been triggered
	static readonly TRIGGERED_BELOW = { triggeredBelow: {} }; // below condition has been triggered
}

/** Why a `DepositRecord` event happened: a direct transfer, a borrow being drawn, a borrow being repaid, or a protocol reward credit. */
export class DepositExplanation {
	static readonly NONE = { none: {} };
	static readonly TRANSFER = { transfer: {} };
	static readonly BORROW = { borrow: {} };
	static readonly REPAY_BORROW = { repayBorrow: {} };
	static readonly REWARD = { reward: {} };
}

/** Why a `SettlePnlRecord` event happened: a normal settle, or settlement of an expired-market position at the market's `expiryPrice`. */
export class SettlePnlExplanation {
	static readonly NONE = { none: {} };
	static readonly EXPIRED_POSITION = { expiredPosition: {} };
}

/** The insurance-fund-stake action an `InsuranceFundStakeRecord` event describes. */
export class StakeAction {
	static readonly STAKE = { stake: {} };
	static readonly UNSTAKE_REQUEST = { unstakeRequest: {} };
	static readonly UNSTAKE_CANCEL_REQUEST = { unstakeCancelRequest: {} };
	static readonly UNSTAKE = { unstake: {} };
	static readonly UNSTAKE_TRANSFER = { unstakeTransfer: {} };
	static readonly STAKE_TRANSFER = { stakeTransfer: {} };
}

/** Fill/settle-PnL strictness passed to settle-PnL instructions: `TRY_SETTLE` settles as much as is safe and never fails outright, `MUST_SETTLE` requires the full requested settlement to succeed or the instruction reverts. */
export class SettlePnlMode {
	static readonly TRY_SETTLE = { trySettle: {} };
	static readonly MUST_SETTLE = { mustSettle: {} };
}

/** Returns true if the Anchor enum-class instance `object` (shape `{ [variant]: {} }`) is the given variant key. */
export function isVariant(object: unknown, type: string) {
	return Object.prototype.hasOwnProperty.call(object, type);
}

/** Returns true if the Anchor enum-class instance `object` matches any of the given variant keys. */
export function isOneOfVariant(object: unknown, types: string[]) {
	return types.reduce((result, type) => {
		return result || Object.prototype.hasOwnProperty.call(object, type);
	}, false);
}

/** Returns the sole variant key of an Anchor enum-class instance (shape `{ [variant]: {} }`), e.g. `"long"` for `PositionDirection.LONG`. */
export function getVariant(object: unknown): string {
	return Object.keys(object as object)[0];
}

/** Aggressor side of a trade for candle/trade-history purposes. `None` is used when a fill has no clear taker side (e.g. some liquidations). */
export enum TradeSide {
	None = 0,
	Buy = 1,
	Sell = 2,
}

/** Candle bucket size in minutes (`'1'`…`'240'`), or `'D'`/`'W'`/`'M'` for day/week/month candles. */
export type CandleResolution =
	| '1'
	| '5'
	| '15'
	| '60'
	| '240'
	| 'D'
	| 'W'
	| 'M';

/** Emitted when a new `UserAccount` sub-account is created. */
export type NewUserRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	subAccountId: number;
	name: number[];
	referrer: PublicKey;
};

/** Emitted on every deposit, withdraw, or internal transfer that moves tokens into/out of a spot market. */
export type DepositRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	direction: {
		deposit?: any;
		withdraw?: any;
	};
	marketIndex: number;
	/** amount moved, in the spot market's token-mint precision (`SpotMarketConfig.precision`) */
	amount: BN;
	/** PRICE_PRECISION (1e6) */
	oraclePrice: BN;
	/** market's total deposit balance after this action, SPOT_BALANCE_PRECISION (1e9) scaled balance */
	marketDepositBalance: BN;
	/** market's total borrow balance after this action, SPOT_BALANCE_PRECISION (1e9) scaled balance */
	marketWithdrawBalance: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	marketCumulativeDepositInterest: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	marketCumulativeBorrowInterest: BN;
	/** user's lifetime deposits after this action, QUOTE_PRECISION (1e6) */
	totalDepositsAfter: BN;
	/** user's lifetime withdraws after this action, QUOTE_PRECISION (1e6) */
	totalWithdrawsAfter: BN;
	depositRecordId: BN;
	explanation: DepositExplanation;
	/** set when this was a `transferDeposit`: the counterparty user account */
	transferUser?: PublicKey;
	/** the signer that authorized the action, when different from the user's own authority (e.g. a delegate or keeper) */
	signer?: PublicKey;
	/** the user's token amount (deposit/borrow value) after this action, spot market token-mint precision */
	userTokenAmountAfter: BN;
};

/** Emitted whenever a spot market's cumulative deposit/borrow interest is updated. */
export type SpotInterestRecord = {
	ts: BN;
	marketIndex: number;
	/** SPOT_BALANCE_PRECISION (1e9) */
	depositBalance: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	cumulativeDepositInterest: BN;
	/** SPOT_BALANCE_PRECISION (1e9) */
	borrowBalance: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	cumulativeBorrowInterest: BN;
	/** SPOT_UTILIZATION_PRECISION (1e6) */
	optimalUtilization: number;
	/** SPOT_RATE_PRECISION (1e6) */
	optimalBorrowRate: number;
	/** SPOT_RATE_PRECISION (1e6) */
	maxBorrowRate: number;
};

/** Emitted when a perp market's AMM curve is adjusted (repeg or `k` update). */
export type AmmCurveChanged = {
	ts: BN;
	marketIndex: number;
	/** PEG_PRECISION (1e6) */
	pegMultiplierBefore: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	baseAssetReserveBefore: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	quoteAssetReserveBefore: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	sqrtKBefore: BN;
	/** PEG_PRECISION (1e6) */
	pegMultiplierAfter: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	baseAssetReserveAfter: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	quoteAssetReserveAfter: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	sqrtKAfter: BN;
	/** signed cost of the curve adjustment, QUOTE_PRECISION (1e6) */
	adjustmentCost: BN;
	/** QUOTE_PRECISION (1e6) */
	totalFeeMinusDistributionsAfter: BN;
	/** PRICE_PRECISION (1e6) */
	oraclePrice: BN;
};

/** Emitted on insurance-fund vault operations (init/add/request-remove/remove) for a spot market's IF, keyed by the perp market that triggered it when settling a deficit. */
export declare type InsuranceFundRecord = {
	ts: BN;
	spotMarketIndex: number;
	perpMarketIndex: number;
	/** IF_FACTOR_PRECISION (1e6) share of this action attributed to the user */
	userIfFactor: number;
	/** IF_FACTOR_PRECISION (1e6) total IF factor at the time of the action */
	totalIfFactor: number;
	/** spot market vault token balance before the action, spot market token-mint precision */
	vaultAmountBefore: BN;
	/** insurance-fund vault token balance before the action, spot market token-mint precision */
	insuranceVaultAmountBefore: BN;
	totalIfSharesBefore: BN;
	totalIfSharesAfter: BN;
	/** amount moved, spot market token-mint precision */
	amount: BN;
};

/** Emitted on every `InsuranceFundStake` account mutation (stake, unstake request/cancel, unstake, transfer). */
export declare type InsuranceFundStakeRecord = {
	ts: BN;
	userAuthority: PublicKey;
	action: StakeAction;
	/** amount staked/unstaked, spot market token-mint precision */
	amount: BN;
	marketIndex: number;
	/** insurance-fund vault token balance before the action, spot market token-mint precision */
	insuranceVaultAmountBefore: BN;
	ifSharesBefore: BN;
	userIfSharesBefore: BN;
	totalIfSharesBefore: BN;
	ifSharesAfter: BN;
	userIfSharesAfter: BN;
	totalIfSharesAfter: BN;
};

/** Emitted every time a perp market's funding rate is updated. */
export type FundingRateRecord = {
	ts: BN;
	recordId: BN;
	marketIndex: number;
	/** unit is quote per base, FUNDING_RATE_PRECISION (1e9) */
	fundingRate: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	fundingRateLong: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	fundingRateShort: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	cumulativeFundingRateLong: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	cumulativeFundingRateShort: BN;
	/** PRICE_PRECISION (1e6) */
	oraclePriceTwap: BN;
	/** PRICE_PRECISION (1e6) */
	markPriceTwap: BN;
	/** BASE_PRECISION (1e9) */
	baseAssetAmountWithAmm: BN;
};

/** Emitted whenever a user's perp position settles a funding payment. */
export type FundingPaymentRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	marketIndex: number;
	/** signed, positive = user received funding; QUOTE_PRECISION (1e6) */
	fundingPayment: BN;
	/** the position size the payment was calculated against, BASE_PRECISION (1e9) */
	baseAssetAmount: BN;
	/** the user's cumulative funding rate prior to this payment, FUNDING_RATE_PRECISION (1e9) */
	userLastCumulativeFunding: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	ammCumulativeFundingLong: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	ammCumulativeFundingShort: BN;
};

/** Emitted for every liquidation action. Exactly one of `liquidatePerp`/`liquidateSpot`/`liquidateBorrowForPerpPnl`/`liquidatePerpPnlForDeposit`/`perpBankruptcy`/`spotBankruptcy` is populated, selected by `liquidationType`; the others are left as zeroed defaults. */
export type LiquidationRecord = {
	ts: BN;
	user: PublicKey;
	liquidator: PublicKey;
	liquidationType: LiquidationType;
	/** QUOTE_PRECISION (1e6) */
	marginRequirement: BN;
	/** signed, QUOTE_PRECISION (1e6) */
	totalCollateral: BN;
	/** cumulative margin freed by this liquidation so far, QUOTE_PRECISION (1e6) */
	marginFreed: BN;
	liquidationId: number;
	/** true if the user was bankrupt (their loss exceeded their collateral) as of this action */
	bankrupt: boolean;
	canceledOrderIds: number[];
	liquidatePerp: LiquidatePerpRecord;
	liquidateSpot: LiquidateSpotRecord;
	liquidateBorrowForPerpPnl: LiquidateBorrowForPerpPnlRecord;
	liquidatePerpPnlForDeposit: LiquidatePerpPnlForDepositRecord;
	perpBankruptcy: PerpBankruptcyRecord;
	spotBankruptcy: SpotBankruptcyRecord;
	/** bitmask, see `LiquidationBitFlag` */
	bitFlags: number;
};

/** Which liquidation path a `LiquidationRecord` describes; selects which of the record's sub-record fields is populated. */
export class LiquidationType {
	static readonly LIQUIDATE_PERP = { liquidatePerp: {} };
	static readonly LIQUIDATE_BORROW_FOR_PERP_PNL = {
		liquidateBorrowForPerpPnl: {},
	};
	static readonly LIQUIDATE_PERP_PNL_FOR_DEPOSIT = {
		liquidatePerpPnlForDeposit: {},
	};
	static readonly PERP_BANKRUPTCY = {
		perpBankruptcy: {},
	};
	static readonly SPOT_BANKRUPTCY = {
		spotBankruptcy: {},
	};
	static readonly LIQUIDATE_SPOT = {
		liquidateSpot: {},
	};
}

/** Populated on `LiquidationRecord` when `liquidationType` is `LIQUIDATE_PERP`: a perp position was force-closed. */
export type LiquidatePerpRecord = {
	marketIndex: number;
	/** PRICE_PRECISION (1e6) */
	oraclePrice: BN;
	/** signed size transferred to the liquidator, BASE_PRECISION (1e9) */
	baseAssetAmount: BN;
	/** QUOTE_PRECISION (1e6) */
	quoteAssetAmount: BN;
	userOrderId: number;
	liquidatorOrderId: number;
	fillRecordId: BN;
	/** paid to the liquidator, LIQUIDATOR_FEE_PRECISION (1e6)-denominated rate applied to `quoteAssetAmount`; QUOTE_PRECISION (1e6) amount */
	liquidatorFee: BN;
	/** cut routed to the insurance fund, QUOTE_PRECISION (1e6) */
	ifFee: BN;
	/** cut routed to the protocol fee pool, QUOTE_PRECISION (1e6) */
	protocolFee: BN;
};

/** Populated on `LiquidationRecord` when `liquidationType` is `LIQUIDATE_SPOT`: a spot borrow was liquidated against a spot asset deposit. */
export type LiquidateSpotRecord = {
	assetMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	assetPrice: BN;
	/** asset market token-mint precision */
	assetTransfer: BN;
	liabilityMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	liabilityPrice: BN;
	/** liability market token-mint precision */
	liabilityTransfer: BN;
	/** liability market token-mint precision */
	ifFee: BN;
	/** liability market token-mint precision */
	protocolFee: BN;
};

/** Populated on `LiquidationRecord` when `liquidationType` is `LIQUIDATE_BORROW_FOR_PERP_PNL`: a user's negative perp PnL was covered by seizing one of their spot borrows/deposits. */
export type LiquidateBorrowForPerpPnlRecord = {
	perpMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	marketOraclePrice: BN;
	/** QUOTE_PRECISION (1e6) */
	pnlTransfer: BN;
	liabilityMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	liabilityPrice: BN;
	/** liability market token-mint precision */
	liabilityTransfer: BN;
};

/** Populated on `LiquidationRecord` when `liquidationType` is `LIQUIDATE_PERP_PNL_FOR_DEPOSIT`: a user's positive perp PnL was seized to cover a deficit, paid out from one of their spot deposits. */
export type LiquidatePerpPnlForDepositRecord = {
	perpMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	marketOraclePrice: BN;
	/** QUOTE_PRECISION (1e6) */
	pnlTransfer: BN;
	assetMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	assetPrice: BN;
	/** asset market token-mint precision */
	assetTransfer: BN;
};

/** Populated on `LiquidationRecord` when `liquidationType` is `PERP_BANKRUPTCY`: a user's unpaid perp loss was resolved via insurance-fund payout and/or socialized loss (`clawbackUser`/`clawbackUserPayment` set only when a clawback source exists). */
export type PerpBankruptcyRecord = {
	marketIndex: number;
	/** the bankrupt (unresolved negative) pnl, signed, QUOTE_PRECISION (1e6) */
	pnl: BN;
	/** amount paid from the insurance fund, QUOTE_PRECISION (1e6) */
	ifPayment: BN;
	clawbackUser: PublicKey | null;
	/** QUOTE_PRECISION (1e6), set only when `clawbackUser` is set */
	clawbackUserPayment: BN | null;
	/** FUNDING_RATE_PRECISION (1e9) */
	cumulativeFundingRateDelta: BN;
};

/** Populated on `LiquidationRecord` when `liquidationType` is `SPOT_BANKRUPTCY`: a user's unpaid spot borrow was resolved via insurance-fund payout and socialized loss. */
export type SpotBankruptcyRecord = {
	marketIndex: number;
	/** spot market token-mint precision */
	borrowAmount: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	cumulativeDepositInterestDelta: BN;
	/** amount paid from the insurance fund, spot market token-mint precision */
	ifPayment: BN;
};

/** Bitmask mirror of `LiquidationRecord.bitFlags`. `IsolatedPosition` marks that the liquidation acted on an isolated-margin position rather than the user's cross-margin account. */
export class LiquidationBitFlag {
	static readonly IsolatedPosition = 1;
}

/** Emitted every time a user's perp PnL is settled against the market's pnl pool. */
export type SettlePnlRecord = {
	ts: BN;
	user: PublicKey;
	marketIndex: number;
	/** signed amount settled, QUOTE_PRECISION (1e6) */
	pnl: BN;
	/** the position size at settlement time, BASE_PRECISION (1e9) */
	baseAssetAmount: BN;
	/** `PerpPosition.quoteAssetAmount` after settlement, QUOTE_PRECISION (1e6) */
	quoteAssetAmountAfter: BN;
	/** `PerpPosition.quoteEntryAmount` at settlement time, QUOTE_PRECISION (1e6) */
	quoteEntryAmount: BN;
	/** the price pnl was settled at, PRICE_PRECISION (1e6) */
	settlePrice: BN;
	explanation: SettlePnlExplanation;
};

/** Emitted when a signed off-chain (swift) order message is matched/recorded on-chain, so indexers can associate the signed message with its resulting order. */
export type SignedMsgOrderRecord = {
	ts: BN;
	user: PublicKey;
	/** hash of the signed message, used to dedupe/look up the original signed order */
	hash: string;
	matchingOrderParams: OrderParams;
	/** slot after which the signed message is no longer eligible to be placed */
	signedMsgOrderMaxSlot: BN;
	signedMsgOrderUuid: Uint8Array;
	userOrderId: number;
};

/** Emitted whenever an `Order` slot is written (placed, updated on fill, canceled, expired, triggered) — a full snapshot of the order's post-action state. */
export type OrderRecord = {
	ts: BN;
	user: PublicKey;
	order: Order;
};

/** Emitted for every order lifecycle action (place/fill/cancel/expire/trigger). Taker/maker fields are `null` when not applicable to the action (e.g. AMM fills have no `maker`). */
export type OrderActionRecord = {
	ts: BN;
	action: OrderAction;
	actionExplanation: OrderActionExplanation;
	marketIndex: number;
	marketType: MarketType;
	filler: PublicKey | null;
	/** paid to the filler/keeper, QUOTE_PRECISION (1e6) */
	fillerReward: BN | null;
	fillRecordId: BN | null;
	/** perp: BASE_PRECISION (1e9); spot: market token-mint precision */
	baseAssetAmountFilled: BN | null;
	/** QUOTE_PRECISION (1e6) */
	quoteAssetAmountFilled: BN | null;
	/** QUOTE_PRECISION (1e6) */
	takerFee: BN | null;
	/** rebate paid to the maker (can be negative if the maker pays a fee), QUOTE_PRECISION (1e6) */
	makerFee: BN | null;
	/** BPS_PRECISION-style share of the taker fee credited to the referrer */
	referrerReward: number | null;
	/** taker's price improvement vs. their limit/oracle price, QUOTE_PRECISION (1e6) */
	quoteAssetAmountSurplus: BN | null;
	/** fee charged by the spot fulfillment method (e.g. an external DEX), spot market token-mint precision */
	spotFulfillmentMethodFee: BN | null;
	taker: PublicKey | null;
	takerOrderId: number | null;
	takerOrderDirection: PositionDirection | null;
	/** perp: BASE_PRECISION (1e9); spot: market token-mint precision */
	takerOrderBaseAssetAmount: BN | null;
	/** perp: BASE_PRECISION (1e9); spot: market token-mint precision */
	takerOrderCumulativeBaseAssetAmountFilled: BN | null;
	/** QUOTE_PRECISION (1e6) */
	takerOrderCumulativeQuoteAssetAmountFilled: BN | null;
	maker: PublicKey | null;
	makerOrderId: number | null;
	makerOrderDirection: PositionDirection | null;
	/** perp: BASE_PRECISION (1e9); spot: market token-mint precision */
	makerOrderBaseAssetAmount: BN | null;
	/** perp: BASE_PRECISION (1e9); spot: market token-mint precision */
	makerOrderCumulativeBaseAssetAmountFilled: BN | null;
	/** QUOTE_PRECISION (1e6) */
	makerOrderCumulativeQuoteAssetAmountFilled: BN | null;
	/** PRICE_PRECISION (1e6) */
	oraclePrice: BN;
	/** bitmask, currently records isolated-margin/builder-fee flags mirrored from `OrderBitFlag` */
	bitFlags: number;
	/** taker's `PerpPosition.quoteEntryAmount` immediately before this fill, QUOTE_PRECISION (1e6) */
	takerExistingQuoteEntryAmount: BN | null;
	/** taker's `PerpPosition.baseAssetAmount` immediately before this fill, BASE_PRECISION (1e9) */
	takerExistingBaseAssetAmount: BN | null;
	/** maker's `PerpPosition.quoteEntryAmount` immediately before this fill, QUOTE_PRECISION (1e6) */
	makerExistingQuoteEntryAmount: BN | null;
	/** maker's `PerpPosition.baseAssetAmount` immediately before this fill, BASE_PRECISION (1e9) */
	makerExistingBaseAssetAmount: BN | null;
	/** PRICE_PRECISION (1e6), set only for trigger-order fills */
	triggerPrice: BN | null;
	/** index into the taker's `RevenueShareEscrow.approvedBuilders`, set only when the taker order had `OrderBitFlag.HasBuilder` */
	builderIdx: number | null;
	/** builder fee charged on this fill, QUOTE_PRECISION (1e6) */
	builderFee: BN | null;
};

/** Emitted on every constant-product spot swap (`beginSwap`/`endSwap`) between two spot markets. */
export type SwapRecord = {
	ts: BN;
	user: PublicKey;
	/** out market token-mint precision */
	amountOut: BN;
	/** in market token-mint precision */
	amountIn: BN;
	outMarketIndex: number;
	inMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	outOraclePrice: BN;
	/** PRICE_PRECISION (1e6) */
	inOraclePrice: BN;
	/** total fee charged on the swap, out market token-mint precision */
	fee: BN;
};

/** Emitted when a spot market's vault balance is reconciled against `SpotMarketAccount.depositBalance`/`borrowBalance` (drift/donation detection). */
export type SpotMarketVaultDepositRecord = {
	ts: BN;
	marketIndex: number;
	/** SPOT_BALANCE_PRECISION (1e9) */
	depositBalance: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	cumulativeDepositInterestBefore: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	cumulativeDepositInterestAfter: BN;
	/** spot market token-mint precision */
	depositTokenAmountBefore: BN;
	/** spot market token-mint precision */
	amount: BN;
};

/** Emitted when a `UserAccount` sub-account is deleted. */
export type DeleteUserRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	subAccountId: number;
	/** set when a keeper (not the user/delegate) deleted an idle account */
	keeper: PublicKey | null;
};

/** Emitted on every constituent-to-constituent swap inside an LP pool (`LPPoolAccount`). */
export type LPSwapRecord = {
	ts: BN;
	slot: BN;
	authority: PublicKey;
	/** out constituent's spot market token-mint precision */
	outAmount: BN;
	/** in constituent's spot market token-mint precision */
	inAmount: BN;
	/** out constituent's spot market token-mint precision */
	outFee: BN;
	/** in constituent's spot market token-mint precision */
	inFee: BN;
	outSpotMarketIndex: number;
	inSpotMarketIndex: number;
	outConstituentIndex: number;
	inConstituentIndex: number;
	/** PRICE_PRECISION (1e6) */
	outOraclePrice: BN;
	/** PRICE_PRECISION (1e6) */
	inOraclePrice: BN;
	/** LP pool AUM at the time of the swap, QUOTE_PRECISION (1e6) */
	lastAum: BN;
	lastAumSlot: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	inMarketCurrentWeight: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	outMarketCurrentWeight: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	inMarketTargetWeight: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	outMarketTargetWeight: BN;
	inSwapId: BN;
	outSwapId: BN;
	lpPool: PublicKey;
};

/** Emitted when LP tokens are minted (deposit) or redeemed (withdraw) against an LP pool. */
export type LPMintRedeemRecord = {
	ts: BN;
	slot: BN;
	authority: PublicKey;
	/** encodes mint vs. redeem (and any sub-variant); compare against the program's `MintRedeemDescription` discriminant */
	description: number;
	/** constituent spot market token-mint precision */
	amount: BN;
	/** constituent spot market token-mint precision */
	fee: BN;
	spotMarketIndex: number;
	constituentIndex: number;
	/** PRICE_PRECISION (1e6) */
	oraclePrice: BN;
	mint: PublicKey;
	/** LP token precision (quote-mint precision, QUOTE_PRECISION 1e6) */
	lpAmount: BN;
	/** LP token precision */
	lpFee: BN;
	/** LP token price, PRICE_PRECISION (1e6) */
	lpPrice: BN;
	mintRedeemId: BN;
	/** LP pool AUM at the time of the action, QUOTE_PRECISION (1e6) */
	lastAum: BN;
	lastAumSlot: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	inMarketCurrentWeight: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	inMarketTargetWeight: BN;
	lpPool: PublicKey;
};

/** Emitted when a perp market settles PnL/fees with its hedging LP pool. */
export type LPSettleRecord = {
	recordId: BN;
	lastTs: BN;
	lastSlot: BN;
	ts: BN;
	slot: BN;
	perpMarketIndex: number;
	/** signed amount transferred to/from the LP pool, QUOTE_PRECISION (1e6) */
	settleToLpAmount: BN;
	/** signed, QUOTE_PRECISION (1e6) */
	perpAmmPnlDelta: BN;
	/** signed, QUOTE_PRECISION (1e6) */
	perpAmmExFeeDelta: BN;
	/** LP pool AUM after this settle, QUOTE_PRECISION (1e6) */
	lpAum: BN;
	/** LP token price after this settle, PRICE_PRECISION (1e6) */
	lpPrice: BN;
	lpPool: PublicKey;
};

/** Emitted when an LP pool constituent's borrow/lend deposit into (or withdrawal from) the underlying spot market changes. */
export type LPBorrowLendDepositRecord = {
	ts: BN;
	slot: BN;
	spotMarketIndex: number;
	constituentIndex: number;
	direction: DepositDirection;
	/** constituent spot market token-mint precision */
	tokenBalance: BN;
	/** constituent spot market token-mint precision */
	lastTokenBalance: BN;
	/** interest accrued since the last update, constituent spot market token-mint precision */
	interestAccruedTokenAmount: BN;
	/** constituent spot market token-mint precision */
	amountDepositWithdraw: BN;
	lpPool: PublicKey;
};

/**
 * The protocol's single global config account (one per deployment). Decoded mirror of the Rust
 * `State` zero-copy account.
 *
 * **Admin tiers** — three levels of authority, from slowest/most-trusted to fastest/least-trusted:
 * - `coldAdmin`: root authority, set once at `initialize`. Only key that can rotate `warmAdmin`
 *   and `pauseAdmin`. Expected to sit behind a (small) timelocked multisig.
 * - `warmAdmin`: operational authority that can rotate the eleven `hot*` bot keys below.
 *   `PublicKey.default()` means unset, in which case only `coldAdmin` can act.
 * - `pauseAdmin`: emergency-pause authority with no on-chain timelock — may only *add* pause bits
 *   to `exchangeStatus` (never clear them); `coldAdmin`/`warmAdmin` retain full pause+unpause power.
 *   `PublicKey.default()` means unassigned (only cold/warm can pause).
 *
 * **Hot role keys** (`hot*`): purpose-specific bot keys for high-frequency keeper actions (AMM
 * cranking, LP cache/swap/settle, feature-flag toggles, fuel, user-flag updates, vault deposits,
 * mm-oracle cranking, AMM spread adjustment, protocol-fee withdrawal). `PublicKey.default()` means
 * the role is unassigned and only `warmAdmin`/`coldAdmin` may call handlers gated on that role.
 */
export type StateAccount = {
	coldAdmin: PublicKey;
	warmAdmin: PublicKey;
	pauseAdmin: PublicKey;
	hotAmmCrank: PublicKey;
	hotLpCache: PublicKey;
	hotLpSwap: PublicKey;
	hotLpSettle: PublicKey;
	hotFeatureFlag: PublicKey;
	hotFuel: PublicKey;
	hotUserFlag: PublicKey;
	hotVaultDeposit: PublicKey;
	hotMmOracleCrank: PublicKey;
	hotAmmSpreadAdjust: PublicKey;
	/** hot key authorized to trigger protocol-fee withdrawals to `protocolFeeRecipientPerp`/`protocolFeeRecipientSpot` */
	hotFeeWithdraw: PublicKey;
	/** treasury PERP protocol fees are withdrawn to (settable only by `coldAdmin`); `PublicKey.default()` makes perp fee withdrawals inert */
	protocolFeeRecipientPerp: PublicKey;
	/** treasury SPOT protocol fees are withdrawn to (settable only by `coldAdmin`); `PublicKey.default()` makes spot fee withdrawals inert */
	protocolFeeRecipientSpot: PublicKey;
	/** bitmask, see `ExchangeStatus` */
	exchangeStatus: number;
	whitelistMint: PublicKey;
	discountMint: PublicKey;
	oracleGuardRails: OracleGuardRails;
	numberOfAuthorities: BN;
	numberOfSubAccounts: BN;
	numberOfMarkets: number;
	numberOfSpotMarkets: number;
	/** slots */
	minPerpAuctionDuration: number;
	/** seconds */
	defaultMarketOrderTimeInForce: number;
	/** slots */
	defaultSpotAuctionDuration: number;
	/** MARGIN_PRECISION (1e4); extra maintenance-margin buffer required before a liquidation may proceed */
	liquidationMarginBufferRatio: number;
	/** seconds a market stays in `SETTLEMENT` status before positions must be settled */
	settlementDuration: number;
	maxNumberOfSubAccounts: number;
	signer: PublicKey;
	signerNonce: number;
	srmVault: PublicKey;
	/** default `FeeStructure` applied to new perp markets */
	perpFeeStructure: FeeStructure;
	/** default `FeeStructure` applied to new spot markets */
	spotFeeStructure: FeeStructure;
	/** LIQUIDATION_PCT_PRECISION (1e4); fraction of a position liquidated per partial-liquidation pass */
	initialPctToLiquidate: number;
	/** seconds a liquidation is spread over */
	liquidationDuration: number;
	/** max SOL fee `getInitUserFee` may charge to create a new sub-account, in value/100 SOL (e.g. 100 = 1 SOL); ramps from 0 to this max as account-space utilization rises from 80% to 100% of `maxNumberOfSubAccounts` */
	maxInitializeUserFee: number;
	/** bitmask, see `FeatureBitFlags` */
	featureBitFlags: number;
	/** bitmask of LP-pool-specific feature flags */
	lpPoolFeatureBitFlags: number;
	/** bitmask, see `SolvencyStatus` */
	solvencyStatus: number;
};

/** Decoded mirror of the on-chain `PerpMarket` zero-copy account. */
export type PerpMarketAccount = {
	status: MarketStatus;
	contractType: ContractType;
	contractTier: ContractTier;
	/** unix timestamp the market will expire; only set if the market is reduce-only */
	expiryTs: BN;
	/** PRICE_PRECISION (1e6); the price positions settle at, only set once the market is expired */
	expiryPrice: BN;
	marketIndex: number;
	pubkey: PublicKey;
	name: number[];
	/** the market's constant-product vAMM state */
	amm: AMM;
	/** market-wide stats shared across all makers (mark/oracle TWAPs, volume, mm-oracle snapshot) */
	marketStats: MarketStats;
	numberOfUsersWithBase: number;
	numberOfUsers: number;
	/** MARGIN_PRECISION (1e4); collateral fraction required to open a position, e.g. 1000 = 10% = 10x max leverage */
	marginRatioInitial: number;
	/** MARGIN_PRECISION (1e4); collateral fraction below which a position is liquidated */
	marginRatioMaintenance: number;
	nextFillRecordId: BN;
	nextFundingRateRecordId: BN;
	/** the market's pnl pool: increases when users settle negative pnl, decreases when users settle positive pnl; SPOT_BALANCE_PRECISION (1e9) scaled balance in the quote spot market */
	pnlPool: PoolBalance;
	/** protocol-owned quote-denominated fee claim, withdrawn to `StateAccount.protocolFeeRecipientPerp`; SPOT_BALANCE_PRECISION (1e9) scaled balance */
	protocolFeePool: PoolBalance;
	/** consolidated fee-split accounting: lifetime analytics counters plus pending protocol/IF/AMM carveouts */
	feeLedger: FeeLedger;
	/** LIQUIDATOR_FEE_PRECISION (1e6); fee paid to the liquidator for taking over the position */
	liquidatorFee: number;
	/** LIQUIDATOR_FEE_PRECISION (1e6); cut of a liquidation routed to the insurance fund */
	ifLiquidationFee: number;
	/** LIQUIDATOR_FEE_PRECISION (1e6); protocol's cut of a liquidation, taken from the liquidatee */
	protocolLiquidationFee: number;
	/** QUOTE_PRECISION (1e6); pnl-pool retention buffer the fee-sweep leaves untouched above `max(net_user_pnl, 0)` */
	feePoolBufferTarget: BN;
	/** MARGIN_PRECISION (1e4); scales margin ratio up for large positions */
	imfFactor: number;
	/** MARGIN_PRECISION (1e4); discounts positive-unrealized-pnl asset weight for large positions */
	unrealizedPnlImfFactor: number;
	/** QUOTE_PRECISION (1e6); pnl imbalance (long pnl − short pnl) above which positive-pnl asset weight starts being discounted */
	unrealizedPnlMaxImbalance: BN;
	/** SPOT_WEIGHT_PRECISION (1e4); initial-margin asset weight applied to a user's unrealized positive pnl */
	unrealizedPnlInitialAssetWeight: number;
	/** SPOT_WEIGHT_PRECISION (1e4); maintenance-margin asset weight applied to a user's unrealized positive pnl */
	unrealizedPnlMaintenanceAssetWeight: number;
	/** the market's claim on the insurance fund */
	insuranceClaim: {
		/** QUOTE_PRECISION (1e6), signed: positive if funds left the market, negative if pulled in */
		revenueWithdrawSinceLastSettle: BN;
		/** QUOTE_PRECISION (1e6); cap on revenue withdrawable per settle period */
		maxRevenueWithdrawPerPeriod: BN;
		lastRevenueWithdrawTs: BN;
		/** QUOTE_PRECISION (1e6); insurance already used to resolve bankruptcy/pnl deficits */
		quoteSettledInsurance: BN;
		/** QUOTE_PRECISION (1e6); max insurance this market may draw to resolve bankruptcy/pnl deficits */
		quoteMaxInsurance: BN;
	};
	quoteSpotMarketIndex: number;
	/** -100 to 100; percentage adjustment applied to the base fee rate (e.g. -50 halves a 5bps fee to 2.5bps) */
	feeAdjustment: number;
	/** bitmask, see `PerpOperation` */
	pausedOperations: number;

	/** PRICE_PRECISION (1e6); price of the most recent fill */
	lastFillPrice: BN;
	poolId: number;

	/** this market's relationship to its hedging LP pool; admin-set, never mutated per fill */
	hedgeConfig: {
		/** the `LPPoolAccount.lpPoolId` this market hedges into */
		poolId: number;
		/** hedging enabled for this market when non-zero */
		status: number;
		/** bitmask of paused `ConstituentLpOperation`s */
		pausedOperations: number;
		/** scalar excluding a share of exchange fees from hedge routing */
		exchangeFeeExclusionScalar: number;
		/** scalar for the share of fees transferred to the hedge pool */
		feeTransferScalar: number;
	};
	/** bitmask, see `MarketConfigFlag` */
	marketConfig: number;

	// Fields migrated off AMM to top-level PerpMarket
	oracle: PublicKey;
	oracleSource: OracleSource;
	/** override for the per-fill slot delay required from the oracle; -1 = use the state default */
	oracleSlotDelayOverride: number;
	/** override for `StateAccount.minPerpAuctionDuration`; 0 = no override, -1 = disable speed bump, 1-100 = literal speed bump slots */
	oracleLowRiskSlotDelayOverride: number;
	/** always non-negative; total long open interest across all users, BASE_PRECISION (1e9) */
	baseAssetAmountLong: BN;
	/** always non-positive; total short open interest across all users, BASE_PRECISION (1e9) */
	baseAssetAmountShort: BN;
	/** sum of all users' `PerpPosition.quoteAssetAmount` in this market, QUOTE_PRECISION (1e6) */
	quoteAssetAmount: BN;
	/** QUOTE_PRECISION (1e6) */
	quoteEntryAmountLong: BN;
	/** QUOTE_PRECISION (1e6) */
	quoteEntryAmountShort: BN;
	/** QUOTE_PRECISION (1e6) */
	quoteBreakEvenAmountLong: BN;
	/** QUOTE_PRECISION (1e6) */
	quoteBreakEvenAmountShort: BN;
	/** QUOTE_PRECISION (1e6); accumulated socialized loss paid by users in this market since inception */
	totalSocialLoss: BN;
	/** BASE_PRECISION (1e9); max allowed open interest — trades that would breach this are blocked */
	maxOpenInterest: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	cumulativeFundingRateLong: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	cumulativeFundingRateShort: BN;
	/** unit is quote per base, FUNDING_RATE_PRECISION (1e9) */
	lastFundingRate: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	lastFundingRateLong: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	lastFundingRateShort: BN;
	lastFundingRateTs: BN;
	/** unsettled funding pnl across the whole market */
	netUnsettledFundingPnl: BN;
	/** BPS_PRECISION (1e4); dead-zone threshold for the funding premium — mark/oracle spreads within this band add no funding premium */
	fundingClampThreshold: number;
	/** PERCENTAGE_PRECISION (1e6); slope of the funding premium ramp above the dead zone (1.0x = pass shrunk spread through unchanged) */
	fundingRampSlope: number;
	/** orders must be a multiple of this, BASE_PRECISION (1e9) */
	orderStepSize: BN;
	/** orders must be a multiple of this, PRICE_PRECISION (1e6) */
	orderTickSize: BN;
};

/** Oracle price/TWAP snapshot shared by `PerpMarketAccount.marketStats` and `SpotMarketAccount`. All price fields are PRICE_PRECISION (1e6). */
export type HistoricalOracleData = {
	lastOraclePrice: BN;
	/** number of slots since the last oracle update */
	lastOracleDelay: BN;
	lastOracleConf: BN;
	lastOraclePriceTwap: BN;
	lastOraclePriceTwap5Min: BN;
	/** unix timestamp of the last TWAP snapshot */
	lastOraclePriceTwapTs: BN;
};

/** Rolling index-price stats for a spot market (bid/ask/TWAP of the underlying index, e.g. a basket or peg reference). All price fields are PRICE_PRECISION (1e6). */
export type HistoricalIndexData = {
	lastIndexBidPrice: BN;
	lastIndexAskPrice: BN;
	lastIndexPriceTwap: BN;
	lastIndexPriceTwap5Min: BN;
	/** unix timestamp of the last TWAP snapshot */
	lastIndexPriceTwapTs: BN;
};

/** Decoded mirror of the on-chain `SpotMarket` zero-copy account. */
export type SpotMarketAccount = {
	status: MarketStatus;
	assetTier: AssetTier;
	name: number[];

	marketIndex: number;
	pubkey: PublicKey;
	mint: PublicKey;
	/** the market's token vault; balance should be >= `depositBalance` token amount − `borrowBalance` token amount */
	vault: PublicKey;

	oracle: PublicKey;
	oracleSource: OracleSource;
	historicalOracleData: HistoricalOracleData;
	historicalIndexData: HistoricalIndexData;

	/** covers bankruptcies for borrows of this market's token and perps settling in this market's token */
	insuranceFund: {
		vault: PublicKey;
		totalShares: BN;
		userShares: BN;
		/** exponent used to rebase `totalShares`/`userShares` */
		sharesBase: BN;
		/** seconds a stake must wait after an unstake request before it can be withdrawn */
		unstakingPeriod: BN;
		lastRevenueSettleTs: BN;
		/** seconds; how often `revenuePool` may settle into the IF vault */
		revenueSettlePeriod: BN;
		/** IF_FACTOR_PRECISION (1e6); fraction of spot deposit-interest gains carved out to the (100% staker-owned) insurance fund */
		ifFeeFactor: number;
	};

	/** revenue this market's token has collected (e.g. for SOL-PERP, settled funds flow into the USDC revenue pool); SPOT_BALANCE_PRECISION (1e9) scaled balance */
	revenuePool: PoolBalance;
	/** protocol-owned fee claim in this market's token, withdrawn to `StateAccount.protocolFeeRecipientSpot`; SPOT_BALANCE_PRECISION (1e9) scaled balance */
	protocolFeePool: PoolBalance;

	/** LIQUIDATOR_FEE_PRECISION (1e6); cut of a liquidation routed to the insurance fund */
	ifLiquidationFee: number;
	/** LIQUIDATOR_FEE_PRECISION (1e6); protocol's cut of a spot liquidation, taken from the liquidatee */
	protocolLiquidationFee: number;
	/** IF_FACTOR_PRECISION (1e6); protocol's carveout of lending deposit-interest gains */
	protocolFeeFactor: number;

	/** token mint decimals; token-mint precision throughout this account is 10^decimals */
	decimals: number;
	/** SPOT_UTILIZATION_PRECISION (1e6) */
	optimalUtilization: number;
	/** SPOT_RATE_PRECISION (1e6); borrow rate when the market is at `optimalUtilization` */
	optimalBorrowRate: number;
	/** SPOT_RATE_PRECISION (1e6); borrow rate at 100% utilization */
	maxBorrowRate: number;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	cumulativeDepositInterest: BN;
	/** SPOT_CUMULATIVE_INTEREST_PRECISION (1e10) */
	cumulativeBorrowInterest: BN;
	/** token mint precision; accumulated socialized loss from borrows, in this market's own token */
	totalSocialLoss: BN;
	/** QUOTE_PRECISION (1e6); accumulated socialized loss from borrows, converted to quote */
	totalQuoteSocialLoss: BN;
	/** SPOT_BALANCE_PRECISION (1e9) scaled balance; multiply by `cumulativeDepositInterest` for the token amount */
	depositBalance: BN;
	/** SPOT_BALANCE_PRECISION (1e9) scaled balance; multiply by `cumulativeBorrowInterest` for the token amount */
	borrowBalance: BN;
	/** token mint precision; 0 = no limit */
	maxTokenDeposits: BN;

	lastInterestTs: BN;
	lastTwapTs: BN;
	/** unix timestamp the market is set to expire; only set if reduce-only */
	expiryTs: BN;
	/** SPOT_WEIGHT_PRECISION (1e4); e.g. 8000 (.8) means $100 of deposits contributes $80 to initial collateral */
	initialAssetWeight: number;
	/** SPOT_WEIGHT_PRECISION (1e4); e.g. 9000 (.9) means $100 of deposits contributes $90 to maintenance collateral */
	maintenanceAssetWeight: number;
	/** SPOT_WEIGHT_PRECISION (1e4); e.g. 9000 (.9) means $100 of borrows contributes $90 to the initial margin requirement */
	initialLiabilityWeight: number;
	/** SPOT_WEIGHT_PRECISION (1e4); e.g. 8000 (.8) means $100 of borrows contributes $80 to the maintenance margin requirement */
	maintenanceLiabilityWeight: number;
	/** LIQUIDATOR_FEE_PRECISION (1e6); fee paid to the liquidator for taking over the borrow/deposit */
	liquidatorFee: number;
	/** MARGIN_PRECISION (1e4); scales liability weight up / asset weight down for large positions */
	imfFactor: number;
	/** QUOTE_PRECISION (1e6); deposit level at which `initialAssetWeight` begins scaling down; 0 = disabled */
	scaleInitialAssetWeightStart: BN;

	/** token mint precision; below this vault balance, no withdraw limits/guards apply */
	withdrawGuardThreshold: BN;
	/** token mint precision; 24h rolling average of deposit token amount */
	depositTokenTwap: BN;
	/** token mint precision; 24h rolling average of borrow token amount */
	borrowTokenTwap: BN;
	/** SPOT_UTILIZATION_PRECISION (1e6); 24h rolling average utilization (borrow / total) */
	utilizationTwap: BN;
	nextDepositRecordId: BN;

	/** orders must be a multiple of this, token mint precision */
	orderStepSize: BN;
	/** orders must be a multiple of this, PRICE_PRECISION (1e6) */
	orderTickSize: BN;
	/** token mint precision */
	minOrderSize: BN;
	/** token mint precision; 0 = no limit */
	maxPositionSize: BN;
	nextFillRecordId: BN;
	/** fees collected from swaps between this market and the quote market, settled to the quote market's revenue pool; SPOT_BALANCE_PRECISION (1e9) scaled balance */
	spotFeePool: PoolBalance;
	/** QUOTE_PRECISION (1e6) */
	totalSpotFee: BN;
	/** token mint precision; total fees received from swaps */
	totalSwapFee: BN;

	/** token mint precision; amount loaned out in `beginSwap`, for the in-flight flash-loan invariant check */
	flashLoanAmount: BN;
	/** token mint precision; user's token balance snapshotted at `beginSwap`, used to compute how much left the system by `endSwap` */
	flashLoanInitialTokenAmount: BN;

	ordersEnabled: boolean;

	/** bitmask, see `SpotOperation` */
	pausedOperations: number;

	/** bitmask, see `InsuranceFundOperation` */
	ifPausedOperations: number;

	/** X/10000; fraction of `maxTokenDeposits` that may be borrowed in total; 0 disables the cap */
	maxTokenBorrowsFraction: number;
	/** X/200; floor borrow rate regardless of utilization */
	minBorrowRate: number;

	/** bitmask, see `TokenProgramFlag` */
	tokenProgramFlag: number;

	poolId: number;

	/** -100 to 100; percentage adjustment applied to the base fee rate */
	feeAdjustment: number;
};

/** A scaled token balance inside a market's internal pools (pnl pool, protocol fee pool, revenue pool, spot fee pool, AMM fee pool). Multiply `scaledBalance` (SPOT_BALANCE_PRECISION, 1e9) by the referenced spot market's `cumulativeDepositInterest`/`cumulativeBorrowInterest` to get the token amount. */
export type PoolBalance = {
	scaledBalance: BN;
	/** the spot market this balance's token amount is denominated in */
	marketIndex: number;
};

/**
 * Consolidated per-market fee ledger: lifetime analytics counters plus the pending
 * (not-yet-materialized) protocol/IF/AMM carveouts and the AMM's backstop-of-last-resort
 * clawback cap. All fields are QUOTE_PRECISION (1e6). Pure counters — the actual token claims
 * live in `PerpMarketAccount.protocolFeePool` / `pnlPool` / `AMM.feePool`.
 */
export type FeeLedger = {
	/** lifetime gross taker fees collected (analytics only, post referee-discount, pre carve-outs) */
	totalExchangeFee: BN;
	/** lifetime liquidation fees charged to liquidatees (IF + protocol cuts; analytics only) */
	totalLiquidationFee: BN;
	/** protocol carveouts accrued but not yet materialized into `protocolFeePool` */
	pendingProtocolFee: BN;
	/** insurance-fund carveouts accrued but not yet materialized into the quote market's revenue pool; also the first bankruptcy tranche */
	pendingIfFee: BN;
	/** cumulative fee provision granted to the AMM as its backstop-of-last-resort tranche; drawable (and decremented) only in bankruptcy */
	ammProtocolFeesReceived: BN;
	/** AMM fee provision accrued at fill but not yet tokenized into `AMM.feePool` by the sweep; always `<= ammProtocolFeesReceived` */
	pendingAmmProvision: BN;
};

/** Decoded mirror of the on-chain constant-product `AMM` struct embedded in `PerpMarketAccount.amm`. */
export type AMM = {
	/** partition of fees moved from pnl settlements; SPOT_BALANCE_PRECISION (1e9) scaled balance */
	feePool: PoolBalance;
	/** `x` reserve of the constant-product formula (x*y=k), AMM_RESERVE_PRECISION (1e9) */
	baseAssetReserve: BN;
	/** `y` reserve of the constant-product formula (x*y=k), AMM_RESERVE_PRECISION (1e9) */
	quoteAssetReserve: BN;
	/** PERCENTAGE_PRECISION (1e6); how tightly the min/max reserves bracket the current reserves (lowers slippage without adding liquidity) */
	concentrationCoef: BN;
	/** AMM_RESERVE_PRECISION (1e9); reserve floor below which the AMM is unavailable */
	minBaseAssetReserve: BN;
	/** AMM_RESERVE_PRECISION (1e9); reserve ceiling above which the AMM is unavailable */
	maxBaseAssetReserve: BN;
	/** `sqrt(k)`, AMM_RESERVE_PRECISION (1e9); cached to avoid precision loss recomputing it */
	sqrtK: BN;
	/** normalizes quote reserves for lowest slippage when the market is balanced; PEG_PRECISION (1e6) */
	pegMultiplier: BN;
	/** `y` reserve when the market is balanced, AMM_RESERVE_PRECISION (1e9) */
	terminalQuoteAssetReserve: BN;
	/** net position (longs − shorts) with the AMM as counterparty, BASE_PRECISION (1e9) */
	baseAssetAmountWithAmm: BN;
	/** the AMM's own fee-derived income (provision + spread surplus), QUOTE_PRECISION (1e6) — the market's gross fees are `feeLedger.totalExchangeFee` */
	totalFee: BN;
	/** spread-capture component of `totalFee` (trading profit, not a paid fee), QUOTE_PRECISION (1e6) */
	totalMmFee: BN;
	/** the AMM's equity ledger (retained earnings): fee income + funding/PnL + credits − curve costs − bankruptcy clawbacks; AMM money only, QUOTE_PRECISION (1e6) */
	totalFeeMinusDistributions: BN;
	/** @deprecated frozen pre-isolation analytics counter; nothing writes this anymore. QUOTE_PRECISION (1e6) */
	totalFeeWithdrawn: BN;
	/** cached spread-adjusted ask (long-take) reserve, AMM_RESERVE_PRECISION (1e9) */
	askBaseAssetReserve: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	askQuoteAssetReserve: BN;
	/** cached spread-adjusted bid (short-take) reserve, AMM_RESERVE_PRECISION (1e9) */
	bidBaseAssetReserve: BN;
	/** AMM_RESERVE_PRECISION (1e9) */
	bidQuoteAssetReserve: BN;
	lastUpdateSlot: BN;
	/** change in `totalFeeMinusDistributions` since the last funding update, QUOTE_PRECISION (1e6) */
	netRevenueSinceLastFunding: BN;
	/** the AMM's last-seen cumulative long funding rate (mirrors `PerpPosition.lastCumulativeFundingRate`), FUNDING_RATE_PRECISION (1e9) */
	lastCumulativeFundingRateLong: BN;
	/** FUNDING_RATE_PRECISION (1e9) */
	lastCumulativeFundingRateShort: BN;
	/** signed, BID_ASK_SPREAD_PRECISION (1e6); cached oracle-vs-reserve price spread feeding `calculate_spread` */
	lastOracleReservePriceSpreadPct: BN;
	lastSpreadUpdateSlot: BN;
	/** BID_ASK_SPREAD_PRECISION (1e6); minimum spread the AMM can quote */
	baseSpread: number;
	/** BID_ASK_SPREAD_PRECISION (1e6); maximum spread the AMM can quote */
	maxSpread: number;
	/** BID_ASK_SPREAD_PRECISION (1e6); cached spread applied to the ask (long-take) side */
	longSpread: number;
	/** BID_ASK_SPREAD_PRECISION (1e6); cached spread applied to the bid (short-take) side */
	shortSpread: number;
	/** signed, PRICE_PRECISION (1e6); cached reference-price offset applied to both sides' quotes */
	referencePriceOffset: number;
	/** fraction of total available liquidity a single AMM fill may consume */
	maxFillReserveFraction: number;
	/** maximum slippage ratio a single AMM fill may push */
	maxSlippageRatio: number;
	/** 0-100; intensity of the AMM's formulaic `k` updates */
	curveUpdateIntensity: number;
	/** 0 = no AMM JIT participation, (0,100] = intensity of protocol-owned-AMM JIT participation */
	ammJitIntensity: number;
	/** signed, -100 = 0x scale, 100 = 2x scale, applied to the computed spread */
	ammSpreadAdjustment: number;
	/** signed, -100 = 0x scale, 100 = 2x scale, applied to the inventory-skew component of the spread */
	ammInventorySpreadAdjustment: number;
	referencePriceOffsetDeadbandPct: number;
	/** stored in hundredths (value/100); how much the paying side's spread widens while the AMM pays funding on its inventory — 50 => 1.5x, 100 => 2x, 0 disables the bias */
	fundingBiasSensitivity: number;
};

/** Market-wide stats shared across all makers (vAMM, DLOB resting orders, JIT participants), updated on every fill regardless of which maker filled. */
export type MarketStats = {
	/** average (bid+ask)/2 price over `fundingPeriod`, PRICE_PRECISION (1e6) */
	lastMarkPriceTwap: BN;
	/** average (bid+ask)/2 price over 5 minutes, PRICE_PRECISION (1e6) */
	lastMarkPriceTwap5Min: BN;
	lastMarkPriceTwapTs: BN;
	/** PRICE_PRECISION (1e6) */
	lastBidPriceTwap: BN;
	/** PRICE_PRECISION (1e6) */
	lastAskPriceTwap: BN;
	/** standard deviation of fill (mark) prices, PRICE_PRECISION (1e6) */
	markStd: BN;
	/** standard deviation of the oracle price at each update, PRICE_PRECISION (1e6) */
	oracleStd: BN;
	/** PERCENTAGE_PRECISION (1e6); size of the oracle confidence interval as a fraction of price */
	lastOracleConfPct: BN;
	/** QUOTE_PRECISION (1e6); estimated total volume traded in the market */
	volume24H: BN;
	longIntensityVolume: BN;
	shortIntensityVolume: BN;
	lastTradeTs: BN;
	/** unit is quote per base, QUOTE_PRECISION (1e6); estimate of the last 24h average funding rate */
	last24HAvgFundingRate: BN;
	/** seconds; periodicity of funding rate updates */
	fundingPeriod: BN;
	/** BASE_PRECISION (1e9); minimum order size, mirrored here from `PerpMarketAccount` config so the AMM can read it without touching the market's other fields */
	minOrderSize: BN;
	/** market-maker oracle price snapshot set by the native `updateMmOracle` handler */
	mmOraclePrice: BN;
	mmOracleSlot: BN;
	/** monotonically increasing; guards against out-of-order mm-oracle updates */
	mmOracleSequenceId: BN;
	/** canonical sanitised/clamped oracle price after normalisation */
	lastOracleNormalisedPrice: BN;
	/** PRICE_PRECISION (1e6); reference-price offset from the previous `_update_amm` call, used to smooth the sign-flip transition when the freshly computed offset changes direction */
	lastReferencePriceOffset: number;
	lastOracleValid: boolean;
	/** unit is quote per base, QUOTE_PRECISION (1e6); oracle TWAP snapshot used by the funding-rate computation */
	lastFundingOracleTwap: BN;
	historicalOracleData: HistoricalOracleData;
};

// # User Account Types
/** A user's position in one perp market. Decoded mirror of the on-chain `PerpPosition`. */
export type PerpPosition = {
	/** signed size of the position, BASE_PRECISION (1e9) */
	baseAssetAmount: BN;
	/** the market's last cumulative funding rate this position has settled against, FUNDING_RATE_PRECISION (1e9) */
	lastCumulativeFundingRate: BN;
	marketIndex: number;
	/** used to calculate pnl; updated on open/close/settle, includes fees/funding, QUOTE_PRECISION (1e6) */
	quoteAssetAmount: BN;
	/** quote the position was entered with (base * avg entry price), excludes fees/funding, QUOTE_PRECISION (1e6) */
	quoteEntryAmount: BN;
	/** quote needed to exit at breakeven, includes fees/funding, QUOTE_PRECISION (1e6) */
	quoteBreakEvenAmount: BN;
	openOrders: number;
	/** size of non-reduce-only bids resting/triggering against this position, BASE_PRECISION (1e9) */
	openBids: BN;
	/** size of non-reduce-only asks resting/triggering against this position, BASE_PRECISION (1e9) */
	openAsks: BN;
	/** cumulative pnl settled in this market since the position was opened, QUOTE_PRECISION (1e6) */
	settledPnl: BN;
	/**	 TODO: remove this field - it doesn't exist on chain */
	remainderBaseAssetAmount: number;
	/** MARGIN_PRECISION (1e4); custom max margin ratio for this position, 0 = use the market default */
	maxMarginRatio: number;
	/** bitmask, see `PositionFlag` */
	positionFlag: number;
	/** SPOT_BALANCE_PRECISION (1e9) scaled balance backing this position when it is isolated-margin (`PositionFlag.IsolatedPosition` set) */
	isolatedPositionScaledBalance: BN;
};

/** Decoded mirror of the on-chain `UserStats` account: authority-level (cross-sub-account) rolling volume, fee, and referral stats. */
export type UserStatsAccount = {
	numberOfSubAccounts: number;
	/** can exceed `numberOfSubAccounts` if sub-accounts were deleted */
	numberOfSubAccountsCreated: number;
	/** rolling 30-day maker volume, QUOTE_PRECISION (1e6) */
	makerVolume30D: BN;
	/** rolling 30-day taker volume, QUOTE_PRECISION (1e6) */
	takerVolume30D: BN;
	/** rolling 30-day filler (keeper) volume, QUOTE_PRECISION (1e6) */
	fillerVolume30D: BN;
	lastMakerVolume30DTs: BN;
	lastTakerVolume30DTs: BN;
	lastFillerVolume30DTs: BN;
	fees: {
		/** total taker fees paid, QUOTE_PRECISION (1e6) */
		totalFeePaid: BN;
		/** total maker rebate received, QUOTE_PRECISION (1e6) */
		totalFeeRebate: BN;
		/** total discount from holding the discount token, QUOTE_PRECISION (1e6) */
		totalTokenDiscount: BN;
		/** total discount from being a referred user, QUOTE_PRECISION (1e6) */
		totalRefereeDiscount: BN;
	};
	referrer: PublicKey;
	/** bitmask, see `ReferrerStatus` */
	referrerStatus: number;
	disableUpdatePerpBidAskTwap: number;
	/** bitmask, see `UserStatsPausedOperation` */
	pausedOperations: number;
	authority: PublicKey;
	ifStakedQuoteAssetAmount: BN;
	delegatePermissions: number;
};

/** Decoded mirror of the on-chain `User` (sub-account) zero-copy account. */
export type UserAccount = {
	authority: PublicKey;
	/** address that can control the account on the authority's behalf; limited power, cannot withdraw */
	delegate: PublicKey;
	name: number[];
	subAccountId: number;
	spotPositions: SpotPosition[];
	perpPositions: PerpPosition[];
	orders: Order[];
	/** bitmask, see `UserStatus` */
	status: number;
	nextLiquidationId: number;
	nextOrderId: number;
	/** MARGIN_PRECISION (1e4); custom max initial margin ratio for the whole account, 0 = use market defaults */
	maxMarginRatio: number;
	/** fees (taker fee, maker rebate, referrer reward, filler reward) and pnl for perps, QUOTE_PRECISION (1e6) */
	settledPerpPnl: BN;
	/** QUOTE_PRECISION (1e6) */
	totalDeposits: BN;
	/** QUOTE_PRECISION (1e6) */
	totalWithdraws: BN;
	/** QUOTE_PRECISION (1e6) */
	totalSocialLoss: BN;
	/** cumulative funding paid/received across perps, QUOTE_PRECISION (1e6) */
	cumulativePerpFunding: BN;
	/** fees (taker fee, maker rebate, filler reward) for spot, QUOTE_PRECISION (1e6) */
	cumulativeSpotFees: BN;
	/** QUOTE_PRECISION (1e6); margin freed so far during an in-progress liquidation (spreads the liquidation over time); 0 when not being liquidated */
	liquidationMarginFreed: BN;
	lastActiveSlot: BN;
	isMarginTradingEnabled: boolean;
	/** true if the account hasn't interacted with the protocol in ~1 week and has no orders/positions/borrows; off-chain keepers may ignore idle accounts */
	idle: boolean;
	openOrders: number;
	hasOpenOrder: boolean;
	openAuctions: number;
	hasOpenAuction: boolean;
	poolId: number;
	/** bitmask, see `SpecialUserStatus` */
	specialUserStatus: number;
};

/** A user's balance in one spot market. Decoded mirror of the on-chain `SpotPosition`. */
export type SpotPosition = {
	marketIndex: number;
	balanceType: SpotBalanceType;
	/** SPOT_BALANCE_PRECISION (1e9) scaled balance; multiply by the spot market's cumulative deposit/borrow interest for the token amount */
	scaledBalance: BN;
	openOrders: number;
	/** size of non-reduce-only bids resting/triggering, token mint precision */
	openBids: BN;
	/** size of non-reduce-only asks resting/triggering, token mint precision */
	openAsks: BN;
	/** cumulative deposits/borrows into this market, token mint precision */
	cumulativeDeposits: BN;
};

/** Decoded mirror of an on-chain `Order` slot inside `UserAccount.orders`. */
export type Order = {
	status: OrderStatus;
	orderType: OrderType;
	marketType: MarketType;
	slot: BN;
	orderId: number;
	userOrderId: number;
	marketIndex: number;
	/** the limit price; can be 0 for market orders. For orders with an auction, unused until the auction completes. PRICE_PRECISION (1e6) */
	price: BN;
	/** perp: BASE_PRECISION (1e9); spot: token mint precision */
	baseAssetAmount: BN;
	/** perp: BASE_PRECISION (1e9); spot: token mint precision */
	baseAssetAmountFilled: BN;
	/** QUOTE_PRECISION (1e6) */
	quoteAssetAmountFilled: BN;
	direction: PositionDirection;
	reduceOnly: boolean;
	/** price at which the order becomes active; only relevant for trigger orders, PRICE_PRECISION (1e6) */
	triggerPrice: BN;
	triggerCondition: OrderTriggerCondition;
	/** the user's position direction when this order was placed */
	existingPositionDirection: PositionDirection;
	postOnly: boolean;
	/** must be canceled the same slot it's placed if not fully filled */
	immediateOrCancel: boolean;
	/** if set, the limit price is `oraclePrice + oraclePriceOffset`; PRICE_PRECISION (1e6), signed */
	oraclePriceOffset: BN;
	/** slots the auction lasts; only relevant for market/oracle orders */
	auctionDuration: number;
	/** PRICE_PRECISION (1e6), signed; only relevant for market/oracle orders */
	auctionStartPrice: BN;
	/** PRICE_PRECISION (1e6), signed; only relevant for market/oracle orders */
	auctionEndPrice: BN;
	/** unix timestamp after which the order expires */
	maxTs: BN;
	/** bitmask, see `OrderBitFlag` */
	bitFlags: number;
	/** low 8 bits of the slot the order was posted on-chain (not the order's `slot` field for signed-msg orders) */
	postedSlotTail: number;
};

/** Instruction-parameter shape for placing an order (perp or spot). Optional fields default to `null`/unset on-chain unless noted. */
export type OrderParams = {
	orderType: OrderType;
	marketType: MarketType;
	userOrderId: number;
	direction: PositionDirection;
	/** perp: BASE_PRECISION (1e9); spot: token mint precision */
	baseAssetAmount: BN;
	/** limit price, PRICE_PRECISION (1e6); 0 for market orders */
	price: BN;
	marketIndex: number;
	reduceOnly: boolean;
	postOnly: PostOnlyParams;
	/** bitmask, see `OrderParamsBitFlag` (distinct from the on-chain `Order.bitFlags` set of flags) */
	bitFlags: number;
	/** PRICE_PRECISION (1e6); only used for trigger orders */
	triggerPrice: BN | null;
	triggerCondition: OrderTriggerCondition;
	/** signed offset from the oracle price, PRICE_PRECISION (1e6); when set, the order's effective limit price tracks the oracle */
	oraclePriceOffset: BN | null;
	/** slots; only used for market/oracle orders */
	auctionDuration: number | null;
	/** unix timestamp after which the order expires */
	maxTs: BN | null;
	/** PRICE_PRECISION (1e6) or oracle-offset units depending on the order, signed; only used for market/oracle orders */
	auctionStartPrice: BN | null;
	/** PRICE_PRECISION (1e6) or oracle-offset units depending on the order, signed; only used for market/oracle orders */
	auctionEndPrice: BN | null;
	/** index into the placing user's RevenueShareEscrow.approved_builders list (non-swift builder codes) */
	builderIdx?: number | null;
	/** builder fee on this order, in tenths of a bps, e.g. 100 = 0.01% */
	builderFeeTenthBps?: number | null;
};

/** Whether/how an order must avoid taking liquidity. `MUST_POST_ONLY` reverts the transaction if the order would cross; `TRY_POST_ONLY` silently drops the order instead of reverting; `SLIDE` adjusts the price to make it post-only. */
export class PostOnlyParams {
	static readonly NONE = { none: {} };
	static readonly MUST_POST_ONLY = { mustPostOnly: {} }; // Tx fails if order can't be post only
	static readonly TRY_POST_ONLY = { tryPostOnly: {} }; // Tx succeeds and order not placed if can't be post only
	static readonly SLIDE = { slide: {} }; // Modify price to be post only if can't be post only
}

/**
 * How to distribute order sizes across scale orders
 */
export class SizeDistribution {
	static readonly FLAT = { flat: {} }; // Equal size for all orders
	static readonly ASCENDING = { ascending: {} }; // Smallest at start price, largest at end price
	static readonly DESCENDING = { descending: {} }; // Largest at start price, smallest at end price
}

/**
 * Parameters for placing scale orders - multiple limit orders distributed across a price range
 */
export type ScaleOrderParams = {
	marketType: MarketType;
	direction: PositionDirection;
	marketIndex: number;
	/** Total base asset amount to distribute across all orders */
	totalBaseAssetAmount: BN;
	/** Starting price for the scale (in PRICE_PRECISION) */
	startPrice: BN;
	/** Ending price for the scale (in PRICE_PRECISION) */
	endPrice: BN;
	/** Number of orders to place (min 2, max 32). User cannot exceed 32 total open orders. */
	orderCount: number;
	/** How to distribute sizes across orders */
	sizeDistribution: SizeDistribution;
	/** Whether orders should be reduce-only */
	reduceOnly: boolean;
	/** Post-only setting for all orders */
	postOnly: PostOnlyParams;
	/** Bit flags (e.g., for high leverage mode) */
	bitFlags: number;
	/** Maximum timestamp for orders to be valid */
	maxTs: BN | null;
};

/** Bitmask mirror of `OrderParams.bitFlags` (the instruction-parameter flag set; distinct from the on-chain `Order.bitFlags` set of `OrderBitFlag`). */
export class OrderParamsBitFlag {
	static readonly ImmediateOrCancel = 1;
}

/** Bitmask mirror of `PerpPosition.positionFlag`. Multiple bits can be set (e.g. an isolated position mid-liquidation has both `IsolatedPosition` and `BeingLiquidated`). */
export class PositionFlag {
	static readonly IsolatedPosition = 1;
	static readonly BeingLiquidated = 2;
	static readonly Bankruptcy = 4;
}

/** The subset of `OrderParams` an SDK caller must always supply; everything else can be defaulted. */
export type NecessaryOrderParams = {
	orderType: OrderType;
	marketIndex: number;
	baseAssetAmount: BN;
	direction: PositionDirection;
};

/** `OrderParams` with every field optional except `NecessaryOrderParams`; SDK order-placement helpers fill in the rest from `DefaultOrderParams`. */
export type OptionalOrderParams = {
	[Property in keyof OrderParams]?: OrderParams[Property];
} & NecessaryOrderParams;

/** Fields to change on an existing order via `modifyOrder`. Only the fields present (non-`undefined`) are changed on-chain; the rest of the order is left as-is. `null` explicitly clears an optional on-chain field (e.g. `triggerPrice: null` removes the trigger). */
export type ModifyOrderParams = {
	[Property in keyof OrderParams]?: OrderParams[Property] | null;
} & { policy?: ModifyOrderPolicy | null };

/** Bitmask passed as `ModifyOrderParams.policy` (combine with `|`). `MustModify`: fail the instruction instead of silently no-op'ing if the target order id can't be found. `ExcludePreviousFill`: when a new `baseAssetAmount` is given, treat it as the new *remaining* size — the already-filled amount is subtracted off it (rather than replacing the order's total size outright). */
export enum ModifyOrderPolicy {
	MustModify = 1,
	ExcludePreviousFill = 2,
}

/** Base `OrderParams` (a market perp long of size 0) that SDK order-building helpers spread their caller-supplied `OptionalOrderParams` over. */
export const DefaultOrderParams: OrderParams = {
	orderType: OrderType.MARKET,
	marketType: MarketType.PERP,
	userOrderId: 0,
	direction: PositionDirection.LONG,
	baseAssetAmount: ZERO,
	price: ZERO,
	marketIndex: 0,
	reduceOnly: false,
	postOnly: PostOnlyParams.NONE,
	bitFlags: 0,
	triggerPrice: null,
	triggerCondition: OrderTriggerCondition.ABOVE,
	oraclePriceOffset: null,
	auctionDuration: null,
	maxTs: null,
	auctionStartPrice: null,
	auctionEndPrice: null,
	builderIdx: null,
	builderFeeTenthBps: null,
};

/** The payload signed off-chain by a user (non-delegated) for a swift/signed-msg order, optionally bundling bracket TP/SL orders and an isolated-margin deposit. */
export type SignedMsgOrderParamsMessage = {
	signedMsgOrderParams: OrderParams;
	subAccountId: number;
	/** slot the message was signed at; combined with `signedMsgOrderMaxSlot`-style checks to bound message validity */
	slot: BN;
	uuid: Uint8Array;
	takeProfitOrderParams: SignedMsgTriggerOrderParams | null;
	stopLossOrderParams: SignedMsgTriggerOrderParams | null;
	/** MARGIN_PRECISION (1e4); custom max margin ratio applied to the resulting position, if any */
	maxMarginRatio?: number | null;
	builderIdx?: number | null;
	/** builder fee on this order, in tenths of a bps, e.g. 100 = 0.01% */
	builderFeeTenthBps?: number | null;
	/** if set, deposits this amount (spot market token-mint precision) into a new isolated-margin position when placing the order */
	isolatedPositionDeposit?: BN | null;
};

/** Same as `SignedMsgOrderParamsMessage`, but signed by a delegate on the taker's behalf; carries `takerPubkey` explicitly since the signer isn't the taker's own authority. */
export type SignedMsgOrderParamsDelegateMessage = {
	signedMsgOrderParams: OrderParams;
	slot: BN;
	uuid: Uint8Array;
	takerPubkey: PublicKey;
	takeProfitOrderParams: SignedMsgTriggerOrderParams | null;
	stopLossOrderParams: SignedMsgTriggerOrderParams | null;
	maxMarginRatio?: number | null;
	builderIdx?: number | null;
	builderFeeTenthBps?: number | null;
	isolatedPositionDeposit?: BN | null;
};

/** A bracket take-profit/stop-loss order attached to a signed-msg order message. */
export type SignedMsgTriggerOrderParams = {
	/** PRICE_PRECISION (1e6) */
	triggerPrice: BN;
	/** perp: BASE_PRECISION (1e9); spot: token mint precision */
	baseAssetAmount: BN;
};

/** Identifies a resting maker order/account to pass into a fill instruction's remaining accounts. `order` may be omitted when the whole account (not one specific order) is being matched against, e.g. AMM-JIT. */
export type MakerInfo = {
	maker: PublicKey;
	makerStats: PublicKey;
	makerUserAccount: UserAccount;
	order?: Order;
};

/** Identifies the taker order/account being filled, for fill instructions. */
export type TakerInfo = {
	taker: PublicKey;
	takerStats: PublicKey;
	takerUserAccount: UserAccount;
	order: Order;
};

/** Referrer accounts to pass into an instruction so the referrer's reward can be credited. */
export type ReferrerInfo = {
	referrer: PublicKey;
	referrerStats: PublicKey;
};

/** Bitmask mirror of `UserStatsAccount.referrerStatus`. */
export enum ReferrerStatus {
	IsReferrer = 1,
	IsReferred = 2,
	/** set when the user's RevenueShareEscrow was initialized with a referrer */
	BuilderReferral = 4,
}

/** Which fill outcome counts as "success" for a `placeAndTake*` instruction's on-chain success check. */
export enum PlaceAndTakeOrderSuccessCondition {
	PartialFill = 1,
	FullFill = 2,
}

type ExactType<T> = Pick<T, keyof T>;

/** Compute-budget overrides accepted by SDK transaction-building helpers. Omit either field to let the SDK compute/skip it. */
export type BaseTxParams = ExactType<{
	/** explicit compute-unit limit to request; if omitted, may be derived via simulation (see `ProcessingTxParams`) */
	computeUnits?: number;
	/** micro-lamports per compute unit for the priority fee */
	computeUnitsPrice?: number;
}>;

/** Controls how the SDK derives compute-unit limit/price when not explicitly given in `BaseTxParams`. */
export type ProcessingTxParams = {
	/** simulate the transaction to determine the compute-unit limit instead of using a static estimate */
	useSimulatedComputeUnits?: boolean;
	/** multiplier applied to the simulated/estimated compute-unit count to leave headroom, e.g. 1.2 = +20% */
	computeUnitsBufferMultiplier?: number;
	/** also use the simulated compute-unit count (rather than the static estimate) as the basis for `getCUPriceFromComputeUnits` */
	useSimulatedComputeUnitsForCUPriceCalculation?: boolean;
	/** custom function mapping a compute-unit count to a compute-unit price (micro-lamports); overrides `computeUnitsPrice` */
	getCUPriceFromComputeUnits?: (computeUnits: number) => number;
	/** floor applied to the computed/simulated compute-unit count before requesting a limit */
	lowerBoundCu?: number;
};

/** Combined compute-budget + compute-unit-derivation options accepted by SDK transaction-building helpers. */
export type TxParams = BaseTxParams & ProcessingTxParams;

/** For `beginSwap`/`endSwap`, whether the reduce-only constraint applies to the `In` (source) or `Out` (destination) side of the swap. */
export class SwapReduceOnly {
	static readonly In = { in: {} };
	static readonly Out = { out: {} };
}

// # Misc Types
/** Minimal wallet adapter the SDK requires for legacy (non-versioned) transaction signing. */
export interface IWallet {
	signTransaction(tx: Transaction): Promise<Transaction>;
	signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
	publicKey: PublicKey;
	payer?: Keypair;
	supportedTransactionVersions?:
		| ReadonlySet<TransactionVersion>
		| null
		| undefined;
}
/** Wallet adapter capable of signing versioned transactions (v0 message format). */
export interface IVersionedWallet {
	signVersionedTransaction(
		tx: VersionedTransaction
	): Promise<VersionedTransaction>;
	signAllVersionedTransactions(
		txs: VersionedTransaction[]
	): Promise<VersionedTransaction[]>;
	publicKey: PublicKey;
	payer?: Keypair;
}

/** `IWallet` extended with arbitrary-message signing (used for signed-msg/swift order flows). */
export interface IWalletV2 extends IWallet {
	signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** The fee schedule applied to fills in a market category (perp or spot); decoded from `StateAccount.perpFeeStructure`/`spotFeeStructure`. */
export type FeeStructure = {
	/** volume-based fee tiers, evaluated by the taker's 30-day volume; tier 0 is the base/default tier */
	feeTiers: FeeTier[];
	fillerRewardStructure: OrderFillerRewardStructure;
	/** flat portion of the filler (keeper) reward, QUOTE_PRECISION (1e6) */
	flatFillerFee: BN;
	/** FEE_PERCENTAGE_DENOMINATOR (100)-denominated share of the trade-fee remainder provisioned to the AMM as its backstop-of-last-resort tranche; `ammFeeNumerator + ifFeeNumerator` must be <= 100, the protocol keeps the residual */
	ammFeeNumerator: number;
	/** FEE_PERCENTAGE_DENOMINATOR (100)-denominated share of the trade-fee remainder routed to the insurance fund */
	ifFeeNumerator: number;
};

/** One volume tier of a `FeeStructure`. All `*Numerator`/`*Denominator` pairs form a fraction (e.g. `feeNumerator / feeDenominator`). */
export type FeeTier = {
	/** taker fee rate */
	feeNumerator: number;
	feeDenominator: number;
	/** rebate paid to the resting maker */
	makerRebateNumerator: number;
	makerRebateDenominator: number;
	/** share of the taker fee credited to the taker's referrer */
	referrerRewardNumerator: number;
	referrerRewardDenominator: number;
	/** discount applied to the taker's own fee when they were referred */
	refereeFeeNumerator: number;
	refereeFeeDenominator: number;
};

/** The reward paid to the keeper (filler) that submits a fill transaction. */
export type OrderFillerRewardStructure = {
	/** share of the fill's fee/size paid as a variable reward */
	rewardNumerator: number;
	rewardDenominator: number;
	/** QUOTE_PRECISION (1e6); floor below which the time-based reward component doesn't apply */
	timeBasedRewardLowerBound: BN;
};

/** Protocol-wide oracle safety thresholds (`StateAccount.oracleGuardRails`), gating how far an oracle price may diverge from mark and how stale/uncertain it may be before it's rejected for a given action. */
export type OracleGuardRails = {
	priceDivergence: {
		/** PERCENTAGE_PRECISION (1e6); max allowed |mark − oracle| / oracle before divergence checks reject the price */
		markOraclePercentDivergence: BN;
		/** PERCENTAGE_PRECISION (1e6); max allowed divergence between the oracle's live price and its 5-minute TWAP */
		oracleTwap5MinPercentDivergence: BN;
	};
	validity: {
		/** slots; oracle updates older than this are stale for AMM-facing actions */
		slotsBeforeStaleForAmm: BN;
		/** slots; oracle updates older than this are stale for margin/liquidation actions */
		slotsBeforeStaleForMargin: BN;
		/** PERCENTAGE_PRECISION (1e6)-scaled fraction of price; oracle confidence intervals wider than this are rejected */
		confidenceIntervalMaxSize: BN;
		/** oracle price moves within one update exceeding this multiple of the recent range are rejected as "too volatile" */
		tooVolatileRatio: BN;
	};
};

/** Result of the oracle validity check (`is_oracle_valid_for_action` and friends). Only `Valid` (7) permits using the price; every other variant identifies the specific failure so callers can gate accordingly (stale-for-margin still permits AMM-only actions, etc.). */
export enum OracleValidity {
	NonPositive = 0,
	TooVolatile = 1,
	TooUncertain = 2,
	StaleForMargin = 3,
	InsufficientDataPoints = 4,
	StaleForAMMLowRisk = 5,
	isStaleForAmmImmediate = 6,
	Valid = 7,
}

/** Decoded mirror of a `PrelaunchOracle` account — an admin-fed synthetic price feed used before a market has a real external oracle (`OracleSource.Prelaunch`). */
export type PrelaunchOracle = {
	/** PRICE_PRECISION (1e6) */
	price: BN;
	/** PRICE_PRECISION (1e6); ceiling the admin-set price is clamped to */
	maxPrice: BN;
	/** PRICE_PRECISION (1e6) */
	confidence: BN;
	ammLastUpdateSlot: BN;
	lastUpdateSlot: BN;
	perpMarketIndex: number;
};

/** Admin instruction params for updating a `PrelaunchOracle`; `null` fields leave the current on-chain value unchanged. */
export type PrelaunchOracleParams = {
	perpMarketIndex: number;
	/** PRICE_PRECISION (1e6) */
	price: BN | null;
	/** PRICE_PRECISION (1e6) */
	maxPrice: BN | null;
};

/** Decoded mirror of a Pyth Lazer oracle account. `price`/`conf` are in the feed's native `exponent` (a power-of-ten scale factor, typically negative), not a fixed SDK precision — divide by `10^-exponent` to get the human-readable price. */
export type PythLazerOracle = {
	price: BN;
	publishTime: BN;
	postedSlot: BN;
	exponent: number;
	conf: BN;
};

/** Admin instruction params for correcting a perp market's cached AMM summary stats; `null` fields leave the current on-chain value unchanged. */
export type UpdatePerpMarketSummaryStatsParams = {
	/** QUOTE_PRECISION (1e6) */
	netUnsettledFundingPnl: BN | null;
	updateAmmSummaryStats: boolean | null;
};

/**
 * Which margin requirement a calculation is being performed for, mirroring the program's
 * `MarginRequirementType`: `'Initial'` (opening/maintaining leverage headroom), `'Maintenance'`
 * (liquidation), or `'Fill'` (fill-time check — weights/ratios are the integer-averaged midpoint
 * of initial and maintenance).
 */
export type MarginCategory = 'Initial' | 'Maintenance' | 'Fill';

/** Decoded mirror of the on-chain `InsuranceFundStake` account: one user's stake in one spot market's insurance fund. */
export type InsuranceFundStake = {
	/** signed, spot market token-mint precision; tracks the staker's cost basis for pnl reporting */
	costBasis: BN;

	marketIndex: number;
	authority: PublicKey;

	/** the staker's share count; multiply by the IF's share price to get token value */
	ifShares: BN;
	/** exponent used to rebase `ifShares` in step with `InsuranceFund.sharesBase` */
	ifBase: BN;
	lastValidTs: BN;

	lastWithdrawRequestShares: BN;
	/** spot market token-mint precision value of `lastWithdrawRequestShares` at request time */
	lastWithdrawRequestValue: BN;
	lastWithdrawRequestTs: BN;
};

/** Decoded mirror of a `ReferrerName` account, mapping a human-readable referrer name to its user/authority. */
export type ReferrerNameAccount = {
	name: number[];
	user: PublicKey;
	authority: PublicKey;
	userStats: PublicKey;
};

/** SDK-computed convenience summary of a perp market's order-size/margin/insurance limits, derived from `PerpMarketAccount` (not decoded directly from a single on-chain field). */
export type PerpMarketExtendedInfo = {
	marketIndex: number;
	/**
	 * Min order size measured in base asset, using base precision
	 */
	minOrderSize: BN;
	/**
	 * Margin maintenance percentage, using margin precision (1e4)
	 */
	marginMaintenance: number;
	/**
	 * Max insurance available, measured in quote asset, using quote preicision
	 */
	availableInsurance: BN;
	/**
	 * Pnl pool available, this is measured in quote asset, using quote precision.
	 * Should be generated by using getTokenAmount and passing in the scaled balance of the base asset + quote spot account
	 */
	pnlPoolValue: BN;
	contractTier: ContractTier;
};

/** SDK-computed breakdown of a user's margin-health calculation, grouped by contribution type; each group is a list of the individual `HealthComponent`s that summed into the account's total collateral/margin requirement. */
export type HealthComponents = {
	deposits: HealthComponent[];
	borrows: HealthComponent[];
	perpPositions: HealthComponent[];
	perpPnl: HealthComponent[];
};

/** One market's contribution to a `HealthComponents` group. */
export type HealthComponent = {
	marketIndex: number;
	/** perp: signed BASE_PRECISION (1e9) position size; spot: signed token-mint-precision balance */
	size: BN;
	/** unweighted USD value, QUOTE_PRECISION (1e6) */
	value: BN;
	/** the asset/liability weight applied, SPOT_WEIGHT_PRECISION or MARGIN_PRECISION (1e4) depending on component type */
	weight: BN;
	/** `value` after applying `weight`, QUOTE_PRECISION (1e6); this is what's actually summed into total collateral/margin requirement */
	weightedValue: BN;
};

/** Event map for `VelocityClient`'s internal metrics emitter. */
export interface VelocityClientMetricsEvents {
	txSigned: SignedTxData[];
	preTxSigned: void;
}

/** A transaction the SDK has signed, returned by transaction-sending helpers before/instead of submission. */
export type SignedTxData = {
	txSig: string;
	signedTx: Transaction | VersionedTransaction;
	lastValidBlockHeight?: number;
	blockHash: string;
};

/** Proof of a signed-msg (swift) taker order, submitted to the program to fill it. */
export interface SignedMsgOrderParams {
	/**
	 * The encoded order params that were signed (borsh encoded then hexified).
	 */
	orderParams: Buffer;
	/**
	 * The signature generated for the orderParams
	 */
	signature: Buffer;
}

/** One slot of a `SignedMsgUserOrdersAccount`, recording a signed-msg order's validity window and dedupe key so a replayed/expired signed message can be rejected without an extra RPC round-trip. */
export type SignedMsgOrderId = {
	/** slot after which this signed message is no longer eligible to be placed */
	maxSlot: BN;
	uuid: Uint8Array;
	orderId: number;
};

/** Per-authority account tracking recently-seen signed-msg order UUIDs, used to detect replay/duplicate submission of the same signed message. */
export type SignedMsgUserOrdersAccount = {
	authorityPubkey: PublicKey;
	signedMsgOrderData: SignedMsgOrderId[];
};

/** Account listing the delegate keys authorized to submit signed-msg orders over the swift websocket on a user's behalf. */
export type SignedMsgWsDelegatesAccount = {
	delegates: PublicKey[];
};

/** Decoded mirror of the on-chain `RevenueShare` account: one per builder/referrer, accumulating their lifetime rewards. */
export type RevenueShareAccount = {
	/** the builder or referrer that owns this account */
	authority: PublicKey;
	/** QUOTE_PRECISION (1e6) */
	totalReferrerRewards: BN;
	/** QUOTE_PRECISION (1e6) */
	totalBuilderRewards: BN;
	padding: number[];
};

/** Decoded mirror of the on-chain `RevenueShareEscrow` account: one per trading user, holding their referrer link, approved builder codes, and in-flight per-order fee accruals awaiting settlement. Required in remaining accounts when filling an order with a builder code or a referred taker (see `TakerInfo`/fill-instruction docs). */
export type RevenueShareEscrowAccount = {
	/** the user that owns this escrow */
	authority: PublicKey;
	referrer: PublicKey;
	reservedFixed: number[];
	/** ring-buffer of in-flight order fee accruals, settled into the builder's/referrer's `RevenueShareAccount` on settle-PnL */
	orders: RevenueShareOrder[];
	/** builders this user has approved to charge a fee, indexed by `builderIdx` on `OrderParams`/`RevenueShareOrder` */
	approvedBuilders: BuilderInfo[];
};

/** One in-flight order's accrued builder/referral fee inside a `RevenueShareEscrowAccount`. */
export type RevenueShareOrder = {
	/** QUOTE_PRECISION (1e6); accrued so far for this slot — may include fees from other orders that reused the same slot, not exclusively `orderId` */
	feesAccrued: BN;
	/** the currently-active order's id in this slot; only meaningful while the slot is open */
	orderId: number;
	/** builder fee on this order, in tenths of a bps, e.g. 100 = 0.01% */
	feeTenthBps: number;
	marketIndex: number;
	/** only meaningful while the slot is open */
	subAccountId: number;
	/** index into `RevenueShareEscrowAccount.approvedBuilders` this order's fee settles to; ignored for a referral-only slot */
	builderIdx: number;
	/** bitflags describing slot state (init/open/completed) and whether it holds referral rewards rather than a builder fee */
	bitFlags: number;
	userOrderIndex: number;
	marketType: MarketType;
	padding: number[];
};

/** One builder a user has approved to charge a fee on their orders, inside `RevenueShareEscrowAccount.approvedBuilders`. */
export type BuilderInfo = {
	/** the builder's authority */
	authority: PublicKey;
	/** ceiling on the fee (tenths of a bps) this builder may charge; `0` means the approval has been revoked */
	maxFeeTenthBps: number;
	padding: number[];
};

/** Emitted when a perp market's fee-ledger pendings are swept into their durable homes (protocol fee pool, quote market revenue pool, AMM fee pool). */
export type PerpMarketFeeSweepRecord = {
	ts: BN;
	marketIndex: number;
	/** pending insurance cut moved to the quote spot market's revenue pool, QUOTE_PRECISION (1e6) */
	ifSwept: BN;
	/** pending protocol cut moved to the market's protocol fee pool, QUOTE_PRECISION (1e6) */
	protocolSwept: BN;
	/** AMM fee provision (booked at fill) tokenized into `AMM.feePool`, QUOTE_PRECISION (1e6) */
	ammProvisionTokenized: BN;
};

/** Emitted when `coldAdmin` withdraws accumulated protocol fees to the configured recipient. */
export type ProtocolFeeWithdrawRecord = {
	ts: BN;
	/** perp market index for a perp-fee withdrawal, else the spot market index */
	marketIndex: number;
	/** true if this withdrawal drained a perp market's `protocolFeePool` (sourced from the quote spot vault); false for a spot market withdrawal */
	isPerp: boolean;
	/** the spot market the tokens were drawn from */
	spotMarketIndex: number;
	/** spot market token-mint precision */
	amount: BN;
	recipientTokenAccount: PublicKey;
};

/** Emitted when a builder's/referrer's accrued `RevenueShareOrder` fees are settled into their `RevenueShareAccount`. */
export type RevenueShareSettleRecord = {
	ts: BN;
	/** set when this settle paid a builder fee */
	builder: PublicKey | null;
	/** set when this settle paid a referral reward */
	referrer: PublicKey | null;
	/** QUOTE_PRECISION (1e6) */
	feeSettled: BN;
	marketIndex: number;
	marketType: MarketType;
	/** the builder's `RevenueShareAccount.totalReferrerRewards` after this settle, QUOTE_PRECISION (1e6) */
	builderTotalReferrerRewards: BN;
	/** the builder's `RevenueShareAccount.totalBuilderRewards` after this settle, QUOTE_PRECISION (1e6) */
	builderTotalBuilderRewards: BN;
	builderSubAccountId: number;
};

/** Admin instruction params to add one constituent's weight in a perp market's AMM constituent mapping (used to route hedge flow). */
export type AddAmmConstituentMappingDatum = {
	constituentIndex: number;
	perpMarketIndex: number;
	/** PERCENTAGE_PRECISION (1e6) */
	weight: BN;
};

/** One entry of an `AmmConstituentMapping`, weighting how much of a perp market's hedge flow routes to a given LP-pool constituent. */
export type AmmConstituentDatum = AddAmmConstituentMappingDatum & {
	lastSlot: BN;
};

/** Decoded mirror of the `AmmConstituentMapping` account: which LP-pool constituents each perp market hedges into, and by how much. */
export type AmmConstituentMapping = {
	lpPool: PublicKey;
	bump: number;
	weights: AmmConstituentDatum[];
};

/** One perp market's target-hedge-position entry inside a `ConstituentTargetBaseAccount`. */
export type TargetDatum = {
	/** bps; estimated cost to trade into/out of the target position */
	costToTradeBps: number;
	lastOracleSlot: BN;
	lastPositionSlot: BN;
	/** BASE_PRECISION (1e9); the target hedge position size */
	targetBase: BN;
};

/** Decoded mirror of the `ConstituentTargetBase` account: the LP pool's per-perp-market target hedge positions. */
export type ConstituentTargetBaseAccount = {
	lpPool: PublicKey;
	bump: number;
	targets: TargetDatum[];
};

/** Decoded mirror of the `ConstituentCorrelations` account: pairwise correlation coefficients between an LP pool's constituents, used in swap-fee pricing. */
export type ConstituentCorrelations = {
	lpPool: PublicKey;
	bump: number;
	/** PERCENTAGE_PRECISION (1e6), signed; flattened row-major correlation matrix */
	correlations: BN[];
};

/** Decoded mirror of the on-chain `LPPool` account: a hedging vault that mints/redeems LP tokens against a basket of spot-market constituents and hedges perp-market exposure. */
export type LPPoolAccount = {
	lpPoolId: number;
	pubkey: PublicKey;
	/** the LP token mint */
	mint: PublicKey;
	whitelistMint: PublicKey;
	constituentTargetBase: PublicKey;
	constituentCorrelations: PublicKey;
	/** QUOTE_PRECISION (1e6); mint requests that would push AUM above this are rejected */
	maxAum: BN;
	/** QUOTE_PRECISION (1e6); AUM of the vault in USD, updated lazily */
	lastAum: BN;
	/** QUOTE_PRECISION (1e6) */
	cumulativeQuoteSentToPerpMarkets: BN;
	/** QUOTE_PRECISION (1e6) */
	cumulativeQuoteReceivedFromPerpMarkets: BN;
	/** signed, QUOTE_PRECISION (1e6); total fees paid for minting and redeeming LP tokens */
	totalMintRedeemFeesPaid: BN;
	lastAumSlot: BN;
	/** token-mint precision cap on a single settle's quote transfer */
	maxSettleQuoteAmount: BN;
	mintRedeemId: BN;
	settleId: BN;
	/** PERCENTAGE_PRECISION (1e6); floor fee charged on mint/redeem */
	minMintFee: BN;
	/** LP token precision; the LP mint's total supply */
	tokenSupply: BN;
	/** PERCENTAGE_PRECISION (1e6); pool-wide volatility parameter feeding swap-fee/target pricing */
	volatility: BN;
	constituents: number;
	quoteConsituentIndex: number;
	bump: number;
	/** no precision — a raw constant used in swap-fee execution-cost pricing */
	gammaExecution: number;
	/** no precision — a raw constant used in swap-fee pricing */
	xi: number;
	/** bps of fee per 10 slots of oracle-target delay */
	targetOracleDelayFeeBpsPer10Slots: number;
	/** bps of fee per 10 slots of position-target delay */
	targetPositionDelayFeeBpsPer10Slots: number;
};

/** A constituent's spot-market balance inside an LP pool (parallel to `PoolBalance` but tracking cumulative deposits too). */
export type ConstituentSpotBalance = {
	/** SPOT_BALANCE_PRECISION (1e9) scaled balance */
	scaledBalance: BN;
	/** token mint precision */
	cumulativeDeposits: BN;
	marketIndex: number;
	balanceType: SpotBalanceType;
};

/** Admin instruction params for `initializeConstituent`, configuring a new LP-pool spot-market constituent. */
export type InitializeConstituentParams = {
	spotMarketIndex: number;
	decimals: number;
	/** PERCENTAGE_PRECISION (1e6); max allowed deviation from target weight before rebalance pressure kicks in */
	maxWeightDeviation: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	swapFeeMin: BN;
	/** PERCENTAGE_PRECISION (1e6) */
	swapFeeMax: BN;
	/** token mint precision; borrow cap for this constituent */
	maxBorrowTokenAmount: BN;
	/** slots; oracle updates older than this are treated as stale for this constituent */
	oracleStalenessThreshold: BN;
	/** bps; estimated cost to trade this constituent */
	costToTrade: number;
	/** PERCENTAGE_PRECISION (1e6); weight applied when this constituent derives its price from another constituent */
	derivativeWeight: BN;
	constituentDerivativeIndex?: number;
	/** PERCENTAGE_PRECISION (1e6); max allowed depeg from the derivative reference before the constituent is treated as broken */
	constituentDerivativeDepegThreshold?: BN;
	/** PERCENTAGE_PRECISION (1e6), signed; this constituent's correlation with every other constituent */
	constituentCorrelations: BN[];
	/** PERCENTAGE_PRECISION (1e6) */
	volatility: BN;
	gammaExecution?: number;
	gammaInventory?: number;
	xi?: number;
};

/** Lifecycle status of an LP-pool `ConstituentAccount`. */
export enum ConstituentStatus {
	ACTIVE = 0,
	/** may only shrink toward its target weight, not grow */
	REDUCE_ONLY = 1,
	DECOMMISSIONED = 2,
}
/** Bitmask mirror of `ConstituentAccount.pausedOperations`, gating which LP-pool operations a constituent allows. */
export enum ConstituentLpOperation {
	Swap = 0b00000001,
	Deposit = 0b00000010,
	Withdraw = 0b00000100,
}

/** Decoded mirror of the on-chain `Constituent` account: one spot-market asset inside an LP pool's basket. */
export type ConstituentAccount = {
	pubkey: PublicKey;
	mint: PublicKey;
	lpPool: PublicKey;
	vault: PublicKey;
	/** signed, positive = fees received, negative = fees paid; PERCENTAGE_PRECISION-derived token units */
	totalSwapFees: BN;
	spotBalance: ConstituentSpotBalance;
	/** token mint precision */
	lastSpotBalanceTokenAmount: BN;
	/** token mint precision */
	cumulativeSpotInterestAccruedTokenAmount: BN;
	/** PERCENTAGE_PRECISION (1e6); max allowed deviation from target weight */
	maxWeightDeviation: BN;
	/** PERCENTAGE_PRECISION (1e6); min fee charged on swaps to/from this constituent */
	swapFeeMin: BN;
	/** PERCENTAGE_PRECISION (1e6); max fee charged on swaps to/from this constituent */
	swapFeeMax: BN;
	/** token mint precision */
	maxBorrowTokenAmount: BN;
	/** token mint precision; the vault's actual token account balance */
	vaultTokenBalance: BN;
	lastOraclePrice: BN;
	lastOracleSlot: BN;
	/** slots; delay allowed for a valid AUM calculation before this constituent's price is considered stale */
	oracleStalenessThreshold: BN;
	/** token mint precision; user's token balance snapshotted at `beginSwap`-style flash accounting */
	flashLoanInitialTokenAmount: BN;
	nextSwapId: BN;
	/** PERCENTAGE_PRECISION (1e6); share of derivative weight routed to this constituent specifically; 0 if this constituent has no derivative weight */
	derivativeWeight: BN;
	/** PERCENTAGE_PRECISION (1e6); 1 = 1% */
	volatility: BN;
	/** PERCENTAGE_PRECISION (1e6); max allowed depeg from the parent constituent before this derivative is treated as broken */
	constituentDerivativeDepegThreshold: BN;
	/** the parent constituent's index if this is a derivative (e.g. dSOL -> SOL); -1 if this constituent is itself a parent */
	constituentDerivativeIndex: number;
	spotMarketIndex: number;
	constituentIndex: number;
	decimals: number;
	bump: number;
	vaultBump: number;
	/** no precision — raw constant used in swap-fee inventory-skew pricing */
	gammaInventory: number;
	/** no precision — raw constant used in swap-fee execution-cost pricing */
	gammaExecution: number;
	/** no precision — raw constant used in swap-fee pricing */
	xi: number;
	/** see `ConstituentStatus` */
	status: number;
	/** bitmask, see `ConstituentLpOperation` */
	pausedOperations: number;
};

/** One perp market's cached AMM/settlement snapshot inside an `AmmCache`, refreshed by the keeper crank so LP-pool settlement doesn't need to reload the full `PerpMarketAccount`. */
export type CacheInfo = {
	oracle: PublicKey;
	lastFeePoolTokenAmount: BN;
	/** signed */
	lastNetPnlPoolTokenAmount: BN;
	lastExchangeFees: BN;
	lastSettleAmmExFees: BN;
	/** signed */
	lastSettleAmmPnl: BN;
	/** BASE_PRECISION (1e9), signed; the AMM's net position at last cache update */
	position: BN;
	slot: BN;
	lastSettleAmount: BN;
	lastSettleSlot: BN;
	lastSettleTs: BN;
	/** signed; quote owed from the LP pool to this market (or vice versa if negative) */
	quoteOwedFromLpPool: BN;
	/** signed; cap on the AMM's hedgeable inventory */
	ammInventoryLimit: BN;
	/** PRICE_PRECISION (1e6), signed */
	oraclePrice: BN;
	oracleSlot: BN;
	/** numeric `OracleSourceNum` discriminant */
	oracleSource: number;
	/** `OracleValidity` discriminant at last cache update */
	oracleValidity: number;
	lpStatusForPerpMarket: number;
	ammPositionScalar: number;
	marketIndex: number;
};

/** Decoded mirror of the on-chain `AmmCache` account: one `CacheInfo` per perp market, indexed by `marketIndex`. */
export type AmmCache = {
	bump: number;
	cache: CacheInfo[];
};

/** SDK-computed result of checking whether a user account can currently be liquidated. */
export type AccountLiquidatableStatus = {
	canBeLiquidated: boolean;
	/** QUOTE_PRECISION (1e6); the maintenance margin requirement compared against */
	marginRequirement: BN;
	/** signed, QUOTE_PRECISION (1e6) */
	totalCollateral: BN;
};

/** Direction of an admin `transferFeeAndPnlPool` action, moving funds between a perp market's protocol fee pool and its pnl pool. */
export class TransferFeeAndPnlPoolDirection {
	static readonly FEE_TO_PNL_POOL = { feeToPnlPool: {} };
	static readonly PNL_TO_FEE_POOL = { pnlToFeePool: {} };
}

/** Emitted when an admin transfers funds between a perp market's fee pool and pnl pool (`transferFeeAndPnlPool`). The two market indices may refer to the same or different perp markets. */
export type TransferFeeAndPnlPoolRecord = {
	ts: BN;
	slot: BN;
	perpMarketIndexWithFeePool: number;
	perpMarketIndexWithPnlPool: number;
	direction: TransferFeeAndPnlPoolDirection;
	/** QUOTE_PRECISION (1e6) */
	amount: BN;
};
