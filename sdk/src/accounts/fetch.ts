import { Connection, PublicKey } from '@solana/web3.js';
import { UserAccount, UserStatsAccount } from '../types';
import {
	getUserAccountPublicKey,
	getUserStatsAccountPublicKey,
} from '../addresses/pda';
import { Program } from '@coral-xyz/anchor';

export async function fetchUserAccounts(
	connection: Connection,
	program: Program,
	authority: PublicKey,
	limit = 8
): Promise<(UserAccount | undefined)[]> {
	const userAccountPublicKeys = new Array<PublicKey>();
	for (let i = 0; i < limit; i++) {
		userAccountPublicKeys.push(
			await getUserAccountPublicKey(program.programId, authority, i)
		);
	}

	return fetchUserAccountsUsingKeys(connection, program, userAccountPublicKeys);
}

export async function fetchUserAccountsUsingKeys(
	connection: Connection,
	program: Program,
	userAccountPublicKeys: PublicKey[]
): Promise<(UserAccount | undefined)[]> {
	const accountInfos = await connection.getMultipleAccountsInfo(
		userAccountPublicKeys,
		'confirmed'
	);

	return accountInfos.map((accountInfo) => {
		if (!accountInfo) {
			return undefined;
		}
		return program.account.user.coder.accounts.decodeUnchecked(
			'User',
			accountInfo.data
		) as UserAccount;
	});
}

export async function fetchUserStatsAccount(
	connection: Connection,
	program: Program,
	authority: PublicKey
): Promise<UserStatsAccount | undefined> {
	const userStatsPublicKey = getUserStatsAccountPublicKey(
		program.programId,
		authority
	);
	const accountInfo = await connection.getAccountInfo(
		userStatsPublicKey,
		'confirmed'
	);

	return accountInfo
		? (program.account.user.coder.accounts.decodeUnchecked(
				'UserStats',
				accountInfo.data
		  ) as UserStatsAccount)
		: undefined;
}
