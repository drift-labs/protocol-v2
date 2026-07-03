import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

/**
 * Builds a `fillPerpOrder` instruction, matching a resting perp order against the AMM
 * and/or the supplied maker accounts. Permissionless: `user` (the order owner) does not
 * need to sign — only `authority` (owner/delegate of `filler`) does. Hardcodes the
 * on-chain `makerOrderId` arg to `null` (no specific maker order is targeted; the
 * program matches from whichever maker/referrer accounts are supplied).
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
export async function buildFillPerpOrderInstruction(args: {
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
	return await (args.program.instruction as any).fillPerpOrder(
		args.orderId,
		null,
		{
			accounts: {
				state: args.state,
				filler: args.filler,
				fillerStats: args.fillerStats,
				user: args.user,
				userStats: args.userStats,
				authority: args.authority,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}
