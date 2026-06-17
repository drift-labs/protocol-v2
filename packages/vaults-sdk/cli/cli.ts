require('dotenv').config();

import {
	initVault,
	viewVault,
	deriveVaultAddress,
	managerDeposit,
	managerRequestWithdraw,
	managerCancelWithdraw,
	managerWithdraw,
	managerUpdateVault,
	managerUpdateVaultManager,
	managerUpdateVaultDelegate,
	applyProfitShare,
	initVaultDepositor,
	deposit,
	requestWithdraw,
	withdraw,
	forceWithdraw,
	forceWithdrawAll,
	listDepositorsForVault,
	managerUpdateMarginTradingEnabled,
	decodeLogs,
	vaultInvariantChecks,
	managerBorrow,
	managerRepay,
	managerUpdateBorrow,
	adminUpdateVaultClass,
} from './commands';

import { Command, Option } from 'commander';
import { viewVaultDepositor } from './commands/viewVaultDepositor';
import { managerUpdatePoolId } from './commands/managerUpdatePoolId';
import { managerApplyProfitShare } from './commands/managerApplyProfitShare';
import { managerUpdateFees } from './commands/managerUpdateFees';
import { adminInitFeeUpdate } from './commands/adminInitFeeUpdate';
import { adminDeleteFeeUpdate } from './commands/adminDeleteFeeUpdate';

const program = new Command();
program
	.addOption(
		new Option('-u, --url <url>', 'RPC URL to use for requests')
			.env('RPC_URL')
			.makeOptionMandatory(true)
	)
	.addOption(
		new Option('-k, --keypair <filepath>', 'Path to keypair file').env(
			'KEYPAIR_PATH'
		)
	)
	.addOption(
		new Option('--commitment <commitment>', 'State commitment to use').default(
			'confirmed'
		)
	)
	.addOption(
		new Option('--env <env>', 'Environment to use (devnet, mainnet-beta)')
			.default('mainnet-beta')
			.env('ENV')
	);
program
	.command('init-vault')
	.description('Initialize a new vault')
	.requiredOption('-n, --name <string>', 'Name of the vault to create')
	.option(
		'-i, --market-index <number>',
		'Spot market index to accept for deposits (default 0 == USDC)',
		'0'
	)
	.option(
		'-r, --redeem-period <number>',
		'The period (in seconds) depositors must wait after requesting a withdraw (default: 7 days)',
		(7 * 60 * 60 * 24).toString()
	)
	.option(
		'-x, --max-tokens <number>',
		'The max number of spot marketIndex tokens the vault can accept (default 0 == unlimited)',
		'0'
	)
	.option(
		'-m, --management-fee <percent>',
		'The annualized management fee to charge depositors',
		'0'
	)
	.option(
		'-s, --profit-share <percent>',
		'The percentage of profits charged by manager',
		'0'
	)
	.option(
		'-p, --permissioned',
		'Provide this flag to make the vault permissioned, vault-depositors will need to be initialized by the manager',
		false
	)
	.option(
		'-a, --min-deposit-amount <number',
		'The minimum token amount allowed to deposit',
		'0'
	)
	.option(
		'-d, --delegate <publicKey>',
		'The address to make the delegate of the vault'
	)
	.addOption(new Option('--manager <publickey>', 'The manager for the vault'))
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => initVault(program, opts));
program
	.command('view-vault')
	.description('View Vault account details')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the Vault to view'
		).makeOptionMandatory(true)
	)
	.action((opts) => viewVault(program, opts));
program
	.command('derive-vault-address')
	.description('Derives the vault address from its name')
	.addOption(
		new Option(
			'--vault-name <string>',
			'Name of the vault'
		).makeOptionMandatory(true)
	)
	.action((opts) => deriveVaultAddress(program, opts));
program
	.command('view-vault-depositor')
	.description('View VaultDepositor account details')
	.addOption(
		new Option(
			'--vault-depositor-address <address>',
			'Address of the VaultDepositor to view'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the Vault to view'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--authority <vaultDepositorAuthority>',
			'VaultDepositor authority address'
		).makeOptionMandatory(false)
	)
	.action((opts) => viewVaultDepositor(program, opts));
program
	.command('list-vault-depositors')
	.description('List VaultDepositors for a Vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the Vault to list depositors'
		).makeOptionMandatory(true)
	)
	.action((opts) => listDepositorsForVault(program, opts));
program
	.command('manager-deposit')
	.description('Make a deposit to your vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to deposit to'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--amount <amount>',
			'Amount to deposit (in deposit precision, 5 for 5 USDC)'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerDeposit(program, opts));
