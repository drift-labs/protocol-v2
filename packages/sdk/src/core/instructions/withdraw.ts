import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { BN } from '../../isomorphic/anchor';
import type { VelocityProgram } from '../../config';

/**
 * Builds a `withdraw` instruction, transferring tokens from the protocol's
 * `spotMarketVault` to `userTokenAccount` and debiting (or borrowing against) `user`'s
 * spot position. Unlike deposit, `authority` must equal `user`'s own `authority` field
 * (and `userStats`'s) — delegates cannot withdraw.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.marketIndex - source spot market index.
 * @param args.amount - withdrawal amount, in the spot market's mint's native token precision.
 * @param args.reduceOnly - if true (or the market is reduce-only), caps the withdrawal to the user's current deposit balance so it can only reduce a deposit, never open/increase a borrow.
 * @param args.state - the global `State` PDA.
 * @param args.spotMarket - the source `SpotMarket` PDA.
 * @param args.spotMarketVault - the spot market's token vault PDA (transfer source).
 * @param args.velocitySigner - the program's PDA signer authority; must equal `state.signer` or the instruction throws (used as the CPI signer for the vault-to-user transfer).
 * @param args.user - the `User` account being debited; its `authority` must equal `args.authority`.
 * @param args.userStats - the withdrawing user's `UserStats` PDA; its `authority` must also equal `args.authority`.
 * @param args.userTokenAccount - destination token account; must share a mint with `spotMarketVault`.
 * @param args.authority - signer that must equal `user.authority` (and `userStats.authority`).
 * @param args.tokenProgram - the SPL Token or Token-2022 program owning the mint.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for `marketIndex`, plus the withdrawn mint account, plus any Token-2022 transfer-hook accounts.
 * @returns the unsigned `withdraw` `TransactionInstruction`.
 */
export async function buildWithdrawInstruction(args: {
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
	return await (args.program.instruction as any).withdraw(
		args.marketIndex,
		args.amount,
		args.reduceOnly,
		{
			accounts: {
				state: args.state,
				spotMarket: args.spotMarket,
				spotMarketVault: args.spotMarketVault,
				velocitySigner: args.velocitySigner,
				user: args.user,
				userStats: args.userStats,
				userTokenAccount: args.userTokenAccount,
				authority: args.authority,
				tokenProgram: args.tokenProgram,
			},
			remainingAccounts: args.remainingAccounts,
		}
	);
}
