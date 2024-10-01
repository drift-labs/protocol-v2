import { Commitment, Connection, SignatureStatus } from '@solana/web3.js';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

interface TransactionConfirmationRequest {
	txSig: string;
	desiredConfirmationStatus: Commitment;
	timeout: number;
	pollInterval: number;
	searchTransactionHistory: boolean;
	startTime: number;
	resolve: (status: SignatureStatus) => void;
	reject: (error: Error) => void;
}

/**
 * Class to await for transaction confirmations in an optimised manner. It tracks a shared list of all pending transactions and fetches them in bulk in a shared RPC request whenever they have an "overlapping" polling interval. E.g. tx1 with an interval of 200ms and tx2 with an interval of 300ms (if sent at the same time) will be fetched together at at 600ms, 1200ms, 1800ms, etc.
 */
export class TransactionConfirmationManager {
	private connection: Connection;
	private pendingConfirmations: Map<string, TransactionConfirmationRequest> =
		new Map();
	private intervalId: NodeJS.Timeout | null = null;

	constructor(connection: Connection) {
		this.connection = connection;
	}

	async confirmTransaction(
		txSig: string,
		desiredConfirmationStatus = DEFAULT_CONFIRMATION_OPTS.commitment,
		timeout = 30000,
		pollInterval = 1000,
		searchTransactionHistory = false
	): Promise<SignatureStatus> {
		// Interval must be > 400ms and a multiple of 100ms
		if (pollInterval < 400 || pollInterval % 100 !== 0) {
			throw new Error(
				'Transaction confirmation polling interval must be at least 400ms and a multiple of 100ms'
			);
		}

		return new Promise((resolve, reject) => {
			this.pendingConfirmations.set(txSig, {
				txSig,
				desiredConfirmationStatus,
				timeout,
				pollInterval,
				searchTransactionHistory,
				startTime: Date.now(),
				resolve,
				reject,
			});

			if (!this.intervalId) {
				this.startConfirmationLoop();
			}
		});
	}

	private startConfirmationLoop() {
		this.intervalId = setInterval(() => this.checkPendingConfirmations(), 100);
	}

	private async checkPendingConfirmations() {
		const now = Date.now();
		const transactionsToCheck: TransactionConfirmationRequest[] = [];

		for (const [txSig, request] of this.pendingConfirmations.entries()) {
			if (now - request.startTime >= request.timeout) {
				request.reject(
					new Error(
						`Transaction confirmation timeout after ${request.timeout}ms`
					)
				);
				this.pendingConfirmations.delete(txSig);
			} else if ((now - request.startTime) % request.pollInterval < 100) {
				transactionsToCheck.push(request);
			}
		}

		if (transactionsToCheck.length > 0) {
			await this.checkTransactionStatuses(transactionsToCheck);
		}

		if (this.pendingConfirmations.size === 0 && this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	private async checkTransactionStatuses(
		requests: TransactionConfirmationRequest[]
	) {
		const txSigs = requests.map((request) => request.txSig);
		const { value: statuses } = await this.connection.getSignatureStatuses(
			txSigs,
			{
				searchTransactionHistory: requests.some(
					(req) => req.searchTransactionHistory
				),
			}
		);

		if (!statuses || statuses.length !== txSigs.length) {
			throw new Error('Failed to get signature statuses');
		}

		for (let i = 0; i < statuses.length; i++) {
			const status = statuses[i];
			const request = requests[i];

			if (status === null) {
				continue;
			}

			if (status.err) {
				request.reject(
					new Error(`Transaction failed: ${JSON.stringify(status.err)}`)
				);
				this.pendingConfirmations.delete(request.txSig);
				continue;
			}

			if (
				status.confirmationStatus &&
				(status.confirmationStatus === request.desiredConfirmationStatus ||
					status.confirmationStatus === 'finalized')
			) {
				request.resolve(status);
				this.pendingConfirmations.delete(request.txSig);
			}
		}
	}
}
