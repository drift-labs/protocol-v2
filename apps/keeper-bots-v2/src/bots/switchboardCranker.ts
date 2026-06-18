import { Bot } from '../types';
import { logger } from '../logger';
import { GlobalConfig, SwitchboardCrankerBotConfig } from '../config';
import {
	BlockhashSubscriber,
	DriftClient,
	PriorityFeeSubscriber,
	SlothashSubscriber,
	TxSigAndSlot,
} from '@drift-labs/sdk';
import { BundleSender } from '../bundleSender';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import { chunks, getVersionedTransaction, shuffle, sleepMs } from '../utils';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
	new Agent({
		connections: 200,
	})
);

// ref: https://solscan.io/tx/Z5X334CFBmzbzxXHgfa49UVbMdLZf7nJdDCekjaZYinpykVqgTm47VZphazocMjYe1XJtEyeiL6QgrmvLeMesMA
const MIN_CU_LIMIT = 50_000;

export class SwitchboardCrankerBot implements Bot {
	public name: string;
	public dryRun: boolean;
	public defaultIntervalMs: number;

	private blockhashSubscriber: BlockhashSubscriber;
	private slothashSubscriber: SlothashSubscriber;

	private numFeedsPerIx = 5;

	constructor(
		private globalConfig: GlobalConfig,
		private crankConfigs: SwitchboardCrankerBotConfig,
		private driftClient: DriftClient,
		private priorityFeeSubscriber?: PriorityFeeSubscriber,
		private bundleSender?: BundleSender,
		private lookupTableAccounts: AddressLookupTableAccount[] = []
	) {
		this.name = crankConfigs.botId;
		this.dryRun = crankConfigs.dryRun;
		this.defaultIntervalMs = crankConfigs.intervalMs || 10_000;
		this.blockhashSubscriber = new BlockhashSubscriber({
			connection: driftClient.connection,
		});

		this.slothashSubscriber = new SlothashSubscriber(
			this.driftClient.connection,
			{
				commitment: 'confirmed',
			}
		);
	}

	async init(): Promise<void> {
		logger.info(`Initializing ${this.name} bot`);
		await this.blockhashSubscriber.subscribe();
		this.lookupTableAccounts.push(
			...(await this.driftClient.fetchAllLookupTableAccounts())
		);
		await this.slothashSubscriber.subscribe();

		const writableAccounts =
			this.crankConfigs.writableAccounts &&
			this.crankConfigs.writableAccounts.length > 0
				? this.crankConfigs.writableAccounts.map((acc) => new PublicKey(acc))
				: [];
		this.priorityFeeSubscriber?.updateAddresses([
			...Object.entries(this.crankConfigs.pullFeedConfigs).map(
				([_alias, config]) => {
					return new PublicKey(config.pubkey);
				}
			),
			...writableAccounts,
		]);
	}

	async reset(): Promise<void> {
		logger.info(`Resetting ${this.name} bot`);
		this.blockhashSubscriber.unsubscribe();
		await this.driftClient.unsubscribe();
	}

	async startIntervalLoop(intervalMs = this.defaultIntervalMs): Promise<void> {
		logger.info(`Starting ${this.name} bot with interval ${intervalMs} ms`);
		await sleepMs(5000);
		await this.runCrankLoop();

		setInterval(async () => {
			await this.runCrankLoop();
		}, intervalMs);
	}

	private async getBlockhashForTx(): Promise<string> {
		const cachedBlockhash = this.blockhashSubscriber.getLatestBlockhash(10);
		if (cachedBlockhash) {
			return cachedBlockhash.blockhash as string;
		}

		const recentBlockhash =
			await this.driftClient.connection.getLatestBlockhash({
				commitment: 'confirmed',
			});

		return recentBlockhash.blockhash;
	}

	private shouldBuildForBundle(): boolean {
		if (!this.globalConfig.useJito) {
			return false;
		}
		if (!this.bundleSender?.connected()) {
			return false;
		}
		return true;
	}

	async runCrankLoop() {
		const pullFeedAliases = chunks(
			shuffle(Object.keys(this.crankConfigs.pullFeedConfigs)),
			this.numFeedsPerIx
		);
		for (const aliasChunk of pullFeedAliases) {
			try {
				console.log(aliasChunk);
				const switchboardIxs =
					await this.driftClient.getPostManySwitchboardOnDemandUpdatesAtomicIxs(
						aliasChunk.map(
							(alias) =>
								new PublicKey(this.crankConfigs.pullFeedConfigs[alias].pubkey)
						)
					);
				if (!switchboardIxs) {
					logger.error(`No switchboardIxs for ${aliasChunk}`);
					continue;
				}
				const ixs = [
					...switchboardIxs,
					ComputeBudgetProgram.setComputeUnitLimit({
						units: MIN_CU_LIMIT,
					}),
				];

				const shouldBuildForBundle = this.shouldBuildForBundle();
				if (shouldBuildForBundle) {
					ixs.push(this.bundleSender!.getTipIx());
				} else {
					const priorityFees =
						this.priorityFeeSubscriber?.getHeliusPriorityFeeLevel() || 0;
					ixs.push(
						ComputeBudgetProgram.setComputeUnitPrice({
							microLamports: Math.floor(priorityFees),
						})
					);
				}

				const tx = getVersionedTransaction(
					this.driftClient.wallet.publicKey,
					ixs,
					this.lookupTableAccounts,
					await this.getBlockhashForTx()
				);

				if (shouldBuildForBundle) {
					tx.sign([
						// @ts-ignore;
						this.driftClient.wallet.payer,
					]);
					this.bundleSender?.sendTransactions(
						[tx],
						undefined,
						undefined,
						false
					);
				} else {
					this.driftClient
						.sendTransaction(tx)
						.then((txSigAndSlot: TxSigAndSlot) => {
							logger.info(
								`Posted update sb atomic tx for ${aliasChunk}: ${txSigAndSlot.txSig}`
							);
						})
						.catch((e) => {
							console.log(e);
						});
				}
			} catch (e) {
				this.numFeedsPerIx = Math.max(2, this.numFeedsPerIx - 1);
				logger.error(`Error processing alias ${aliasChunk}: ${e}`);
			}
		}
	}

	async getPullIx(alias: string): Promise<TransactionInstruction | undefined> {
		const pubkey = new PublicKey(
			this.crankConfigs.pullFeedConfigs[alias].pubkey
		);
		const pullIx =
			await this.driftClient.getPostSwitchboardOnDemandUpdateAtomicIx(
				pubkey,
				this.slothashSubscriber.currentSlothash
			);
		if (!pullIx) {
			logger.error(`No pullIx for ${alias}`);
			return;
		}
		return pullIx;
	}

	async healthCheck(): Promise<boolean> {
		return true;
	}
}
