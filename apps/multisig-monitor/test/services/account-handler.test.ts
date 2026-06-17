/**
 * Tests for the account-stream handler. We mock the slack module so we can
 * assert exactly which deliveries fire under each (isStartup × alreadySeen)
 * combination — this is the gate that prevents alert spam on first connect.
 */
const mockSendSignerEvents = jest.fn();
jest.mock('../../src/slack', () => ({
	sendSignerEvents: (...args: unknown[]) => mockSendSignerEvents(...args),
}));

import bs58 from 'bs58';
import type { SubscribeUpdate } from '@triton-one/yellowstone-fumarole';
import { handleAccountUpdate } from '../../src/services/account-handler';
import type { Config } from '../../src/config';
import type { StateStore } from '../../src/services/state';

const COUNCIL = '39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8';
const NONCE_ACCOUNT = '7s7s6saC5LHZoLyBXLM3pCjpWaA7meyQdP8NiH9ktAeC';
const UNRELATED = '9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeAccountUpdate(opts: {
	pubkey: string;
	authority: string;
	isStartup: boolean;
	txnSignature?: string;
}): SubscribeUpdate {
	const data = new Uint8Array(80);
	// Bytes [8..40) = nonce authority pubkey (matches account-handler offset).
	data.set(bs58.decode(opts.authority), 8);
	return {
		filters: [`council-nonce-${opts.authority}`],
		createdAt: undefined,
		account: {
			slot: 100n,
			isStartup: opts.isStartup,
			account: {
				pubkey: bs58.decode(opts.pubkey),
				lamports: 1500000n,
				owner: bs58.decode('11111111111111111111111111111111'),
				executable: false,
				rentEpoch: 0n,
				data,
				writeVersion: 1n,
				txnSignature: opts.txnSignature ? new Uint8Array(64).fill(1) : undefined,
			},
		},
	};
}

const mockStore = (): StateStore & {
	signatures: Map<string, true>;
	nonces: Map<string, true>;
} => {
	const signatures = new Map<string, true>();
	const nonces = new Map<string, true>();
	return {
		signatures,
		nonces,
		async markSignatureSeen(s: string) {
			const seen = signatures.has(s);
			signatures.set(s, true);
			return seen;
		},
		async markNonceAccountSeen(n: string) {
			const seen = nonces.has(n);
			nonces.set(n, true);
			return seen;
		},
	};
};

const baseConfig: Config = {
	multisigAddresses: [],
	signerAddresses: [COUNCIL],
	slackWebhookUrl: 'https://slack.example/webhook',
	filter: { instructionTypes: [], configTypes: [] },
	display: { showPermissions: false, showTimestamps: false, truncateAddresses: false },
	logLevel: 'error',
	routes: new Map(),
	rpcUrl: null,
	fumarole: {
		endpoint: '',
		xToken: '',
		subscriberName: 'test',
		maxSlotDifference: 500,
		startFromTip: false,
		fromSlot: undefined,
	},
	state: { tableName: 'test', signatureTtlSeconds: 86400 },
	healthPort: 3000,
};

beforeEach(() => {
	mockSendSignerEvents.mockReset();
	mockSendSignerEvents.mockResolvedValue(undefined);
});

describe('handleAccountUpdate', () => {
	it('writes snapshot updates to seen-nonces but does NOT alert', async () => {
		const store = mockStore();
		const update = makeAccountUpdate({
			pubkey: NONCE_ACCOUNT,
			authority: COUNCIL,
			isStartup: true,
		});

		await handleAccountUpdate(update, baseConfig, store);

		expect(store.nonces.has(NONCE_ACCOUNT)).toBe(true);
		expect(mockSendSignerEvents).not.toHaveBeenCalled();
	});

	it('alerts on a post-snapshot delta for an unknown nonce account', async () => {
		const store = mockStore();
		const update = makeAccountUpdate({
			pubkey: NONCE_ACCOUNT,
			authority: COUNCIL,
			isStartup: false,
			txnSignature: 'sig-bytes',
		});

		await handleAccountUpdate(update, baseConfig, store);

		expect(store.nonces.has(NONCE_ACCOUNT)).toBe(true);
		expect(mockSendSignerEvents).toHaveBeenCalledTimes(1);
		const [events, url] = mockSendSignerEvents.mock.calls[0]!;
		expect(url).toBe(baseConfig.slackWebhookUrl);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: 'nonce_account_targeting_signer',
			nonceAccount: NONCE_ACCOUNT,
			targetedSigner: COUNCIL,
			funder: null,
		});
		expect(events[0].signature).toBeTruthy();
	});

	it('does NOT alert on a post-snapshot delta if the nonce was already seen', async () => {
		const store = mockStore();
		store.nonces.set(NONCE_ACCOUNT, true);

		const update = makeAccountUpdate({
			pubkey: NONCE_ACCOUNT,
			authority: COUNCIL,
			isStartup: false,
		});

		await handleAccountUpdate(update, baseConfig, store);
		expect(mockSendSignerEvents).not.toHaveBeenCalled();
	});

	it('skips updates whose authority is not in the watched signer list', async () => {
		const store = mockStore();
		const update = makeAccountUpdate({
			pubkey: NONCE_ACCOUNT,
			authority: UNRELATED,
			isStartup: false,
		});

		await handleAccountUpdate(update, baseConfig, store);
		expect(store.nonces.has(NONCE_ACCOUNT)).toBe(false);
		expect(mockSendSignerEvents).not.toHaveBeenCalled();
	});

	it('skips updates whose data length is not 80 (defensive)', async () => {
		const store = mockStore();
		const update = makeAccountUpdate({
			pubkey: NONCE_ACCOUNT,
			authority: COUNCIL,
			isStartup: false,
		});
		// Truncate the data field after construction.
		update.account!.account!.data = new Uint8Array(40);

		await handleAccountUpdate(update, baseConfig, store);
		expect(mockSendSignerEvents).not.toHaveBeenCalled();
	});

	it('emits an empty signature when txnSignature is absent', async () => {
		const store = mockStore();
		const update = makeAccountUpdate({
			pubkey: NONCE_ACCOUNT,
			authority: COUNCIL,
			isStartup: false,
		});
		// txnSignature defaults to undefined when not specified above.

		await handleAccountUpdate(update, baseConfig, store);
		expect(mockSendSignerEvents).toHaveBeenCalledTimes(1);
		const [events] = mockSendSignerEvents.mock.calls[0]!;
		expect(events[0].signature).toBe('');
	});
});
