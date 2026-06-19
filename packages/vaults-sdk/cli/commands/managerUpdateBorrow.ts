import { Command, OptionValues } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { BN, TEN } from '@velocity-exchange/sdk';
import { dumpTransactionMessage, getCommandContext } from '../utils';

export async function managerUpdateBorrow(
	program: Command,
	cmdOpts: OptionValues
): Promise<void> {
	const {
		vaultAddress,
		newBorrowValue,
		dumpTransactionMessage: dumpTx,
	} = cmdOpts;

	const { velocityClient, velocityVault } = await getCommandContext(program, true);

	if (!vaultAddress) {
		throw new Error('Must provide vault address with --vault-address');
	}

	if (!newBorrowValue) {
		throw new Error('Must provide new borrow value with --new-borrow-value');
	}

	const vault = new PublicKey(vaultAddress);
	const vaultAccount = await velocityVault.program.account.vault.fetch(vault);
	const depositSpotMarket = velocityClient.getSpotMarketAccount(
		vaultAccount.spotMarketIndex
	);
	if (!depositSpotMarket) {
		throw new Error('No deposit spot market found');
	}
	const depositPrecision = TEN.pow(new BN(depositSpotMarket.decimals));
	const borrowValue = new BN(newBorrowValue * depositPrecision.toNumber());

	try {
		if (dumpTx) {
			const ix = await velocityVault.getManagerUpdateBorrowIx(vault, borrowValue);
			console.log('Transaction Instruction:');
			console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, [ix]));
			return;
		}

		const txSig = await velocityVault.managerUpdateBorrow(vault, borrowValue);
		console.log(`Manager update borrow transaction signature: ${txSig}`);
		console.log(
			`Transaction: https://solana.fm/tx/${txSig}${
				velocityClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
			}`
		);
	} catch (error) {
		console.error('Error updating borrow:', error);
		throw error;
	}
}
