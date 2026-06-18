import {
	ComputeBudgetProgram,
	PublicKey,
	SendTransactionError,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { OptionValues, Command } from 'commander';
import { getCommandContext } from '../utils';
import { VaultDepositor } from '../../src';
import { BN, convertToNumber } from '@velocity-exchange/sdk';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

export const forceWithdrawAll = async (
	program: Command,
	cmdOpts: OptionValues
) => {
	let vaultAddress: PublicKey | undefined;
	try {
		vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
	} catch (err) {
		throw new Error('Must provide --vault-address');
	}

	if (!vaultAddress) {
		throw new Error('Failed to derive vault depositor address');
	}

	const { driftVault, driftClient, wallet } = await getCommandContext(
		program,
		true
	);

	const vault = await driftVault.getVault(vaultAddress);
	const allVaultDepositors = await driftVault.getAllVaultDepositors(
		vaultAddress
	);
	const spotMarket = driftVault.driftClient.getSpotMarketAccount(
		vault.spotMarketIndex
	);
	const spotPrecision = new BN(10).pow(new BN(spotMarket!.decimals));

	const withdrawables: Array<PublicKey> = [];
	for (const vd of allVaultDepositors) {
		const vdAccount = vd.account as VaultDepositor;
		if (vdAccount.lastWithdrawRequest.shares.gt(new BN(0))) {
			const withdrawRequested = vdAccount.lastWithdrawRequest.ts.toNumber();
			const secToWithdrawal =
				withdrawRequested + vault.redeemPeriod.toNumber() - Date.now() / 1000;
			const withdrawAvailable = secToWithdrawal < 0;
			const pct =
				vdAccount.lastWithdrawRequest.shares.toNumber() /
				vd.account.vaultShares.toNumber();
			const daysUntilWithdraw = Math.floor(secToWithdrawal / 86400);
			const hoursUntilWithdraw = Math.floor((secToWithdrawal % 86400) / 3600);

			if (secToWithdrawal < 0) {
				console.log(`Withdraw available for ${vdAccount.authority.toBase58()}`);
				console.log(
					`  - pending withdrawal: ${vdAccount.lastWithdrawRequest.shares.toString()} ($${convertToNumber(
						vd.account.lastWithdrawRequest.value,
						spotPrecision
					)}), ${(pct * 100.0).toFixed(2)}% of their deposit ${
						withdrawAvailable ? '<--- WITHDRAWABLE' : ''
					}`
				);
				console.log(
					`    - requested at: ${new Date(
						withdrawRequested * 1000
					).toISOString()}`
				);
				console.log(
					`    - can withdraw in: ${daysUntilWithdraw} days and ${hoursUntilWithdraw} hours`
				);
				withdrawables.push(vdAccount.pubkey);
			}
		}
	}

	console.log(`Withdrawing ${withdrawables.length} depositors`);
	const luts = await driftClient.fetchAllLookupTableAccounts();
	const chunkSize = 1;
	for (let i = 0; i < withdrawables.length; i += chunkSize) {
		const chunk = withdrawables.slice(i, i + chunkSize);
		console.log(
			`Processing chunk ${i / chunkSize + 1} of ${Math.ceil(
				withdrawables.length / chunkSize
			)}`
		);
		const ixs: TransactionInstruction[] = [
			new TransactionInstruction({
				keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }],
				data: Buffer.from('Drift Vaults manager initiated withdrawal', 'utf-8'),
				programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
			}),
		];
		for (const depositorAddress of chunk) {
			try {
				console.log(`Trying deposit: ${depositorAddress.toBase58()}`);
				ixs.push(...(await driftVault.getForceWithdrawIx(depositorAddress)));
			} catch (error) {
				console.error(
					`Error withdrawing for ${depositorAddress.toBase58()}:`,
					error
				);
			}
		}

		const message = new TransactionMessage({
			payerKey: driftClient.wallet.publicKey,
			recentBlockhash: (
				await driftClient.connection.getLatestBlockhash('finalized')
			).blockhash,
			instructions: [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 800_000,
				}),
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: 10_000,
				}),
				...ixs,
			],
		}).compileToV0Message(luts);

		const tx = await wallet.signVersionedTransaction(
			new VersionedTransaction(message)
		);

		console.log(`Sending chunk: ${bs58.encode(tx.signatures[0])}`);
		try {
			const txid = await driftClient.connection.sendTransaction(tx);
			console.log(`Sent chunk: https://solana.fm/tx/${txid}`);
		} catch (e) {
			console.error(`Error sending chunk: ${e}`);
			console.log((e as SendTransactionError).logs);
		}
	}

	// const tx = await driftVault.forceWithdraw(vaultDepositorAddress);
	// console.log(`Forced withdraw from vault: ${tx}`);
};
