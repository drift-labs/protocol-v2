import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

/**
 * Builds a `placePerpOrder` instruction, placing a single resting perp order. Rejects
 * immediate-or-cancel orders (`InvalidOrderIOC`) — use `buildPlaceAndTakePerpOrderInstruction`
 * or `buildPlaceAndMakePerpOrderInstruction` for IOC orders instead.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.orderParams - an `OrderParams` object; `baseAssetAmount` is BASE_PRECISION (1e9), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
 * @param args.state - the global `State` PDA.
 * @param args.user - the `User` account the order is placed on.
 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `place_perp_order` accounts.
 * @param args.authority - signer that must own or be a registered delegate of `user`.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for `orderParams.marketIndex`, plus the placing user's `RevenueShareEscrow` account if the order carries a `builderIdx` and builder codes are enabled protocol-wide.
 * @returns the unsigned `placePerpOrder` `TransactionInstruction`.
 */
export async function buildPlacePerpOrderInstruction(args: {
	program: VelocityProgram;
	orderParams: any;
	state: PublicKey;
	user: PublicKey;
	userStats: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).placePerpOrder(
		args.orderParams,
		{
			accounts: {
				state: args.state,
				user: args.user,
				userStats: args.userStats,
				authority: args.authority,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}

/**
 * Builds a `placeAndTakePerpOrder` instruction: places an order and immediately attempts
 * to fill it as a taker against the AMM and/or the supplied maker accounts.
 * `orderParams.postOnly` must be `PostOnlyParam.None` (`InvalidOrderPostOnly` otherwise).
 * Any portion left unfilled is auto-cancelled when the order is (or becomes, via
 * `optionalParams`) immediate-or-cancel.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.orderParams - an `OrderParams` object; `baseAssetAmount` is BASE_PRECISION (1e9), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
 * @param args.optionalParams - packed `u32` combining a `PlaceAndTakeOrderSuccessCondition` (fail the tx if not at least partially/fully filled) and an auction-duration percentage override; `null` for default behavior. Passing any non-null value also forces IOC cancel-remainder semantics.
 * @param args.state - the global `State` PDA.
 * @param args.user - the taker's `User` account.
 * @param args.userStats - the taker's `UserStats` PDA.
 * @param args.authority - signer that must own or be a registered delegate of `user`.
 * @param args.remainingAccounts - writable perp market + oracle `AccountMeta[]` for `orderParams.marketIndex`, followed by maker/referrer `(User, UserStats)` pairs, followed by the taker's `RevenueShareEscrow` account if builder codes are enabled.
 * @returns the unsigned `placeAndTakePerpOrder` `TransactionInstruction`.
 */
export async function buildPlaceAndTakePerpOrderInstruction(args: {
	program: VelocityProgram;
	orderParams: any;
	optionalParams: number | null;
	state: PublicKey;
	user: PublicKey;
	userStats: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await args.program.instruction.placeAndTakePerpOrder(
		args.orderParams,
		args.optionalParams,
		{
			accounts: {
				state: args.state,
				user: args.user,
				userStats: args.userStats,
				authority: args.authority,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}

/**
 * Builds a `placeAndMakePerpOrder` instruction: posts an immediate-or-cancel, post-only
 * `Limit` order for `user` and immediately fills it as the maker against `taker`'s
 * existing resting order (`InvalidOrderIOCPostOnly` if `orderParams` isn't IOC + post-only
 * + `Limit`). Any unfilled remainder of the just-placed maker order is auto-cancelled.
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
export async function buildPlaceAndMakePerpOrderInstruction(args: {
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
	return await args.program.instruction.placeAndMakePerpOrder(
		args.orderParams,
		args.takerOrderId,
		{
			accounts: {
				state: args.state,
				user: args.user,
				userStats: args.userStats,
				taker: args.taker,
				takerStats: args.takerStats,
				authority: args.authority,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}

/**
 * Build a raw `cancelOrder` instruction.
 *
 * Pass `orderId: null` to cancel the user's most recently placed order. The program
 * resolves a `null` ID on-chain via `get_last_order_id`, which makes this safe to use
 * in a multi-instruction transaction where a place instruction precedes the cancel and
 * the program-assigned order ID is not yet known at build time — e.g.:
 *
 *   [placePerpOrder] → [cancelOrder(orderId: null)]
 *
 * The on-chain `order_id` counter is a monotonically incrementing u32 on the user
 * account, so `get_last_order_id` reliably points to the order placed in the preceding
 * instruction of the same transaction.
 *
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.orderId - the order to cancel, or `null` per the above.
 * @param args.state - the global `State` PDA.
 * @param args.user - the `User` account whose order is cancelled.
 * @param args.authority - signer that must own or be a registered delegate of `user`.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` needed to re-derive the cancelled order's auction/oracle-offset price.
 * @returns the unsigned `cancelOrder` `TransactionInstruction`.
 */
export async function buildCancelOrderInstruction(args: {
	program: VelocityProgram;
	orderId: number | null;
	state: PublicKey;
	user: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await args.program.instruction.cancelOrder(args.orderId, {
		accounts: {
			state: args.state,
			user: args.user,
			authority: args.authority,
		},
		remainingAccounts: args.remainingAccounts,
	});
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
export async function buildCancelOrderByUserIdInstruction(args: {
	program: VelocityProgram;
	userOrderId: number;
	state: PublicKey;
	user: PublicKey;
	authority: PublicKey;
	oracle: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).cancelOrderByUserId(
		args.userOrderId,
		{
			accounts: {
				state: args.state,
				user: args.user,
				authority: args.authority,
				oracle: args.oracle,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}

/**
 * Builds a `cancelOrdersByIds` instruction, cancelling multiple orders by their
 * program-assigned order IDs in one instruction (loops `cancel_order_by_order_id`
 * on-chain, one order at a time — an order ID that no longer exists is silently
 * skipped rather than failing the whole instruction).
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.orderIds - order IDs to cancel; passing `undefined` sends an empty list on-chain (cancels nothing).
 * @param args.state - the global `State` PDA.
 * @param args.user - the `User` account whose orders are cancelled.
 * @param args.authority - signer that must own or be a registered delegate of `user`.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` needed to re-derive the cancelled orders' auction/oracle-offset prices.
 * @returns the unsigned `cancelOrdersByIds` `TransactionInstruction`.
 */
export async function buildCancelOrdersByIdsInstruction(args: {
	program: VelocityProgram;
	orderIds: number[] | undefined;
	state: PublicKey;
	user: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await args.program.instruction.cancelOrdersByIds(args.orderIds, {
		accounts: {
			state: args.state,
			user: args.user,
			authority: args.authority,
		},
		remainingAccounts: args.remainingAccounts,
	});
}

/**
 * Builds a `modifyOrder` instruction, mutating an existing resting order in place (e.g.
 * new price/size/trigger) rather than cancel-and-replace.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.orderId - the program-assigned order ID to modify (use `buildModifyOrderByUserIdInstruction` to target by the caller-assigned tag instead).
 * @param args.modifyParams - a `ModifyOrderParams` object; any `baseAssetAmount`/`price`/`triggerPrice` overrides use BASE_PRECISION (1e9) / PRICE_PRECISION (1e6) respectively.
 * @param args.state - the global `State` PDA.
 * @param args.user - the `User` account whose order is modified.
 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `modify_order` accounts.
 * @param args.authority - signer that must own or be a registered delegate of `user`.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for the order's market.
 * @returns the unsigned `modifyOrder` `TransactionInstruction`.
 */
export async function buildModifyOrderInstruction(args: {
	program: VelocityProgram;
	orderId: number;
	modifyParams: any;
	state: PublicKey;
	user: PublicKey;
	userStats: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).modifyOrder(
		args.orderId,
		args.modifyParams,
		{
			accounts: {
				state: args.state,
				user: args.user,
				userStats: args.userStats,
				authority: args.authority,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}

/**
 * Builds a `modifyOrderByUserId` instruction, same as `buildModifyOrderInstruction` but
 * targeting the order by its caller-assigned `userOrderId` tag.
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
export async function buildModifyOrderByUserIdInstruction(args: {
	program: VelocityProgram;
	userOrderId: number;
	modifyParams: any;
	state: PublicKey;
	user: PublicKey;
	userStats: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).modifyOrderByUserId(
		args.userOrderId,
		args.modifyParams,
		{
			accounts: {
				state: args.state,
				user: args.user,
				userStats: args.userStats,
				authority: args.authority,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}
