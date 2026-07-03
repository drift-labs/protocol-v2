import type {
	AccountMeta,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

/**
 * Builds a `settlePnl` instruction, settling `user`'s realized (or, if the market is in
 * `Settlement` status, expired) perp PnL on `marketIndex` against the quote spot market
 * vault. Fully permissionless: `authority` does not need to own or be a delegate of
 * `user` — any signer can crank this.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.marketIndex - the perp market whose position PnL is settled.
 * @param args.state - the global `State` PDA.
 * @param args.authority - any signer; not required to own `user`.
 * @param args.user - the `User` account being settled.
 * @param args.spotMarketVault - the quote (market index 0) spot market's token vault PDA.
 * @param args.remainingAccounts - writable perp market + oracle `AccountMeta[]` for `marketIndex`, plus the writable quote spot market, plus (if builder codes are enabled) `user`'s `RevenueShareEscrow` and the revenue-share market map needed to sweep completed builder fees.
 * @returns the unsigned `settlePnl` `TransactionInstruction`.
 */
export async function buildSettlePnlInstruction(args: {
	program: VelocityProgram;
	marketIndex: number;
	state: PublicKey;
	authority: PublicKey;
	user: PublicKey;
	spotMarketVault: PublicKey;
	remainingAccounts: AccountMeta[];
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).settlePnl(args.marketIndex, {
		accounts: {
			state: args.state,
			authority: args.authority,
			user: args.user,
			spotMarketVault: args.spotMarketVault,
		},
		remainingAccounts: args.remainingAccounts,
	});
}
