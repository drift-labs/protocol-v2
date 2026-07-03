import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

/**
 * Builds a `liquidatePerp` instruction, letting `liquidator` take over (part of) an
 * under-margined perp position from `user`. `user` does not need to sign; `authority`
 * must own or be a delegate of `liquidator`, and `liquidator` must differ from `user`
 * (self-liquidation throws `UserCantLiquidateThemself`).
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
export async function buildLiquidatePerpInstruction(args: {
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
	return await (args.program.instruction as any).liquidatePerp(
		args.marketIndex,
		args.maxBaseAssetAmount,
		args.limitPrice,
		{
			accounts: {
				state: args.state,
				authority: args.authority,
				user: args.user,
				userStats: args.userStats,
				liquidator: args.liquidator,
				liquidatorStats: args.liquidatorStats,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}
