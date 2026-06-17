import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

export async function buildTriggerOrderInstruction(args: {
	program: VelocityProgram;
	orderId: number;
	state: PublicKey;
	filler: PublicKey;
	user: PublicKey;
	authority: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).triggerOrder(args.orderId, {
		accounts: {
			state: args.state,
			filler: args.filler,
			user: args.user,
			authority: args.authority,
		},
		remainingAccounts: args.remainingAccounts,
	});
}
