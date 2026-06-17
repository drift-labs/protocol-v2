import { ConfirmOptions, Connection } from '@solana/web3.js';
import { logger } from '../../logger';
import { WhileValidTxSender } from '@drift-labs/sdk';

export class JetProxyTxSender extends WhileValidTxSender {
	private submitConnections: Connection[];

	constructor(
		args: ConstructorParameters<typeof WhileValidTxSender>[0] & {
			submitConnections?: Connection[];
		}
	) {
		const { submitConnections, ...baseArgs } = args;

		super(baseArgs);

		if (submitConnections && submitConnections.length > 0) {
			this.submitConnections = submitConnections;
		} else {
			throw new Error(
				'JetProxySender requires submitConnections or submitConnection'
			);
		}
	}

	private async sendToSubmitConnections(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<string> {
		const start = performance.now();
		const attempts = this.submitConnections.map((connection) =>
			connection
				.sendRawTransaction(rawTransaction, opts)
				.then((txSig) => {
					logger.info(
						`${connection.rpcEndpoint}: ${txSig} ${(
							(performance.now() - start) /
							1000
						).toFixed(4)}s`
					);
					return txSig;
				})
				.catch((err) => {
					console.error(`Failed to send transaction to ${connection}:`, err);
					throw err;
				})
		);

		try {
			const firstSig = await Promise.any(attempts);
			return firstSig;
		} catch {
			throw new Error('Failed to send transaction to any submit connection');
		}
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	) {
		const startTime = this.getTimestamp();

		const txid = await this.sendToSubmitConnections(rawTransaction, opts);

		this.txSigCache?.set(txid, false);
		this.sendToAdditionalConnections(rawTransaction, opts);

		let done = false;
		const resolveReference: { resolve?: () => void } = {};
		const stopWaiting = () => {
			done = true;
			resolveReference.resolve?.();
		};

		(async () => {
			while (!done && this.getTimestamp() - startTime < this.timeout) {
				await new Promise<void>((resolve) => {
					resolveReference.resolve = resolve;
					setTimeout(resolve, this.retrySleep);
				});
				if (!done) {
					try {
						await this.sendToSubmitConnections(rawTransaction, opts);
						this.sendToAdditionalConnections(rawTransaction, opts);
					} catch (e) {
						console.error(e);
						stopWaiting();
					}
				}
			}
		})();

		let slot: number;
		try {
			const result = await this.confirmTransaction(txid, opts.commitment);

			this.txSigCache?.set(txid, true);
			await this.checkConfirmationResultForError(txid, result?.value);

			if (result?.value?.err && this.throwOnTransactionError) {
				throw new Error(`Transaction Failed: ${txid}`);
			}

			slot = result?.context?.slot;
		} finally {
			stopWaiting();
		}

		return { txSig: txid, slot };
	}
}
