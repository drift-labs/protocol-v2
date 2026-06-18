import { OptionValues, Command } from 'commander';
import { encodeName } from '@velocity-exchange/sdk';
import { VAULT_PROGRAM_ID, getVaultAddressSync } from '../../src';

export const deriveVaultAddress = async (
	_program: Command,
	cmdOpts: OptionValues
) => {
	const vaultName = cmdOpts.vaultName;
	const vaultNameBytes = encodeName(vaultName!);
	const vaultAddress = getVaultAddressSync(VAULT_PROGRAM_ID, vaultNameBytes);

	console.log(`Vault address: ${vaultAddress.toBase58()}`);
};