program
	.command('manager-request-withdraw')
	.description('Make a withdraw request from your vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to withdraw from'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--shares <shares>',
			'Amount of shares to withdraw (raw precision, as expected by contract)'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--amount <amount>',
			'Amount of spot asset to withdraw (in deposit precision, 5 for 5 USDC)'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerRequestWithdraw(program, opts));
program
	.command('manager-update-vault')
	.description('Update vault params for a manager')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to update '
		).makeOptionMandatory(true)
	)
	.option(
		'-r, --redeem-period <number>',
		'The new redeem period (can only be lowered)'
	)
	.option('-x, --max-tokens <number>', 'The max tokens the vault can accept')
	.option(
		'-a, --min-deposit-amount <number',
		'The minimum token amount allowed to deposit'
	)
	.option(
		'-m, --management-fee <percent>',
		'The new management fee (can only be lowered, use timelocked manager-update-fees to raise)'
	)
	.option(
		'-s, --profit-share <percent>',
		'The new profit share percentage (can only be lowered, use timelocked manager-update-fees to raise)'
	)
	.option(
		'-h, --hurdle-rate <percent>',
		'The new hurdle rate percentage (can only be raised, use timelocked manager-update-fees to lower)'
	)
	.option(
		'-p, --permissioned <boolean>',
		'Set the vault as permissioned (true) or open (false)'
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerUpdateVault(program, opts));
program
	.command('manager-update-vault-manager')
	.description('Update the manager of a vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to update '
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--new-manager <publickey>',
			'The new manager for the vault'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerUpdateVaultManager(program, opts));
program
	.command('manager-update-delegate')
	.description('Update vault params for a manager')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to update '
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'-d, --delegate <publickey>',
			'The new delegate authority for the vault'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerUpdateVaultDelegate(program, opts));
program
	.command('manager-update-margin-trading-enabled')
	.description('Update vault margin trading permissiones a manager')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to view'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--enabled <enabled>',
			'true to enable, false to disable'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerUpdateMarginTradingEnabled(program, opts));
program
	.command('manager-update-pool-id')
	.description('Update the pool id for a vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to view'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--pool-id <pool-id>',
			'New pool id for the vault'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerUpdatePoolId(program, opts));
program
	.command('manager-apply-profit-share')
	.description('Update the pool id for a vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to view'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--vault-depositor <address>',
			'Address of the vault depositor to apply profit share for'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerApplyProfitShare(program, opts));
program
	.command('manager-withdraw')
	.description('Make a withdraw from your vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to view'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerWithdraw(program, opts));
program
	.command('manager-cancel-withdraw')
	.description('Cancel a pending manager withdraw withdraw from your vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to view'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerCancelWithdraw(program, opts));
program
	.command('apply-profit-share-all')
	.description('Turn the profit share crank for all depositors')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to view'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--threshold <amount>',
			'Minimum threshold (in spot tokens) before profit share is applied'
		).default('1000', 'default is 1000')
	)
	.action((opts) => applyProfitShare(program, opts));
program
	.command('init-vault-depositor')
	.description(
		'Initialize a VaultDepositor for someone to deposit into your vault'
	)
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to create a VaultDepositor for'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--deposit-authority <depositAuthority>',
			'Authority to create the VaultDepositor for, only they can deposit in the vault.'
		).makeOptionMandatory(true)
	)
	.action((opts) => initVaultDepositor(program, opts));
program
	.command('deposit')
	.description(
		'Deposit into a vault via VaultDepositor (creates a VaultDepositor if one does not exist)'
	)
	.addOption(
		new Option(
			'--vault-depositor-address <vaultDepositorAddress>',
			'VaultDepositor address'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to deposit into'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--deposit-authority <vaultDepositorAuthority>',
			'VaultDepositor authority address'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--amount <amount>',
			'Amount to deposit (in deposit precision, 5 for 5 USDC)'
		).makeOptionMandatory(true)
	)
	.action((opts) => deposit(program, opts));
program
	.command('request-withdraw')
	.description(
		'Make a request to withdraw shares from the vaultm, redeem period starts now'
	)
	.addOption(
		new Option(
			'--vault-depositor-address <vaultDepositorAddress>',
			'VaultDepositor address'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to deposit into'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--authority <vaultDepositorAuthority>',
			'VaultDepositor authority address'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--amount <amount>',
			'Amount of shares to withdraw (raw format, as expected in the program)'
		).makeOptionMandatory(true)
	)
	.action((opts) => requestWithdraw(program, opts));
