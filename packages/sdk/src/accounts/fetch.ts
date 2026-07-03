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

/**
 * Fetches every `UserAccount` (sub-account) belonging to `authority`, from sub-account id `0`
 * up to `limit - 1`, in a single batched `getMultipleAccountsInfo` RPC call.
 * @param connection Connection used for the batched fetch.
 * @param program Anchor program used to derive PDAs and decode account data.
 * @param authority Wallet/authority pubkey whose sub-accounts to fetch.
 * @param limit Number of sub-account ids to check, starting at 0. Defaults to 8.
 * @returns One entry per sub-account id in order; `undefined` where no account exists at that id.
 */
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

/**
 * Fetches and decodes a specific list of `UserAccount` pubkeys in one batched
 * `getMultipleAccountsInfo` RPC call. Unlike `fetchUserAccounts`, the caller supplies the exact
 * addresses rather than deriving them by sub-account id.
 * @param connection Connection used for the batched fetch.
 * @param program Anchor program used to decode account data.
 * @param userAccountPublicKeys Addresses to fetch, in order.
 * @returns One entry per input pubkey, in the same order; `undefined` where no account exists at that address.
 */
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

/**
 * Fetches and decodes the `UserStatsAccount` for `authority`, if one exists.
 * @param connection Connection used for the fetch.
 * @param program Anchor program used to derive the PDA and decode account data.
 * @param authority Wallet/authority pubkey the stats account belongs to.
 * @returns The decoded account, or `undefined` if it hasn't been initialized on-chain.
 */
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

/**
 * Fetches and decodes the `RevenueShareAccount` for `authority` (tracks referral/builder revenue
 * share balances), if one exists.
 * @param connection Connection used for the fetch.
 * @param program Anchor program used to derive the PDA and decode account data.
 * @param authority Wallet/authority pubkey the revenue share account belongs to.
 * @returns The decoded account, or `null` if it hasn't been initialized on-chain.
 */
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

/**
 * Fetches and decodes the `RevenueShareEscrowAccount` for `authority` (holds escrowed
 * revenue-share amounts pending distribution), if one exists.
 * @param connection Connection used for the fetch.
 * @param program Anchor program used to derive the PDA and decode account data.
 * @param authority Wallet/authority pubkey the escrow account belongs to.
 * @returns The decoded account, or `null` if it hasn't been initialized on-chain.
 */
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

/** Options accepted by `fetchAccount`/`fetchAccounts`. */
export type FetchAccountOptions = {
	/** Commitment level for the underlying `getAccountInfo`/`getMultipleAccountsInfo` call; defaults to the connection's configured commitment if omitted. */
	commitment?: Parameters<Connection['getAccountInfo']>[1];
};

/**
 * Fetches an account's raw data buffer without decoding it (no Anchor coder involved), for
 * callers that only need the bytes.
 * @param connection Connection used for the fetch.
 * @param publicKey Account address to fetch.
 * @param opts Optional commitment override.
 * @returns The raw account data, or `null` if the account doesn't exist.
 */
export async function fetchAccount(
	connection: Connection,
	publicKey: PublicKey,
	opts?: FetchAccountOptions
): Promise<Buffer | null> {
	const info = await connection.getAccountInfo(publicKey, opts?.commitment);
	return info?.data ?? null;
}

/**
 * Batch variant of `fetchAccount` — fetches raw data buffers for multiple accounts in one
 * `getMultipleAccountsInfo` call.
 * @param connection Connection used for the fetch.
 * @param publicKeys Account addresses to fetch, in order.
 * @param opts Optional commitment override.
 * @returns One entry per input pubkey, in the same order; `null` where the account doesn't exist.
 */
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
