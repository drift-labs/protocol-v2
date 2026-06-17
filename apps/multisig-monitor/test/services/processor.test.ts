/**
 * Processor cross-batch dedup tests. We mock both slack and the converter so
 * we can drive the dedup gate directly without constructing fake Yellowstone
 * payloads. The test focuses on the seen-signatures contract: a sig that the
 * store reports as already seen must not produce slack deliveries.
 */
const mockSendBatchNotification = jest.fn();
const mockSendSignerEvents = jest.fn();
jest.mock('../../src/slack', () => ({
	sendBatchNotification: (...args: unknown[]) => mockSendBatchNotification(...args),
	sendSignerEvents: (...args: unknown[]) => mockSendSignerEvents(...args),
}));

const mockYellowstoneToRawTransaction = jest.fn();
jest.mock('../../src/services/converter', () => ({
	yellowstoneToRawTransaction: (...args: unknown[]) => mockYellowstoneToRawTransaction(...args),
}));

const mockExtractOperations = jest.fn();
jest.mock('../../src/squads/index', () => ({
	extractOperations: (...args: unknown[]) => mockExtractOperations(...args),
}));

const mockExtractSignerEvents = jest.fn();
jest.mock('../../src/signer/extractor', () => ({
	extractSignerEvents: (...args: unknown[]) => mockExtractSignerEvents(...args),
}));

import type { Config } from '../../src/config';
import { processTransactions } from '../../src/services/processor';
import type { StateStore } from '../../src/services/state';

const SIG_NEW = 'sig-new-1111111111';
const SIG_SEEN = 'sig-already-seen-22';

const baseConfig: Config = {
	multisigAddresses: ['msig1'],
	signerAddresses: ['signer1'],
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

const mockStore = (preSeen: string[] = []): StateStore & { seen: Set<string> } => {
	const seen = new Set(preSeen);
	return {
		seen,
		async markSignatureSeen(s: string) {
			const already = seen.has(s);
			seen.add(s);
			return already;
		},
		async markNonceAccountSeen() {
			return false;
		},
	};
};

beforeEach(() => {
	mockSendBatchNotification.mockReset().mockResolvedValue(undefined);
	mockSendSignerEvents.mockReset().mockResolvedValue(undefined);
	mockYellowstoneToRawTransaction.mockReset();
	mockExtractOperations.mockReset();
	mockExtractSignerEvents.mockReset();
});

describe('processTransactions cross-batch dedup', () => {
	it('dispatches alerts for new signatures and marks them seen', async () => {
		const store = mockStore();
		mockYellowstoneToRawTransaction.mockReturnValue({ signature: SIG_NEW });
		mockExtractOperations.mockResolvedValue([
			{
				signature: SIG_NEW,
				multisig: 'msig1',
				member: 'm',
				transactionAddress: null,
				proposalAddress: null,
				operation: { kind: 'proposal_approve' },
				blockTime: null,
			},
		]);
		mockExtractSignerEvents.mockReturnValue([]);

		await processTransactions([{}] as any, baseConfig, store);

		expect(mockSendBatchNotification).toHaveBeenCalledTimes(1);
		const [ops, url] = mockSendBatchNotification.mock.calls[0]!;
		expect(ops).toHaveLength(1);
		expect(url).toBe(baseConfig.slackWebhookUrl);
		expect(store.seen.has(SIG_NEW)).toBe(true);
	});

	it('drops ops whose signature was already in the seen-signatures store', async () => {
		const store = mockStore([SIG_SEEN]);
		mockYellowstoneToRawTransaction.mockReturnValue({ signature: SIG_SEEN });
		mockExtractOperations.mockResolvedValue([
			{
				signature: SIG_SEEN,
				multisig: 'msig1',
				member: 'm',
				transactionAddress: null,
				proposalAddress: null,
				operation: { kind: 'proposal_approve' },
				blockTime: null,
			},
		]);
		mockExtractSignerEvents.mockReturnValue([]);

		await processTransactions([{}] as any, baseConfig, store);

		expect(mockSendBatchNotification).not.toHaveBeenCalled();
	});

	it('drops both ops AND signer events when the sig was already seen', async () => {
		const store = mockStore([SIG_SEEN]);
		mockYellowstoneToRawTransaction.mockReturnValue({ signature: SIG_SEEN });
		mockExtractOperations.mockResolvedValue([
			{
				signature: SIG_SEEN,
				multisig: 'msig1',
				member: 'm',
				transactionAddress: null,
				proposalAddress: null,
				operation: { kind: 'proposal_approve' },
				blockTime: null,
			},
		]);
		mockExtractSignerEvents.mockReturnValue([
			{
				signature: SIG_SEEN,
				blockTime: null,
				kind: 'nonce_account_targeting_signer',
				targetedSigner: 'signer1',
				funder: 'attacker',
				nonceAccount: 'nonce1',
			},
		]);

		await processTransactions([{}] as any, baseConfig, store);

		expect(mockSendBatchNotification).not.toHaveBeenCalled();
		expect(mockSendSignerEvents).not.toHaveBeenCalled();
	});

	it('sends signer events for new sigs even if no ops match', async () => {
		const store = mockStore();
		mockYellowstoneToRawTransaction.mockReturnValue({ signature: SIG_NEW });
		mockExtractOperations.mockResolvedValue([]);
		mockExtractSignerEvents.mockReturnValue([
			{
				signature: SIG_NEW,
				blockTime: null,
				kind: 'nonce_account_targeting_signer',
				targetedSigner: 'signer1',
				funder: 'attacker',
				nonceAccount: 'nonce1',
			},
		]);

		await processTransactions([{}] as any, baseConfig, store);

		expect(mockSendSignerEvents).toHaveBeenCalledTimes(1);
		expect(mockSendBatchNotification).not.toHaveBeenCalled();
		expect(store.seen.has(SIG_NEW)).toBe(true);
	});
});
