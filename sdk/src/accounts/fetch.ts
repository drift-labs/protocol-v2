import { Connection, PublicKey } from '@solana/web3.js';
import {
	RevenueShareAccount,
	RevenueShareEscrowAccount,
	UserAccount,
	UserStatsAccount,
} from '../types';
import {
	getRevenueShareAccountPublicKey,
	getRevenueShareEscrowAccountPublicKey,
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

export async function fetchRevenueShareAccount(
	connection: Connection,
	program: Program,
	authority: PublicKey
): Promise<RevenueShareAccount | null> {
	const revenueShareAccountPublicKey = getRevenueShareAccountPublicKey(
		program.programId,
		authority
	);
	const accountInfo = await connection.getAccountInfo(
		revenueShareAccountPublicKey
	);
	if (!accountInfo) return null;
	return program.account.revenueShare.coder.accounts.decode(
		'RevenueShare',
		accountInfo.data
	) as RevenueShareAccount;
}

export async function fetchRevenueShareEscrowAccount(
	connection: Connection,
	program: Program,
	authority: PublicKey
): Promise<RevenueShareEscrowAccount | null> {
	const revenueShareEscrowPubKey = getRevenueShareEscrowAccountPublicKey(
		program.programId,
		authority
	);

	const escrow = await connection.getAccountInfo(revenueShareEscrowPubKey);

	if (!escrow) return null;

	const escrowAccount =
		program.account.revenueShareEscrow.coder.accounts.decode(
			'RevenueShareEscrow',
			escrow.data
		) as RevenueShareEscrowAccount;

	return escrowAccount;
}
