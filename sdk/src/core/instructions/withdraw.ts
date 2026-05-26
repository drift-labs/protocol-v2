import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { BN } from '../../isomorphic/anchor';
import type { VelocityProgram } from '../../config';

export async function buildWithdrawInstruction(args: {
	program: VelocityProgram;
	marketIndex: number;
	amount: BN;
	reduceOnly: boolean;
	state: PublicKey;
	spotMarket: PublicKey;
	spotMarketVault: PublicKey;
	driftSigner: PublicKey;
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
				driftSigner: args.driftSigner,
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
