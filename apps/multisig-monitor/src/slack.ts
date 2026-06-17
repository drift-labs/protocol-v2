import type { SignerEvent } from './signer/types';
import type { DetectedOperation } from './squads/index';
import type { InnerCpi, SquadsOperation } from './squads/types';
import {
	configChangeDescription,
	displayName,
	emoji,
	memberRole,
	permissionLabels,
	truncateAddress,
} from './squads/types';

// ---------------------------------------------------------------------------
// Display config
// ---------------------------------------------------------------------------

export interface DisplayConfig {
	readonly showPermissions: boolean;
	readonly showTimestamps: boolean;
	readonly truncateAddresses: boolean;
}

// ---------------------------------------------------------------------------
// Slack Block Kit types
// ---------------------------------------------------------------------------

interface SlackPayload {
	readonly blocks: readonly SlackBlock[];
}

type SlackBlock =
	| {
			readonly type: 'header';
			readonly text: { readonly type: 'plain_text'; readonly text: string };
	  }
	| {
			readonly type: 'section';
			readonly text: { readonly type: 'mrkdwn'; readonly text: string };
	  }
	| { readonly type: 'divider' };

function header(text: string): SlackBlock {
	return { type: 'header', text: { type: 'plain_text', text } };
}

function section(text: string): SlackBlock {
	return { type: 'section', text: { type: 'mrkdwn', text } };
}

function divider(): SlackBlock {
	return { type: 'divider' };
}

function formatAddress(address: string, display: DisplayConfig): string {
	if (display.truncateAddresses) {
		return `${truncateAddress(address)} \`${address}\``;
	}
	return `\`${address}\``;
}

function formatTimestamp(blockTime: number): string {
	const date = new Date(blockTime * 1000);
	return date
		.toISOString()
		.replace('T', ' ')
		.replace(/\.\d{3}Z$/, ' UTC');
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

export function buildPayload(op: DetectedOperation, display: DisplayConfig): SlackPayload {
	const blocks: SlackBlock[] = [
		header(`${emoji(op.operation)} ${displayName(op.operation)}`),
		section(
			`*Multisig:* ${formatAddress(op.multisig, display)}\n*${memberRole(
				op.operation
			)}:* ${formatAddress(op.member, display)}`
		),
	];

	// Transaction and proposal addresses for correlation
	const refLines: string[] = [];
	if (op.transactionAddress) {
		refLines.push(`*Transaction:* ${formatAddress(op.transactionAddress, display)}`);
	}
	if (op.proposalAddress) {
		refLines.push(`*Proposal:* ${formatAddress(op.proposalAddress, display)}`);
	}
	if (refLines.length > 0) {
		blocks.push(section(refLines.join('\n')));
	}

	// Operation-specific details
	appendOperationDetails(blocks, op.operation, display);

	// Inner-CPI summary. For vault_transaction_create we render under
	// "What's proposed:" since execution hasn't happened yet; for execute
	// (and any other future kinds) we use "What it did:".
	if (op.enrichment && op.enrichment.innerCpis.length > 0) {
		const heading =
			op.operation.kind === 'vault_transaction_create' ? "What's proposed:" : 'What it did:';
		appendInnerCpis(blocks, op.enrichment.innerCpis, display, heading);
	}

	// Transaction signature with Solscan link
	blocks.push(section(`*Tx:* <https://solscan.io/tx/${op.signature}|${op.signature}>`));

	if (display.showTimestamps && op.blockTime) {
		blocks.push(section(`*Time:* ${formatTimestamp(op.blockTime)}`));
	}

	blocks.push(divider());

	return { blocks };
}

// ---------------------------------------------------------------------------
// Batch payload building
// ---------------------------------------------------------------------------

const MAX_BLOCKS_PER_MESSAGE = 50;

export function buildBatchPayload(
	ops: readonly DetectedOperation[],
	display: DisplayConfig
): SlackPayload[] {
	if (ops.length === 0) return [];

	const allBlocks: SlackBlock[] = [];
	for (const op of ops) {
		const { blocks } = buildPayload(op, display);
		allBlocks.push(...blocks);
	}

	// Chunk into multiple messages if we exceed Slack's 50-block limit
	const payloads: SlackPayload[] = [];
	for (let i = 0; i < allBlocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
		payloads.push({ blocks: allBlocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE) });
	}
	return payloads;
}

