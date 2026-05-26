import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

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
