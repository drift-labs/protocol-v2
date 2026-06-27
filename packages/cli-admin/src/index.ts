#!/usr/bin/env node
import { Command } from 'commander';
import { registerAuth } from './commands/auth';
import { registerCall } from './commands/call';
import { registerExchange } from './commands/exchange';
import { registerFees } from './commands/fees';
import { registerMultisig } from './commands/multisig';
import { registerPerpMarket } from './commands/perpMarket';
import { registerProgram } from './commands/program';
import { registerShow } from './commands/show';
import { registerSpotMarket } from './commands/spotMarket';
import { registerUser } from './commands/user';

const program = new Command();

program
	.name('velocity-admin')
	.description(
		[
			'Velocity v2 admin CLI.',
			'',
			'Each subcommand builds the appropriate instruction(s) and either signs them',
			'with --keypair (default) or, with --multisig <pda>, wraps them in a Squads V4',
			'vault transaction + proposal. Tier (cold / warm / hot) is enforced on-chain;',
			'whatever signs is what gets checked, so you choose the tier by choosing the',
			'key (or multisig) you pass — not by which command you run.',
		].join('\n')
	)
	.version('0.1.0')
	.showHelpAfterError()
	.showSuggestionAfterError();

registerShow(program);
registerAuth(program);
registerPerpMarket(program);
registerSpotMarket(program);
registerExchange(program);
registerFees(program);
registerMultisig(program);
registerUser(program);
registerProgram(program);
registerCall(program);

program.parseAsync(process.argv).catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
