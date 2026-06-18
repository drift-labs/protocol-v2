import { Account, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { PublicKey, AccountInfo } from '@solana/web3.js';

export function parseTokenAccount(data: Buffer, pubkey: PublicKey): Account {
	// mock AccountInfo so unpackAccount can be used
	const accountInfo: AccountInfo<Buffer> = {
		data,
		owner: TOKEN_PROGRAM_ID,
		executable: false,
		lamports: 0,
	};
	return unpackAccount(pubkey, accountInfo, TOKEN_PROGRAM_ID);
}
