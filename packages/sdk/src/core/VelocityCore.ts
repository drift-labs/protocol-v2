import type {
	AccountMeta,
	Connection,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';

import * as pdas from '../addresses/pda';
import * as constants from '../constants';
import { decodeUser } from '../decode/user';
import { CustomBorshCoder } from '../decode/customCoder';
import velocityIDL from '../idl/velocity.json';
import type { Velocity } from '../idl/velocity';
import type { UserAccount } from '../types';
import type { VelocityProgram } from '../config';
import { fetchAccount } from '../accounts/fetch';
import type { BN } from '@coral-xyz/anchor';
import { buildDepositInstruction } from './instructions/deposit';
import { buildWithdrawInstruction } from './instructions/withdraw';
import {
	buildCancelOrdersInstruction,
	buildPlaceOrdersInstruction,
} from './instructions/orders';
import { buildFillPerpOrderInstruction } from './instructions/fill';
import { buildTriggerOrderInstruction } from './instructions/trigger';
import { buildSettlePnlInstruction } from './instructions/settlement';
import { buildLiquidatePerpInstruction } from './instructions/liquidation';
import { buildUpdateFundingRateInstruction } from './instructions/funding';
import {
	buildCancelOrderByUserIdInstruction,
	buildCancelOrderInstruction,
	buildCancelOrdersByIdsInstruction,
	buildModifyOrderByUserIdInstruction,
	buildModifyOrderInstruction,
	buildPlaceAndMakePerpOrderInstruction,
	buildPlaceAndTakePerpOrderInstruction,
	buildPlacePerpOrderInstruction,
} from './instructions/perpOrders';
import * as remainingAccounts from './remainingAccounts';
import * as signedMsg from './signedMsg';

/**
 * Configuration passed to subscription-free `VelocityCore` helpers that need to know
 * which deployment (program id / IDL) they are building instructions against.
 */
export type VelocityCoreContext = {
	/** Velocity program id. */
	programId: PublicKey;

	/** Anchor IDL json for Velocity (defaults to bundled `idl/velocity.json`). */
	idl?: Velocity;
};

/**
 * `VelocityCore` is the subscription-free escape hatch of the SDK: a static-method
 * surface for deriving PDAs, decoding raw account buffers, building `remainingAccounts`,
 * and constructing `TransactionInstruction`s directly against a `Program<Velocity>` —
 * with no `VelocityClient` subscription, polling, or websocket state required. Every
 * method here is pure (or a single RPC call) and safe to use from a stateless backend,
 * a keeper bot, or any context where the full subscribed client is overkill.
 *
 * Transaction/instruction builders will be progressively moved here from `VelocityClient`.
 */
export class VelocityCore {
	/** Re-export of `../addresses/pda` — pure PDA derivation helpers (state, user, spot/perp market, vaults, etc). */
	static readonly pdas = pdas;

	/** Re-export of `../constants` — SDK-wide numeric precisions, market configs, and program constants. */
	static readonly constants = constants;

	/** Re-export of `./remainingAccounts` — pure builder for the oracle/market `AccountMeta[]` every trading/keeper instruction needs in `remainingAccounts`. */
	static readonly remainingAccounts = remainingAccounts;

	/** Re-export of `./signedMsg` — Borsh encode/decode helpers for Swift (signed order) message envelopes. */
	static readonly signedMsg = signedMsg;

	/** Returns the SDK's bundled Velocity Anchor IDL (`idl/velocity.json`), typed as `Velocity`. */
	static defaultIdl(): Velocity {
		return velocityIDL as unknown as Velocity;
	}

	/**
	 * Builds a `CustomBorshCoder` for the given IDL, usable to encode/decode Anchor
	 * account and type layouts without constructing a full `Program`.
	 * @param idl - IDL to build the coder from. Defaults to `VelocityCore.defaultIdl()`.
	 * @returns a coder that can (de)serialize any account/type defined in `idl`.
	 */
	static coder(idl: Velocity = VelocityCore.defaultIdl()): CustomBorshCoder {
		return new CustomBorshCoder(idl as any);
	}

	/**
	 * Decodes a raw Velocity `User` account buffer (including its 8-byte Anchor
	 * discriminator) into a `UserAccount`, without needing a `Program` or RPC call.
	 * Does not verify the discriminator — passing a buffer for a different account
	 * type will produce garbage or throw from an out-of-bounds read.
	 * @param buffer - raw on-chain account data for a `User` PDA.
	 * @returns the decoded `UserAccount`.
	 */
	static decodeUserAccount(buffer: Buffer): UserAccount {
		return decodeUser(buffer);
	}

	/**
	 * Fetches a `User` account over RPC and decodes it, with no subscription required.
	 * @param connection - RPC connection to fetch the account from.
	 * @param userAccountPublicKey - the `User` PDA's address.
	 * @returns the decoded `UserAccount`, or `null` if the account does not exist.
	 */
	static async fetchUserAccount(
		connection: Connection,
		userAccountPublicKey: PublicKey
	): Promise<UserAccount | null> {
		const data = await fetchAccount(connection, userAccountPublicKey);
		return data ? VelocityCore.decodeUserAccount(data) : null;
	}

	/**
	 * Builds a `deposit` instruction, transferring tokens from `userTokenAccount` into
	 * the protocol's `spotMarketVault` and crediting the `user` account's spot position.
	 * Any signer may fund someone else's `user` account this way (`authority` need not be
	 * `user`'s owner/delegate) — the SDK only requires `userTokenAccount` be owned by
	 * `authority`; on mainnet, deposits from a non-owner/delegate authority additionally
	 * require that authority to be on-chain-whitelisted, or the instruction throws.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.marketIndex - target spot market index.
	 * @param args.amount - deposit amount, in the spot market's mint's native token precision (e.g. 1e6 for a 6-decimal USDC-like mint) — not a fixed SDK precision.
	 * @param args.reduceOnly - if true (or if the market is reduce-only), the deposited amount is capped to the user's current borrow balance in this market so the deposit can only repay a borrow, never flip to a net deposit.
	 * @param args.state - the global `State` PDA.
	 * @param args.spotMarket - the target `SpotMarket` PDA.
	 * @param args.spotMarketVault - the spot market's token vault PDA (destination of the transfer).
	 * @param args.user - the `User` account being credited.
	 * @param args.userStats - the depositing user's `UserStats` PDA.
	 * @param args.userTokenAccount - token account the deposit is transferred from; must share a mint with `spotMarketVault` and be owned by `authority`.
	 * @param args.authority - signer authorizing the token transfer (source token account owner).
	 * @param args.tokenProgram - the SPL Token or Token-2022 program owning the mint.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for `marketIndex` (see `VelocityCore.remainingAccounts.getRemainingAccounts`), plus the deposited mint account, plus any Token-2022 transfer-hook accounts the mint requires.
	 * @returns the unsigned `deposit` `TransactionInstruction`.
	 */
	static async buildDepositInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		amount: BN;
		reduceOnly: boolean;
		state: PublicKey;
		spotMarket: PublicKey;
		spotMarketVault: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		userTokenAccount: PublicKey;
		authority: PublicKey;
		tokenProgram: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildDepositInstruction(args);
	}

	/**
	 * Builds a `withdraw` instruction, transferring tokens from the protocol's
	 * `spotMarketVault` to `userTokenAccount` and debiting (or borrowing against)
	 * the user's spot position. Unlike deposit, withdrawal requires `authority` to be
	 * the `user` account's own `authority` field (delegates cannot withdraw).
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.marketIndex - source spot market index.
	 * @param args.amount - withdrawal amount, in the spot market's mint's native token precision.
	 * @param args.reduceOnly - if true (or if the market is reduce-only), the withdrawal is capped to the user's current deposit balance in this market so it can only reduce a deposit, never open/increase a borrow.
	 * @param args.state - the global `State` PDA.
	 * @param args.spotMarket - the source `SpotMarket` PDA.
	 * @param args.spotMarketVault - the spot market's token vault PDA (source of the transfer).
	 * @param args.velocitySigner - the program's PDA signer authority (`state.signer`) used to authorize the vault-to-user CPI transfer; must equal the `state` account's recorded `signer` field or the instruction throws.
	 * @param args.user - the `User` account being debited; its `authority` must equal `args.authority`.
	 * @param args.userStats - the withdrawing user's `UserStats` PDA; its `authority` must also equal `args.authority`.
	 * @param args.userTokenAccount - token account the withdrawal is transferred to; must share a mint with `spotMarketVault`.
	 * @param args.authority - signer that must equal `user.authority` (and `userStats.authority`).
	 * @param args.tokenProgram - the SPL Token or Token-2022 program owning the mint.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for `marketIndex`, plus the withdrawn mint account, plus any Token-2022 transfer-hook accounts.
	 * @returns the unsigned `withdraw` `TransactionInstruction`.
	 */
	static async buildWithdrawInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		amount: BN;
		reduceOnly: boolean;
		state: PublicKey;
		spotMarket: PublicKey;
		spotMarketVault: PublicKey;
		velocitySigner: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		userTokenAccount: PublicKey;
		authority: PublicKey;
		tokenProgram: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildWithdrawInstruction(args);
	}

	/**
	 * Builds a `placeOrders` instruction, placing a batch of up to 32 perp and/or spot
	 * orders in one instruction. None of the orders may be immediate-or-cancel — IOC
	 * orders are only valid via `placeAndTake`/`placeAndMake` — or the instruction throws.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.formattedParams - array of `OrderParams` (see `OrderParams` in `types`): `baseAssetAmount` is BASE_PRECISION (1e9), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the `User` account the orders are placed on; `authority` must own or be a delegate of it.
	 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `place_orders` accounts (only `state`/`user`/`authority` are used).
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` covering every order's market, plus (if builder codes are enabled protocol-wide) the placing user's `RevenueShareEscrow` account when any order carries a `builderIdx`.
	 * @returns the unsigned `placeOrders` `TransactionInstruction`.
	 */
	static async buildPlaceOrdersInstruction(args: {
		program: VelocityProgram;
		formattedParams: any[];
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlaceOrdersInstruction(args);
	}

	/**
	 * Builds a `cancelOrders` instruction, cancelling every open order on `user` that
	 * matches all of the given (optional) filters. Passing `null`/`undefined` for a
	 * filter means "don't filter on this dimension" — passing all three as `null`
	 * cancels every open order.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.marketType - only cancel orders of this `MarketType` (`Perp`/`Spot`), or `null` for both.
	 * @param args.marketIndex - only cancel orders on this market index, or `null` for all markets.
	 * @param args.direction - only cancel orders with this `PositionDirection` (long/short), or `null` for both.
	 * @param args.user - the `User` account whose orders are cancelled.
	 * @param args.state - the global `State` PDA.
	 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `cancel_orders` accounts (only `state`/`user`/`authority` are used).
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` needed to re-derive auction/oracle-offset prices for the cancelled orders.
	 * @returns the unsigned `cancelOrders` `TransactionInstruction`.
	 */
	static async buildCancelOrdersInstruction(args: {
		program: VelocityProgram;
		marketType: any;
		marketIndex: number | null;
		direction: any;
		user: PublicKey;
		state: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrdersInstruction(args);
	}

	/**
	 * Builds a `fillPerpOrder` instruction, matching a resting perp order against the
	 * AMM and/or the supplied maker accounts. Permissionless: `user` (the order owner)
	 * does not need to sign — only `authority` (owner/delegate of `filler`) does.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderId - the order to fill, or `null` to fill `user`'s most recently placed order (resolved on-chain via `get_last_order_id`).
	 * @param args.state - the global `State` PDA.
	 * @param args.filler - the keeper's `User` account that earns the filler reward.
	 * @param args.fillerStats - the filler's `UserStats` PDA.
	 * @param args.user - the order owner's `User` account (the taker being filled).
	 * @param args.userStats - the taker's `UserStats` PDA.
	 * @param args.authority - signer that must own or be a registered delegate of `filler`.
	 * @param args.remainingAccounts - writable perp market + oracle `AccountMeta[]` for the order's market, followed by any maker/referrer `(User, UserStats)` account pairs, followed by the taker's `RevenueShareEscrow` account if builder codes are enabled protocol-wide.
	 * @returns the unsigned `fillPerpOrder` `TransactionInstruction`.
	 */
	static async buildFillPerpOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number | null;
		state: PublicKey;
		filler: PublicKey;
		fillerStats: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildFillPerpOrderInstruction(args);
	}

	/**
	 * Builds a `triggerOrder` instruction, flipping a resting trigger order (stop-loss /
	 * take-profit) into a fillable market/limit order once its trigger condition is met
	 * against the oracle. Permissionless: `user` (the order owner) does not need to sign
	 * — only `authority` (owner/delegate of `filler`) does. Does not fill the order; a
	 * subsequent `fillPerpOrder` (or `placeAndTake`) is needed to actually execute it.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderId - the trigger order's on-chain order ID.
	 * @param args.state - the global `State` PDA.
	 * @param args.filler - the keeper's `User` account submitting the trigger.
	 * @param args.user - the order owner's `User` account.
	 * @param args.authority - signer that must own or be a registered delegate of `filler`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for the order's market.
	 * @returns the unsigned `triggerOrder` `TransactionInstruction`.
	 */
	static async buildTriggerOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number;
		state: PublicKey;
		filler: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildTriggerOrderInstruction(args);
	}

	/**
	 * Builds a `settlePnl` instruction, settling `user`'s realized/expired perp PnL on
	 * `marketIndex` against the quote spot market vault. Fully permissionless: `authority`
	 * does not need to own or be a delegate of `user` — any signer can crank this.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.marketIndex - the perp market whose position PnL is settled.
	 * @param args.state - the global `State` PDA.
	 * @param args.authority - any signer; not required to own `user`.
	 * @param args.user - the `User` account being settled.
	 * @param args.spotMarketVault - the quote (market index 0) spot market's token vault PDA.
	 * @param args.remainingAccounts - writable perp market + oracle `AccountMeta[]` for `marketIndex`, plus the writable quote spot market, plus (if builder codes are enabled) `user`'s `RevenueShareEscrow` and the revenue-share market map needed to sweep completed builder fees.
	 * @returns the unsigned `settlePnl` `TransactionInstruction`.
	 */
	static async buildSettlePnlInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		state: PublicKey;
		authority: PublicKey;
		user: PublicKey;
		spotMarketVault: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildSettlePnlInstruction(args);
	}

	/**
	 * Builds a `liquidatePerp` instruction, letting `liquidator` take over (part of) an
	 * under-margined perp position from `user`. `user` does not need to sign; `authority`
	 * must own or be a delegate of `liquidator`, and `liquidator` must differ from `user`.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.marketIndex - the perp market being liquidated.
	 * @param args.maxBaseAssetAmount - maximum base amount the liquidator is willing to take on, BASE_PRECISION (1e9).
	 * @param args.limitPrice - worst acceptable execution price, PRICE_PRECISION (1e6), or `null` for no limit.
	 * @param args.state - the global `State` PDA.
	 * @param args.authority - signer that must own or be a registered delegate of `liquidator`.
	 * @param args.user - the `User` account being liquidated.
	 * @param args.userStats - the liquidated user's `UserStats` PDA.
	 * @param args.liquidator - the `User` account taking over the position; must not equal `user`.
	 * @param args.liquidatorStats - the liquidator's `UserStats` PDA.
	 * @param args.remainingAccounts - writable perp market + oracle `AccountMeta[]` for `marketIndex`.
	 * @returns the unsigned `liquidatePerp` `TransactionInstruction`.
	 */
	static async buildLiquidatePerpInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		maxBaseAssetAmount: any;
		limitPrice: any | null;
		state: PublicKey;
		authority: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		liquidator: PublicKey;
		liquidatorStats: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildLiquidatePerpInstruction(args);
	}

	/**
	 * Builds a `placePerpOrder` instruction, placing a single resting perp order.
	 * Rejects immediate-or-cancel orders — use `buildPlaceAndTakePerpOrderInstruction`
	 * or `buildPlaceAndMakePerpOrderInstruction` for IOC orders instead.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderParams - an `OrderParams` object; `baseAssetAmount` is BASE_PRECISION (1e9), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the `User` account the order is placed on.
	 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `place_perp_order` accounts.
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for `orderParams.marketIndex`, plus the placing user's `RevenueShareEscrow` account if the order carries a `builderIdx` and builder codes are enabled.
	 * @returns the unsigned `placePerpOrder` `TransactionInstruction`.
	 */
	static async buildPlacePerpOrderInstruction(args: {
		program: VelocityProgram;
		orderParams: any;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlacePerpOrderInstruction(args);
	}

	/**
	 * Builds a `placeAndTakePerpOrder` instruction: places an order and immediately
	 * attempts to fill it as a taker against the AMM and/or the supplied maker accounts.
	 * `orderParams.postOnly` must be `PostOnlyParam.None` or the instruction throws. Any
	 * portion left unfilled is auto-cancelled when the order is (or becomes, via
	 * `optionalParams`) immediate-or-cancel.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderParams - an `OrderParams` object; `baseAssetAmount` is BASE_PRECISION (1e9), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
	 * @param args.optionalParams - packed `u32` combining a `PlaceAndTakeOrderSuccessCondition` (fail the tx if not at least partially/fully filled) and an auction-duration percentage override; pass `null` for default behavior (no success-condition check, no override). Also forces IOC cancel-remainder semantics when non-null.
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the taker's `User` account.
	 * @param args.userStats - the taker's `UserStats` PDA.
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - writable perp market + oracle `AccountMeta[]` for `orderParams.marketIndex`, followed by maker/referrer `(User, UserStats)` pairs, followed by the taker's `RevenueShareEscrow` account if builder codes are enabled.
	 * @returns the unsigned `placeAndTakePerpOrder` `TransactionInstruction`.
	 */
	static async buildPlaceAndTakePerpOrderInstruction(args: {
		program: VelocityProgram;
		orderParams: any;
		optionalParams: number | null;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlaceAndTakePerpOrderInstruction(args);
	}

	/**
	 * Builds a `placeAndMakePerpOrder` instruction: posts an immediate-or-cancel,
	 * post-only limit order for `user` and immediately fills it as the maker against
	 * `taker`'s existing resting order. `orderParams` must be an IOC, post-only, `Limit`
	 * order or the instruction throws. Any unfilled remainder of the just-placed maker
	 * order is auto-cancelled.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderParams - an `OrderParams` object; `baseAssetAmount` is BASE_PRECISION (1e9), `price`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
	 * @param args.takerOrderId - the on-chain order ID of `taker`'s resting order being filled.
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the maker's `User` account.
	 * @param args.userStats - the maker's `UserStats` PDA.
	 * @param args.taker - the taker's `User` account (order owner being filled).
	 * @param args.takerStats - the taker's `UserStats` PDA.
	 * @param args.authority - signer that must own or be a registered delegate of `user` (the maker).
	 * @param args.remainingAccounts - writable perp market + oracle `AccountMeta[]` for `orderParams.marketIndex`, followed by any additional maker/referrer `(User, UserStats)` pairs needed to fill `taker`'s order, followed by `taker`'s `RevenueShareEscrow` account if builder codes are enabled.
	 * @returns the unsigned `placeAndMakePerpOrder` `TransactionInstruction`.
	 */
	static async buildPlaceAndMakePerpOrderInstruction(args: {
		program: VelocityProgram;
		orderParams: any;
		takerOrderId: number;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		taker: PublicKey;
		takerStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlaceAndMakePerpOrderInstruction(args);
	}

	/**
	 * Builds a `cancelOrder` instruction for a single order.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderId - the order to cancel, or `null` to cancel `user`'s most recently placed order (resolved on-chain via `get_last_order_id` — safe to use right after a `place*` instruction in the same transaction, since the on-chain order ID isn't known at build time).
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the `User` account whose order is cancelled.
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` needed to re-derive the cancelled order's auction/oracle-offset price.
	 * @returns the unsigned `cancelOrder` `TransactionInstruction`.
	 */
	static async buildCancelOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number | null;
		state: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrderInstruction(args);
	}

	/**
	 * Builds a `cancelOrderByUserId` instruction, cancelling the order matching the
	 * caller-assigned `userOrderId` (the `OrderParams.userOrderId` tag set at placement)
	 * rather than the program-assigned order ID.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.userOrderId - the caller-assigned order tag (`u8`) supplied when the order was placed.
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the `User` account whose order is cancelled.
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.oracle - accepted for forward-compatibility but not required by the current on-chain `cancel_order_by_user_id` accounts (only `state`/`user`/`authority` are used).
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` needed to re-derive the cancelled order's auction/oracle-offset price.
	 * @returns the unsigned `cancelOrderByUserId` `TransactionInstruction`.
	 */
	static async buildCancelOrderByUserIdInstruction(args: {
		program: VelocityProgram;
		userOrderId: number;
		state: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		oracle: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrderByUserIdInstruction(args);
	}

	/**
	 * Builds a `cancelOrdersByIds` instruction, cancelling multiple orders by their
	 * program-assigned order IDs in one instruction.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderIds - order IDs to cancel; passing `undefined` sends an empty list on-chain (cancels nothing).
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the `User` account whose orders are cancelled.
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` needed to re-derive the cancelled orders' auction/oracle-offset prices.
	 * @returns the unsigned `cancelOrdersByIds` `TransactionInstruction`.
	 */
	static async buildCancelOrdersByIdsInstruction(args: {
		program: VelocityProgram;
		orderIds: number[] | undefined;
		state: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrdersByIdsInstruction(args);
	}

	/**
	 * Builds a `modifyOrder` instruction, mutating an existing resting order in place
	 * (e.g. new price/size/trigger) rather than cancel-and-replace.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.orderId - the order to modify, or `null`/`undefined` semantics are not accepted here — pass the program-assigned order ID (use `buildModifyOrderByUserIdInstruction` to target by caller-assigned tag instead).
	 * @param args.modifyParams - a `ModifyOrderParams` object; any `baseAssetAmount`/`price`/`triggerPrice` overrides use BASE_PRECISION (1e9) / PRICE_PRECISION (1e6) respectively.
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the `User` account whose order is modified.
	 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `modify_order` accounts.
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for the order's market.
	 * @returns the unsigned `modifyOrder` `TransactionInstruction`.
	 */
	static async buildModifyOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number;
		modifyParams: any;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildModifyOrderInstruction(args);
	}

	/**
	 * Builds a `modifyOrderByUserId` instruction, same as `buildModifyOrderInstruction`
	 * but targeting the order by its caller-assigned `userOrderId` tag.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.userOrderId - the caller-assigned order tag (`u8`) supplied when the order was placed.
	 * @param args.modifyParams - a `ModifyOrderParams` object; any `baseAssetAmount`/`price`/`triggerPrice` overrides use BASE_PRECISION (1e9) / PRICE_PRECISION (1e6) respectively.
	 * @param args.state - the global `State` PDA.
	 * @param args.user - the `User` account whose order is modified.
	 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `modify_order_by_user_id` accounts.
	 * @param args.authority - signer that must own or be a registered delegate of `user`.
	 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for the order's market.
	 * @returns the unsigned `modifyOrderByUserId` `TransactionInstruction`.
	 */
	static async buildModifyOrderByUserIdInstruction(args: {
		program: VelocityProgram;
		userOrderId: number;
		modifyParams: any;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildModifyOrderByUserIdInstruction(args);
	}

	/**
	 * Builds an `updateFundingRate` instruction. Fully permissionless keeper crank —
	 * no signer is required at all; anyone can submit this to advance a perp market's
	 * funding rate once its funding period has elapsed.
	 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
	 * @param args.perpMarketIndex - the perp market to update.
	 * @param args.state - the global `State` PDA.
	 * @param args.perpMarket - the target `PerpMarket` PDA.
	 * @param args.oracle - the perp market's oracle account (must match `perpMarket.amm.oracle`).
	 * @returns the unsigned `updateFundingRate` `TransactionInstruction`.
	 */
	static async buildUpdateFundingRateInstruction(args: {
		program: VelocityProgram;
		perpMarketIndex: number;
		state: PublicKey;
		perpMarket: PublicKey;
		oracle: PublicKey;
	}): Promise<TransactionInstruction> {
		return await buildUpdateFundingRateInstruction(args);
	}

	/**
	 * Placeholder for instruction builders.
	 *
	 * In follow-up refactors, VelocityClient methods like `getDepositInstruction`,
	 * `getPlaceOrdersIx`, etc. will be moved here as pure builders.
	 */
	static buildInstructions(
		_ctx: VelocityCoreContext
	): TransactionInstruction[] {
		return [];
	}
}