program
	.command('withdraw')
	.description('Initiate the withdraw, after the redeem period has passed')
	.addOption(
		new Option(
			'--vault-depositor-address <vaultDepositorAddress>',
			'VaultDepositor address'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to deposit into'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--authority <vaultDepositorAuthority>',
			'VaultDepositor authority address'
		).makeOptionMandatory(false)
	)
	.action((opts) => withdraw(program, opts));
program
	.command('force-withdraw')
	.description(
		'Forces the vault to send out a withdraw after the redeem period has passed'
	)
	.addOption(
		new Option(
			'--vault-depositor-address <vaultDepositorAddress>',
			'VaultDepositor address'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--vault-depositor-authority <vaultDepositorAuthority>',
			'Authority address of VaultDepositor, must also provide --vault-address'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--vault-address <vaultAddress>',
			'Address of vault, must required if only --vault-deposit-authority is provided'
		).makeOptionMandatory(false)
	)
	.action((opts) => forceWithdraw(program, opts));
program
	.command('force-withdraw-all')
	.description(
		'Processes all pending withdrawals that are ready to be redeemed'
	)
	.addOption(
		new Option(
			'--vault-address <vaultAddress>',
			'Address of vault, must required if only --vault-deposit-authority is provided'
		).makeOptionMandatory(true)
	)
	.action((opts) => forceWithdrawAll(program, opts));
program
	.command('decode-logs')
	.description('Decode program logs from a txid')
	.addOption(
		new Option('--tx <tx>', 'Transaction hash').makeOptionMandatory(true)
	)
	.action((opts) => decodeLogs(program, opts));
program
	.command('check-invariants')
	.description('Perform sanity checks on vault/depositor invariants')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Vault address'
		).makeOptionMandatory(true)
	)
	.addOption(new Option('--csv', 'Output to csv'))

	.action((opts) => vaultInvariantChecks(program, opts));

program
	.command('manager-update-fees')
	.description('Update vault fees for a manager')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to update'
		).makeOptionMandatory(true)
	)
	.option(
		'-t, --timelock-duration <number>',
		'The timelock before the new fees take effect, in seconds, minimum is max(7 days, 2x redeem period) (default: minimum duration)'
	)
	.option('-m, --management-fee <percent>', 'The new management fee percentage')
	.option('-s, --profit-share <percent>', 'The new profit share percentage')
	.option('-h, --hurdle-rate <percent>', 'The new hurdle rate percentage')
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerUpdateFees(program, opts));

program
	.command('admin-init-fee-update')
	.description('Admin initialize a fee update for a vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to initialize fee update for'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => adminInitFeeUpdate(program, opts));

program
	.command('admin-delete-fee-update')
	.description('Admin delete a fee update for a vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault to delete fee update for'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => adminDeleteFeeUpdate(program, opts));

program
	.command('manager-borrow')
	.description('Manager borrow from a spot market')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--borrow-spot-market-index <index>',
			'Spot market index to borrow from'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--borrow-amount <amount>',
			'Amount to borrow (in borrow precision, 5 for 5 USDC)'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--manager-token-account <address>',
			'Manager token account address (optional, ATA will be used if not provided)'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerBorrow(program, opts));

program
	.command('manager-repay')
	.description('Manager repay to a spot market')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--repay-spot-market-index <index>',
			'Spot market index to repay to'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--repay-amount <amount>',
			'Amount to repay (in repay market precision, 5 for 5 USDC)'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--repay-value <value>',
			'Value (in deposit precision, 5 for 5 USDC) of the repay (optional, if not provided will assume repaying the full outstanding amount)'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--manager-token-account <address>',
			'Manager token account address to receive repay tokens from (optional, ATA will be used if not provided)'
		).makeOptionMandatory(false)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerRepay(program, opts));

program
	.command('manager-update-borrow')
	.description('Update the manager borrow value for a vault')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--new-borrow-value <value>',
			'New borrow value (in deposit precision, 5 for 5 USDC)'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => managerUpdateBorrow(program, opts));

program
	.command('admin-update-vault-class')
	.description('Admin update the vault class')
	.addOption(
		new Option(
			'--vault-address <address>',
			'Address of the vault'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--vault-class <class>',
			'New vault class (trusted)'
		).makeOptionMandatory(true)
	)
	.addOption(
		new Option(
			'--dump-transaction-message',
			'Dump the transaction message to the console'
		).makeOptionMandatory(false)
	)
	.action((opts) => adminUpdateVaultClass(program, opts));

program.parseAsync().then(() => {
	process.exit(0);
});
