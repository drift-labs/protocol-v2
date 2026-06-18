import {
	BN,
	VelocityClient,
	UserAccount,
	PublicKey,
	UserMap,
	TxSigAndSlot,
	BlockhashSubscriber,
} from '@velocity-exchange/sdk';
import { Mutex } from 'async-mutex';

import { logger } from '../logger';
import { Bot } from '../types';
import { BaseBotConfig } from '../config';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import { simulateAndGetTxWithCUs, sleepMs } from '../utils';

const USER_IDLE_CHUNKS = 9;
const SLEEP_MS = 1000;
const CACHED_BLOCKHASH_OFFSET = 5;

export class UserIdleFlipperBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly runOnce: boolean;
	public readonly defaultIntervalMs: number = 600000;

	private velocityClient: VelocityClient;
	private lookupTableAccounts?: AddressLookupTableAccount[];
	private intervalIds: Array<NodeJS.Timer> = [];
	private userMap: UserMap;
	private blockhashSubscriber: BlockhashSubscriber;

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	constructor(
		velocityClient: VelocityClient,
		config: BaseBotConfig,
		blockhashSubscriber: BlockhashSubscriber
	) {
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.runOnce = config.runOnce || false;
		this.velocityClient = velocityClient;
		this.userMap = new UserMap({
			velocityClient: this.velocityClient,
			subscriptionConfig: {
				type: 'polling',
				frequency: 60_000,
				commitment: this.velocityClient.opts?.commitment,
			},
			skipInitialLoad: false,
			includeIdle: false,
		});
		this.blockhashSubscriber = blockhashSubscriber;
	}

	public async init() {
		logger.info(`${this.name} initing`);

		await this.velocityClient.subscribe();
		if (!(await this.velocityClient.getUser().exists())) {
			throw new Error(
				`User for ${this.velocityClient.wallet.publicKey.toString()} does not exist`
			);
		}
		await this.userMap.subscribe();
		this.lookupTableAccounts =
			await this.velocityClient.fetchAllLookupTableAccounts();
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];

		await this.userMap?.unsubscribe();
	}

	public async startIntervalLoop(intervalMs?: number): Promise<void> {
		logger.info(`${this.name} Bot started!`);
		if (this.runOnce) {
			await this.tryIdleUsers();
		} else {
			const intervalId = setInterval(this.tryIdleUsers.bind(this), intervalMs);
			this.intervalIds.push(intervalId);
		}
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 2 * this.defaultIntervalMs;
		});
		return healthy;
	}

	private async tryIdleUsers() {
		try {
			console.log('tryIdleUsers');
			const currentSlot = await this.velocityClient.connection.getSlot();
			const usersToIdle: Array<[PublicKey, UserAccount]> = [];
			for (const user of this.userMap.values()) {
				// dont mark isolated pool users idle
				if (user.getUserAccountOrThrow().poolId !== 0) {
					continue;
				}

				if (user.canMakeIdle(new BN(currentSlot))) {
					usersToIdle.push([
						user.getUserAccountPublicKey(),
						user.getUserAccountOrThrow(),
					]);
					logger.info(
						`Can idle user ${user.getUserAccountOrThrow().authority.toBase58()}`
					);
				}
			}
			logger.info(`Found ${usersToIdle.length} users to idle`);

			for (let i = 0; i < usersToIdle.length; i += USER_IDLE_CHUNKS) {
				const usersChunk = usersToIdle.slice(i, i + USER_IDLE_CHUNKS);
				await this.trySendTxforChunk(usersChunk);
			}
		} catch (err) {
			console.error(err);
			if (!(err instanceof Error)) {
				return;
			}
		} finally {
			logger.info('UserIdleSettler finished');
			await this.watchdogTimerMutex.runExclusive(async () => {
				this.watchdogTimerLastPatTime = Date.now();
			});
		}
	}

	private async trySendTxforChunk(
		usersChunk: Array<[PublicKey, UserAccount]>
	): Promise<void> {
		const success = await this.sendTxforChunk(usersChunk);
		if (!success) {
			const slice = usersChunk.length / 2;
			if (slice < 1) {
				return;
			}
			await sleepMs(SLEEP_MS);
			await this.trySendTxforChunk(usersChunk.slice(0, slice));
			await sleepMs(SLEEP_MS);
			await this.trySendTxforChunk(usersChunk.slice(slice));
		}
		await sleepMs(SLEEP_MS);
	}

	private async getBlockhashForTx(): Promise<string> {
		const cachedBlockhash = this.blockhashSubscriber.getLatestBlockhash(
			CACHED_BLOCKHASH_OFFSET
		);
		if (cachedBlockhash) {
			return cachedBlockhash.blockhash as string;
		}

		const recentBlockhash =
			await this.velocityClient.connection.getLatestBlockhash({
				commitment: 'finalized',
			});
		if (!recentBlockhash) {
			throw new Error('No recent blockhash found??');
		}

		return recentBlockhash.blockhash;
	}

	private async sendTxforChunk(
		usersChunk: Array<[PublicKey, UserAccount]>
	): Promise<boolean> {
		if (usersChunk.length === 0) {
			return true;
		}

		let success = false;
		try {
			const ixs = [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 1_400_000, // simulation will ovewrrite this
				}),
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: 50000,
				}),
			];
			for (const [userAccountPublicKey, userAccount] of usersChunk) {
				ixs.push(
					await this.velocityClient.getUpdateUserIdleIx(
						userAccountPublicKey,
						userAccount
					)
				);
			}
			if (ixs.length === 2) {
				throw new Error(
					`Tried to send a tx with 0 users, chunkSize: ${usersChunk.length}`
				);
			}

			const recentBlockhash = await this.getBlockhashForTx();
			const simResult = await simulateAndGetTxWithCUs({
				ixs,
				connection: this.velocityClient.connection,
				payerPublicKey: this.velocityClient.wallet.publicKey,
				lookupTableAccounts: this.lookupTableAccounts!,
				cuLimitMultiplier: 1.1,
				doSimulation: true,
				recentBlockhash,
			});
			logger.info(
				`User idle flipper estimated ${simResult.cuEstimate} CUs for ${usersChunk.length} users.`
			);

			if (simResult.simError !== null) {
				logger.error(
					`Sim error: ${JSON.stringify(simResult.simError)}\n${
						simResult.simTxLogs ? simResult.simTxLogs.join('\n') : ''
					}`
				);
				success = false;
			} else {
				const txSigAndSlot =
					await this.velocityClient.txSender.sendVersionedTransaction(
						simResult.tx,
						[],
						this.velocityClient.opts
					);
				this.logTxAndSlotForUsers(txSigAndSlot, usersChunk);
				success = true;
			}
		} catch (e) {
			const userKeys = usersChunk
				.map(([userAccountPublicKey, _]) => userAccountPublicKey.toBase58())
				.join(', ');
			logger.error(`Failed to idle users: ${userKeys}`);
			logger.error(e);
		}
		return success;
	}

	private logTxAndSlotForUsers(
		txSigAndSlot: TxSigAndSlot,
		usersChunk: Array<[PublicKey, UserAccount]>
	) {
		const txSig = txSigAndSlot.txSig;
		for (const [userAccountPublicKey, _] of usersChunk) {
			logger.info(
				`Flipped user ${userAccountPublicKey.toBase58()} https://solscan.io/tx/${txSig}`
			);
		}
	}
}
