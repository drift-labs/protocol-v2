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
import { VelocityProgram } from '../config';

export async function fetchUserAccounts(
	connection: Connection,
	program: VelocityProgram,
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
	program: VelocityProgram,
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
		return (program.account as any).user.coder.accounts.decodeUnchecked(
			'user',
			accountInfo.data
		) as UserAccount;
	});
}

export async function fetchUserStatsAccount(
	connection: Connection,
	program: VelocityProgram,
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
		? ((program.account as any).user.coder.accounts.decodeUnchecked(
				'userStats',
				accountInfo.data
		  ) as UserStatsAccount)
		: undefined;
}

export async function fetchRevenueShareAccount(
	connection: Connection,
	program: VelocityProgram,
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
	return (program.account as any).revenueShare.coder.accounts.decode(
		'revenueShare',
		accountInfo.data
	) as RevenueShareAccount;
}

export async function fetchRevenueShareEscrowAccount(
	connection: Connection,
	program: VelocityProgram,
	authority: PublicKey
): Promise<RevenueShareEscrowAccount | null> {
	const revenueShareEscrowPubKey = getRevenueShareEscrowAccountPublicKey(
		program.programId,
		authority
	);

	const escrow = await connection.getAccountInfo(revenueShareEscrowPubKey);

	if (!escrow) return null;

	const escrowAccount = (
		program.account as any
	).revenueShareEscrow.coder.accounts.decode(
		'revenueShareEscrow',
		escrow.data
	) as RevenueShareEscrowAccount;

	return escrowAccount;
}

export type FetchAccountOptions = {
	commitment?: Parameters<Connection['getAccountInfo']>[1];
};

/** Raw account data buffer (no Anchor decode). */
export async function fetchAccount(
	connection: Connection,
	publicKey: PublicKey,
	opts?: FetchAccountOptions
): Promise<Buffer | null> {
	const info = await connection.getAccountInfo(publicKey, opts?.commitment);
	return info?.data ?? null;
}

/** Batch variant of {@link fetchAccount}. */
export async function fetchAccounts(
	connection: Connection,
	publicKeys: PublicKey[],
	opts?: FetchAccountOptions
): Promise<(Buffer | null)[]> {
	const infos = await connection.getMultipleAccountsInfo(
		publicKeys,
		opts?.commitment
	);
	return infos.map((info) => info?.data ?? null);
}
