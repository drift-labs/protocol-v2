import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { VelocityProgram } from '../../config';

/**
 * Builds an `updateFundingRate` instruction. Fully permissionless keeper crank — no
 * signer is required at all; anyone can submit this to advance a perp market's funding
 * rate once its funding period has elapsed. Throws `FundingWasNotUpdated` on-chain if
 * called before the market's funding period has elapsed.
 * @param args.program - Anchor `Program<Velocity>` used to build the instruction.
 * @param args.perpMarketIndex - the perp market to update.
 * @param args.state - the global `State` PDA.
 * @param args.perpMarket - the target `PerpMarket` PDA.
 * @param args.oracle - the perp market's oracle account (must match `perpMarket.amm.oracle`).
 * @returns the unsigned `updateFundingRate` `TransactionInstruction`.
 */
export async function buildUpdateFundingRateInstruction(args: {
	program: VelocityProgram;
	perpMarketIndex: number;
	state: PublicKey;
	perpMarket: PublicKey;
	oracle: PublicKey;
}): Promise<TransactionInstruction> {
	return await (args.program.instruction as any).updateFundingRate(
		args.perpMarketIndex,
		{
			accounts: {
				state: args.state,
				perpMarket: args.perpMarket,
				oracle: args.oracle,
			},
		}
	);
}