function appendInnerCpis(
	blocks: SlackBlock[],
	cpis: readonly InnerCpi[],
	display: DisplayConfig,
	heading: string
): void {
	const lines: string[] = [`*${heading}*`];

	for (const cpi of cpis) {
		const programLabel = display.truncateAddresses
			? `${truncateAddress(cpi.programId)} \`${cpi.programId}\``
			: `\`${cpi.programId}\``;

		if (cpi.decoded) {
			const argList =
				cpi.decoded.args.length === 0
					? ''
					: `\n${cpi.decoded.args
							.map((a) => `    · ${a.name}: \`${a.value}\``)
							.join('\n')}`;
			lines.push(`• ${programLabel} → *${cpi.decoded.name}*${argList}`);
		} else if (cpi.instructionName) {
			lines.push(`• ${programLabel} → ${cpi.instructionName}`);
		} else {
			lines.push(`• ${programLabel}`);
		}

		// Surface program logs as a separate code block. Catches Drift-style
		// "admin: A -> B" lines that wouldn't be in any IDL.
		const interestingLogs = cpi.programLogs.filter((l) => !l.startsWith('Instruction:'));
		if (interestingLogs.length > 0) {
			const truncated = interestingLogs.slice(0, 8);
			const more = interestingLogs.length - truncated.length;
			const block = truncated.map((l) => `    ${l}`).join('\n');
			lines.push(block);
			if (more > 0) lines.push(`    … (+${more} more)`);
		}
	}

	blocks.push(section(lines.join('\n')));
}

function appendOperationDetails(
	blocks: SlackBlock[],
	operation: SquadsOperation,
	display: DisplayConfig
): void {
	switch (operation.kind) {
		case 'config_transaction_create': {
			if (operation.actions.length > 0) {
				const lines = operation.actions.map((a) => `• ${configChangeDescription(a)}`);
				blocks.push(section(`*Config Actions:*\n${lines.join('\n')}`));
			}
			break;
		}

		case 'multisig_create': {
			const memberLines = operation.members.map(
				(m) =>
					`• ${formatAddress(m.key, display)} (${permissionLabels(m.permissions).join(
						', '
					)})`
			);
			const authority = operation.configAuthority
				? formatAddress(operation.configAuthority, display)
				: 'None (autonomous)';
			blocks.push(
				section(
					`*Threshold:* ${
						operation.threshold
					}\n*Config Authority:* ${authority}\n*Members:*\n${memberLines.join('\n')}`
				)
			);
			break;
		}

		case 'multisig_add_member': {
			const perms = permissionLabels(operation.newMember.permissions).join(', ');
			blocks.push(
				section(
					`*New Member:* ${formatAddress(
						operation.newMember.key,
						display
					)}\n*Permissions:* ${perms}`
				)
			);
			break;
		}

		case 'multisig_remove_member':
			blocks.push(
				section(`*Removed Member:* ${formatAddress(operation.oldMember, display)}`)
			);
			break;

		case 'multisig_change_threshold':
			blocks.push(section(`*New Threshold:* ${operation.newThreshold}`));
			break;

		case 'multisig_set_time_lock':
			blocks.push(section(`*Time Lock:* ${operation.timeLock}s`));
			break;

		case 'multisig_set_config_authority':
			blocks.push(
				section(
					`*New Config Authority:* ${formatAddress(operation.configAuthority, display)}`
				)
			);
			break;

		case 'multisig_set_rent_collector': {
			const value = operation.rentCollector
				? formatAddress(operation.rentCollector, display)
				: 'None (removed)';
			blocks.push(section(`*Rent Collector:* ${value}`));
			break;
		}

		case 'multisig_add_spending_limit':
			blocks.push(
				section(
					`*Amount:* ${operation.amount}\n*Mint:* ${formatAddress(
						operation.mint,
						display
					)}\n*Vault:* ${operation.vaultIndex}`
				)
			);
			break;

		case 'spending_limit_use':
			blocks.push(section(`*Amount:* ${operation.amount} (decimals: ${operation.decimals})`));
			break;

		case 'proposal_create':
			if (operation.draft) {
				blocks.push(section('*Status:* Draft'));
			}
			break;

		default:
			break;
	}
}

// ---------------------------------------------------------------------------
// Signer-event rendering
// ---------------------------------------------------------------------------

function buildSignerEventBlocks(event: SignerEvent, display: DisplayConfig): SlackBlock[] {
	switch (event.kind) {
		case 'nonce_account_targeting_signer': {
			const funderKnown = event.funder !== null;
			const selfFunded = funderKnown && event.funder === event.targetedSigner;
			const headerText = selfFunded
				? '\u{1f6a8} Council Signer Created Their Own Nonce Account'
				: '\u{1f6a8} Nonce Account Created Targeting Council Signer';
			const funderLine = funderKnown
				? `*Funder (tx signer):* ${formatAddress(event.funder!, display)}`
				: '*Funder (tx signer):* unknown (account-stream alert; tx not observed)';
			const compromiseWarning = funderKnown
				? selfFunded
					? ''
					: '\n*\u{26a0}\u{fe0f} Funder differs from targeted signer — possible compromise.*'
				: '\n*\u{26a0}\u{fe0f} Possible compromise — investigate the originating transaction.*';
			const blocks: SlackBlock[] = [
				header(headerText),
				section(
					`*Targeted Signer:* ${formatAddress(event.targetedSigner, display)}\n` +
						`${funderLine}\n` +
						`*Nonce Account:* ${formatAddress(event.nonceAccount, display)}` +
						compromiseWarning
				),
			];
			if (event.signature) {
				blocks.push(
					section(`*Tx:* <https://solscan.io/tx/${event.signature}|${event.signature}>`)
				);
			} else {
				blocks.push(section(`*Tx:* not yet observed (account update only)`));
			}
			if (display.showTimestamps && event.blockTime) {
				blocks.push(section(`*Time:* ${formatTimestamp(event.blockTime)}`));
			}
			blocks.push(divider());
			return blocks;
		}
	}
}

