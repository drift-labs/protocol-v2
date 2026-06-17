import { Command, OptionValues } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { BN, TEN } from '@velocity-exchange/sdk';
import { dumpTransactionMessage, getCommandContext } from '../utils';

export async function managerBorrow(
	program: Command,
	cmdOpts: OptionValues
): Promise<void> {
	const {
		vaultAddress,
		borrowSpotMarketIndex,
		borrowAmount,
		managerTokenAccount,
		dumpTransactionMessage: dumpTx,
	} = cmdOpts;

	const { driftClient, driftVault } = await getCommandContext(program, true);

	if (!vaultAddress) {
		throw new Error('Must provide vault address with --vault-address');
	}

	if (!borrowSpotMarketIndex) {
		throw new Error(
			'Must provide borrow spot market index with --borrow-spot-market-index'
		);
	}

	if (!borrowAmount) {
		throw new Error('Must provide borrow amount with --borrow-amount');
	}

	const vault = new PublicKey(vaultAddress);
	const borrowIndex = parseInt(borrowSpotMarketIndex);

	const borrowSpotMarket = driftClient.getSpotMarketAccount(borrowIndex);
	if (!borrowSpotMarket) {
		throw new Error('No borrow spot market found');
	}
	const borrowPrecision = TEN.pow(new BN(borrowSpotMarket.decimals));
	const borrowBN = new BN(borrowAmount * borrowPrecision.toNumber());

	const managerTokenAccountPubkey = managerTokenAccount
		? new PublicKey(managerTokenAccount)
		: undefined;

	try {
		if (dumpTx) {
			const ixs = await driftVault.getManagerBorrowIx(
				vault,
				borrowIndex,
				borrowBN,
				managerTokenAccountPubkey
			);
			console.log('Transaction Instructions:');
			console.log(dumpTransactionMessage(driftClient.wallet.publicKey, ixs));
			return;
		}

		const txSig = await driftVault.managerBorrow(
			vault,
			borrowIndex,
			borrowBN,
			managerTokenAccountPubkey
		);
		console.log(`Manager borrow transaction signature: ${txSig}`);
		console.log(
			`Transaction: https://solana.fm/tx/${txSig}${
				driftClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
			}`
		);
	} catch (error) {
		console.error('Error borrowing:', error);
		throw error;
	}
}
