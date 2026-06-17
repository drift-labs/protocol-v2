import { DEFAULT_ENDPOINT, logger } from '@backend/common';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { VelocityClient, VelocityEnv, Wallet } from '@velocity-exchange/sdk';

const MAX_ACCOUNT_BATCH = 100;

let driftClientPromise: Promise<VelocityClient> | undefined;
const authorityCache = new Map<string, string>();

const getDriftClient = async () => {
	if (!driftClientPromise) {
		driftClientPromise = Promise.resolve(
			new VelocityClient({
				connection: new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'confirmed'),
				wallet: new Wallet(new Keypair()),
				env: (process.env.ENV || 'mainnet-beta') as VelocityEnv,
				skipLoadUsers: true,
			})
		);
	}

	return driftClientPromise;
};

export const resolveAuthorities = async ({ userPubkeys }: { userPubkeys: string[] }) => {
	const uniquePubkeys = [...new Set(userPubkeys.filter(Boolean))];
	const unresolvedPubkeys = uniquePubkeys.filter((pubkey) => !authorityCache.has(pubkey));

	if (unresolvedPubkeys.length > 0) {
		const driftClient = await getDriftClient();

		for (let index = 0; index < unresolvedPubkeys.length; index += MAX_ACCOUNT_BATCH) {
			const batch = unresolvedPubkeys.slice(index, index + MAX_ACCOUNT_BATCH);
			const accounts = await driftClient.connection.getMultipleAccountsInfo(
				batch.map((pubkey) => new PublicKey(pubkey))
			);

			accounts.forEach((accountInfo, accountIndex) => {
				const pubkey = batch[accountIndex];
				if (!pubkey || !accountInfo) {
					return;
				}

				try {
					const userAccount =
						driftClient.program.account.user.coder.accounts.decodeUnchecked(
							'User',
							accountInfo.data
						) as { authority: PublicKey };
					authorityCache.set(pubkey, userAccount.authority.toBase58());
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn(`Unable to decode user authority for ${pubkey}: ${message}`);
				}
			});
		}
	}

	return uniquePubkeys.reduce((result, pubkey) => {
		result[pubkey] = authorityCache.get(pubkey);
		return result;
	}, {} as Record<string, string | undefined>);
};
