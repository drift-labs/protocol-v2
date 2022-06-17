import { Connection, PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { getUserAccountPublicKey } from '../addresses/pda';
import { Program } from '@project-serum/anchor';

export async function fetchUserAccounts(
	connection: Connection,
	program: Program,
	authority: PublicKey,
	limit = 8
): Promise<UserAccount[]> {
	const userAccountPublicKeys = new Array<PublicKey>();
	for (let i = 0; i < limit; i++) {
		userAccountPublicKeys.push(
			await getUserAccountPublicKey(program.programId, authority, i)
		);
	}

	const accountInfos = await connection.getMultipleAccountsInfo(
		userAccountPublicKeys,
		'confirmed'
	);

	return accountInfos.map((accountInfo) => {
		return program.account.user.coder.accounts.decode(
			'User',
			accountInfo.data
		) as UserAccount;
	});
}
