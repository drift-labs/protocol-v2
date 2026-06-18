import {
	BlockhashSubscriber,
	ConstituentMap,
	DriftClient,
	getConstituentTargetBasePublicKey,
	getLpPoolPublicKey,
	LPPoolAccount,
	PriorityFeeMethod,
	PriorityFeeSubscriber,
} from '@drift-labs/sdk';
import { ComputeBudgetProgram } from '@solana/web3.js';
import { simulateAndGetTxWithCUs } from '../../utils';

export class LpPoolTargetBaseCranker {
	interval: NodeJS.Timeout | null = null;
	lpPoolAccount?: LPPoolAccount;
	constituentMap: ConstituentMap;

	priorityFeeSubscriber: PriorityFeeSubscriber;
	blockhashSubscriber: BlockhashSubscriber;

	public constructor(
		private driftClient: DriftClient,
		private intervalMs: number,
		private lpPoolId: number
	) {
		this.constituentMap = new ConstituentMap({
			driftClient: this.driftClient,
			subscriptionConfig: {
				type: 'websocket',
				resubTimeoutMs: 30_000,
			},
			lpPoolId: lpPoolId,
		});
		this.priorityFeeSubscriber = new PriorityFeeSubscriber({
			connection: this.driftClient.connection,
			frequencyMs: 30_000,
			addresses: [
				getConstituentTargetBasePublicKey(
					this.driftClient.program.programId,
					getLpPoolPublicKey(this.driftClient.program.programId, this.lpPoolId)
				),
			],
			priorityFeeMethod: PriorityFeeMethod.SOLANA,
			slotsToCheck: 10,
		});

		this.blockhashSubscriber = new BlockhashSubscriber({
			connection: this.driftClient.connection,
		});
	}

	async init() {
		await this.constituentMap.sync();
		await this.constituentMap.subscribe();
		this.lpPoolAccount = await this.driftClient.getLpPoolAccount(this.lpPoolId);
		await this.blockhashSubscriber.subscribe();
		await this.priorityFeeSubscriber.subscribe();
		await this.startInterval();
	}

	public async healthCheck() {
		return true;
	}

	private async getBlockhashForTx(): Promise<string> {
		const cachedBlockhash = this.blockhashSubscriber.getLatestBlockhash(5);
		if (cachedBlockhash) {
			return cachedBlockhash.blockhash as string;
		}

		const recentBlockhash =
			await this.driftClient.connection.getLatestBlockhash({
				commitment: 'confirmed',
			});

		return recentBlockhash.blockhash;
	}

	async startInterval() {
		setInterval(async () => {
			this.lpPoolAccount = await this.driftClient.getLpPoolAccount(
				this.lpPoolId
			);
		}, 10_000);

		this.interval = setInterval(async () => {
			const perpMarkets = this.driftClient.getPerpMarketAccounts();
			const marketIndexes = perpMarkets
				.filter((market) => market.lpStatus == 1)
				.map((market) => market.marketIndex);
			if (marketIndexes.length === 0) {
				console.warn(
					`No markets found with LP status for pool ${this.lpPoolId}. Skipping update.`
				);
				return;
			}
			if (!this.lpPoolAccount) {
				this.lpPoolAccount = await this.driftClient.getLpPoolAccount(
					this.lpPoolId
				);
			}
			const ixs = [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 1_400_000, // will be overridden by simulateTx
				}),
			];
			ixs.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: Math.floor(
						this.priorityFeeSubscriber.getCustomStrategyResult() *
							this.driftClient.txSender.getSuggestedPriorityFeeMultiplier()
					),
				})
			);
			const updateIxs =
				await this.driftClient.getAllUpdateConstituentTargetBaseIxs(
					marketIndexes,
					this.lpPoolAccount,
					this.constituentMap,
					true
				);
			ixs.push(...updateIxs);
			const simResult = await simulateAndGetTxWithCUs({
				ixs,
				connection: this.driftClient.connection,
				payerPublicKey: this.driftClient.wallet.publicKey,
				lookupTableAccounts:
					await this.driftClient.fetchAllLookupTableAccounts(),
				cuLimitMultiplier: 1.5,
				doSimulation: true,
				recentBlockhash: await this.getBlockhashForTx(),
			});

			if (simResult.simError) {
				console.log(simResult.simTxLogs);
				return;
			}

			this.driftClient.txSender
				.sendVersionedTransaction(simResult.tx)
				.then((response) => {
					console.log(response);
				})
				.catch((error) => {
					console.log(error);
				});
		}, this.intervalMs);
	}
}