export function buildSignerBatchPayload(
	events: readonly SignerEvent[],
	display: DisplayConfig
): SlackPayload[] {
	if (events.length === 0) return [];
	const allBlocks: SlackBlock[] = [];
	for (const event of events) {
		allBlocks.push(...buildSignerEventBlocks(event, display));
	}
	const payloads: SlackPayload[] = [];
	for (let i = 0; i < allBlocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
		payloads.push({ blocks: allBlocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE) });
	}
	return payloads;
}

// ---------------------------------------------------------------------------
// Send notifications
// ---------------------------------------------------------------------------

export async function sendBatchNotification(
	ops: readonly DetectedOperation[],
	webhookUrl: string,
	display: DisplayConfig
): Promise<void> {
	await postPayloads(buildBatchPayload(ops, display), webhookUrl);
}

export async function sendSignerEvents(
	events: readonly SignerEvent[],
	webhookUrl: string,
	display: DisplayConfig
): Promise<void> {
	await postPayloads(buildSignerBatchPayload(events, display), webhookUrl);
}

async function postPayloads(payloads: readonly SlackPayload[], webhookUrl: string): Promise<void> {
	for (const payload of payloads) {
		const body = JSON.stringify(payload);

		const resp = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});

		if (resp.ok) continue;

		// Retry once on transient errors (rate limit or server error)
		if (resp.status === 429 || resp.status >= 500) {
			await sleep(1000);
			const retry = await fetch(webhookUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
			});
			if (!retry.ok) {
				throw new Error(`slack returned status ${retry.status} after retry`);
			}
			continue;
		}

		throw new Error(`slack returned status ${resp.status}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
