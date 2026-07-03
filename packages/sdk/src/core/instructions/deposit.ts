import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { BN } from '../../isomorphic/anchor';
import type { VelocityProgram } from '../../config';

/**
 * Builds a `deposit` instruction, transferring tokens from `userTokenAccount` into the
 * protocol's `spotMarketVault` and crediting `user`'s spot position. Any signer may fund
 * someone else's `user` account (`authority` need not own/delegate for `user`) as long as
 * `userTokenAccount` is owned by `authority`; on mainnet, a non-owner/non-delegate
 * `authority` must additionally be on the on-chain external-depositor whitelist or the
 * instruction throws.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.marketIndex - target spot market index.
 * @param args.amount - deposit amount, in the spot market's mint's native token precision (e.g. 1e6 for a 6-decimal mint) — not a fixed SDK precision.
 * @param args.reduceOnly - if true (or the market is reduce-only), caps the deposit to the user's current borrow balance so it can only repay a borrow.
 * @param args.state - the global `State` PDA.
 * @param args.spotMarket - the target `SpotMarket` PDA.
 * @param args.spotMarketVault - the spot market's token vault PDA (transfer destination).
 * @param args.user - the `User` account being credited.
 * @param args.userStats - the depositing user's `UserStats` PDA.
 * @param args.userTokenAccount - source token account; must share a mint with `spotMarketVault` and be owned by `authority`.
 * @param args.authority - signer authorizing the token transfer.
 * @param args.tokenProgram - the SPL Token or Token-2022 program owning the mint.
 * @param args.remainingAccounts - oracle/market `AccountMeta[]` for `marketIndex`, plus the deposited mint account, plus any Token-2022 transfer-hook accounts.
 * @returns the unsigned `deposit` `TransactionInstruction`.
 */
export async function buildDepositInstruction(args: {
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
	return await (args.program.instruction as any).deposit(
		args.marketIndex,
		args.amount,
		args.reduceOnly,
		{
			accounts: {
				state: args.state,
				spotMarket: args.spotMarket,
				spotMarketVault: args.spotMarketVault,
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
