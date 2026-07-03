import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

/**
 * Builds a `placeOrders` instruction, placing a batch of up to 32 perp and/or spot
 * orders in one instruction. None of the orders may be immediate-or-cancel — IOC orders
 * are only valid via `placeAndTake`/`placeAndMake` — or the instruction throws.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.formattedParams - array of `OrderParams`: `baseAssetAmount` is BASE_PRECISION (1e9), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
 * @param args.state - the global `State` PDA.
 * @param args.user - the `User` account the orders are placed on; `authority` must own or be a delegate of it.
 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `place_orders` accounts (only `state`/`user`/`authority` are used).
 * @param args.authority - signer that must own or be a registered delegate of `user`.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` covering every order's market, plus the placing user's `RevenueShareEscrow` account when any order carries a `builderIdx` and builder codes are enabled protocol-wide.
 * @returns the unsigned `placeOrders` `TransactionInstruction`.
 */
export async function buildPlaceOrdersInstruction(args: {
	program: VelocityProgram;
	formattedParams: any[];
	state: PublicKey;
	user: PublicKey;
	userStats: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).placeOrders(
		args.formattedParams,
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
 * Builds a `cancelOrders` instruction, cancelling every open order on `user` that
 * matches all of the given (optional) filters. `null`/`undefined` on a filter means
 * "don't filter on this dimension" — leaving all three `null` cancels every open order.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.marketType - only cancel orders of this `MarketType` (`Perp`/`Spot`), or `null` for both.
 * @param args.marketIndex - only cancel orders on this market index, or `null` for all markets.
 * @param args.direction - only cancel orders with this `PositionDirection`, or `null` for both.
 * @param args.user - the `User` account whose orders are cancelled.
 * @param args.state - the global `State` PDA.
 * @param args.userStats - accepted for forward-compatibility but not required by the current on-chain `cancel_orders` accounts (only `state`/`user`/`authority` are used).
 * @param args.authority - signer that must own or be a registered delegate of `user`.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` needed to re-derive auction/oracle-offset prices for the cancelled orders.
 * @returns the unsigned `cancelOrders` `TransactionInstruction`.
 */
export async function buildCancelOrdersInstruction(args: {
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
	return await (args.program.instruction as any).cancelOrders(
		args.marketType,
		args.marketIndex,
		args.direction,
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
