import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import { MarinadeFinance, IDL } from './types';
import {
	PublicKey,
	SystemProgram,
	TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const marinadeFinanceProgramId = new PublicKey(
	'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD'
);

export function getMarinadeFinanceProgram(
	provider: AnchorProvider
): Program<MarinadeFinance> {
	return new Program<MarinadeFinance>(IDL, marinadeFinanceProgramId, provider);
}

export function getMarinadeDepositIx({
	program,
	amount,
	mSOLAccount,
	transferFrom,
}: {
	amount: BN;
	mSOLAccount: PublicKey;
	transferFrom: PublicKey;
	program: Program<MarinadeFinance>;
}): Promise<TransactionInstruction> {
	return program.methods
		.deposit(amount)
		.accountsStrict({
			reservePda: new PublicKey('Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN'),
			state: new PublicKey('8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC'),
			msolMint: new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
			msolMintAuthority: new PublicKey(
				'3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM'
			),
			liqPoolMsolLegAuthority: new PublicKey(
				'EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL'
			),
			liqPoolMsolLeg: new PublicKey(
				'7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE'
			),
			liqPoolSolLegPda: new PublicKey(
				'UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q'
			),
			mintTo: mSOLAccount,
			transferFrom,
			systemProgram: SystemProgram.programId,
			tokenProgram: TOKEN_PROGRAM_ID,
		})
		.instruction();
}

export async function getMarinadeMSolPrice(
	program: Program<MarinadeFinance>
): Promise<number> {
	const state = await program.account.state.fetch(
		new PublicKey('8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC')
	);
	return state.msolPrice.toNumber() / 0x1_0000_0000;
}
