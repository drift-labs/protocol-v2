import { BN, TEN } from '@velocity-exchange/sdk';
import { PublicKey } from '@solana/web3.js';
import { OptionValues, Command } from 'commander';
import { getCommandContext } from '../utils';
import { getVaultDepositorAddressSync, VAULT_PROGRAM_ID } from '../../src';

export const deposit = async (program: Command, cmdOpts: OptionValues) => {
	// verify correct args provided
	if (!cmdOpts.vaultDepositorAddress) {
		if (!cmdOpts.vaultAddress || !cmdOpts.depositAuthority) {
			console.error(
				'Must provide --vault-address and --deposit-authority if not providing --vault-depositor-address'
			);
			process.exit(1);
		}
	}

	const { driftClient, driftVault } = await getCommandContext(program, true);

	let vaultDepositorAddress: PublicKey;
	let vaultAddress: PublicKey | undefined;
	let depositAuthority: PublicKey | undefined;
	if (cmdOpts.vaultDepositorAddress) {
		vaultDepositorAddress = new PublicKey(
			cmdOpts.vaultDepositorAddress as string
		);
	} else {
		vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
		depositAuthority = new PublicKey(cmdOpts.depositAuthority as string);
		vaultDepositorAddress = getVaultDepositorAddressSync(
			VAULT_PROGRAM_ID,
			vaultAddress,
			depositAuthority
		);
	}

	const vaultDepositorAccount =
		await driftVault.program.account.vaultDepositor.fetchNullable(
			vaultDepositorAddress
		);
	if (!vaultDepositorAccount) {
		if (!vaultAddress || !depositAuthority) {
			console.error(
				'Must provide --vault-address and --deposit-authority if not providing --vault-depositor-address, and VaultDepositor account does not exist'
			);
			process.exit(1);
		}

		const vaultAccount = await driftVault.program.account.vault.fetch(
			vaultAddress
		);
		const spotMarket = driftClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error('No spot market found');
		}
		const spotPrecision = TEN.pow(new BN(spotMarket.decimals));
		const depositBN = new BN(cmdOpts.amount * spotPrecision.toNumber());

		console.log(
			`depositing (initializing VaultDepositor account): ${depositBN.toString()}`
		);
		const tx = await driftVault.deposit(vaultDepositorAddress, depositBN, {
			authority: depositAuthority,
			vault: vaultAddress,
		});
		console.log(
			`Deposited ${cmdOpts.amount} to vault: https://solana.fm/tx/${tx}${
				driftClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
			}`
		);
	} else {
		// VaultDepositor exists
		const vaultAddress = vaultDepositorAccount.vault;
		const vaultAccount = await driftVault.program.account.vault.fetch(
			vaultAddress
		);
		const spotMarket = driftClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error('No spot market found');
		}
		const spotPrecision = TEN.pow(new BN(spotMarket.decimals));
		const depositBN = new BN(cmdOpts.amount * spotPrecision.toNumber());

		console.log(
			`depositing (existing VaultDepositor account): ${depositBN.toString()}`
		);
		const tx = await driftVault.deposit(vaultDepositorAddress, depositBN);
		console.log(
			`Deposited ${cmdOpts.amount} to vault: https://solana.fm/tx/${tx}${
				driftClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
			}`
		);
	}
};
