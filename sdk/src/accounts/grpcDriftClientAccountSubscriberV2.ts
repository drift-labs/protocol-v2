import { WebSocketDriftClientAccountSubscriber } from './webSocketDriftClientAccountSubscriber';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { findAllMarketAndOracles } from '../config';
import {
	getDriftStateAccountPublicKey,
	getPerpMarketPublicKey,
	getSpotMarketPublicKey,
} from '../addresses/pda';
import { DelistedMarketSetting, GrpcConfigs, ResubOpts } from './types';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { grpcMultiAccountSubscriber } from './grpcMultiAccountSubscriber';
import { PerpMarketAccount, SpotMarketAccount, StateAccount } from '../types';
import { getOracleId } from '../oracles/oracleId';

export class grpcDriftClientAccountSubscriberV2 extends WebSocketDriftClientAccountSubscriber {
	private grpcConfigs: GrpcConfigs;
	private perpMarketsSubscriber?: grpcMultiAccountSubscriber<PerpMarketAccount>;
	private spotMarketsSubscriber?: grpcMultiAccountSubscriber<SpotMarketAccount>;
	private oracleMultiSubscriber?: grpcMultiAccountSubscriber<OraclePriceData>;

	constructor(
		grpcConfigs: GrpcConfigs,
		program: Program,
		perpMarketIndexes: number[],
		spotMarketIndexes: number[],
		oracleInfos: OracleInfo[],
		shouldFindAllMarketsAndOracles: boolean,
		delistedMarketSetting: DelistedMarketSetting,
		resubOpts?: ResubOpts
	) {
		super(
			program,
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
			shouldFindAllMarketsAndOracles,
			delistedMarketSetting,
			resubOpts
		);
		this.grpcConfigs = grpcConfigs;
	}

	public async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (this.isSubscribing) {
			return await this.subscriptionPromise;
		}

		this.isSubscribing = true;

		this.subscriptionPromise = new Promise((res) => {
			this.subscriptionPromiseResolver = res;
		});

		if (this.shouldFindAllMarketsAndOracles) {
			const {
				perpMarketIndexes,
				perpMarketAccounts,
				spotMarketIndexes,
				spotMarketAccounts,
				oracleInfos,
			} = await findAllMarketAndOracles(this.program);
			this.perpMarketIndexes = perpMarketIndexes;
			this.spotMarketIndexes = spotMarketIndexes;
			this.oracleInfos = oracleInfos;
			// front run and set the initial data here to save extra gma call in set initial data
			this.initialPerpMarketAccountData = new Map(
				perpMarketAccounts.map((market) => [market.marketIndex, market])
			);
			this.initialSpotMarketAccountData = new Map(
				spotMarketAccounts.map((market) => [market.marketIndex, market])
			);
		}

		const statePublicKey = await getDriftStateAccountPublicKey(
			this.program.programId
		);

		// create and activate main state account subscription
		this.stateAccountSubscriber =
			await grpcAccountSubscriber.create<StateAccount>(
				this.grpcConfigs,
				'state',
				this.program,
				statePublicKey,
				undefined,
				undefined
			);
		await this.stateAccountSubscriber.subscribe((data: StateAccount) => {
			this.eventEmitter.emit('stateAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		// set initial data to avoid spamming getAccountInfo calls in webSocketAccountSubscriber
		await this.setInitialData();

		// subscribe to perp + spot markets (separate) and oracles
		await Promise.all([
			this.subscribeToPerpMarketAccounts(),
			this.subscribeToSpotMarketAccounts(),
			this.subscribeToOracles(),
		]);

		this.eventEmitter.emit('update');

		await this.handleDelistedMarkets();

		await Promise.all([this.setPerpOracleMap(), this.setSpotOracleMap()]);

		this.subscriptionPromiseResolver(true);

		this.isSubscribing = false;
		this.isSubscribed = true;

		// delete initial data
		this.removeInitialData();

		return true;
	}

	override async subscribeToPerpMarketAccounts(): Promise<boolean> {
		const perpMarketPubkeys = await Promise.all(
			this.perpMarketIndexes.map((marketIndex) =>
				getPerpMarketPublicKey(this.program.programId, marketIndex)
			)
		);

		this.perpMarketsSubscriber =
			await grpcMultiAccountSubscriber.create<PerpMarketAccount>(
				this.grpcConfigs,
				'perpMarket',
				this.program,
				undefined,
				this.resubOpts,
				undefined,
				async () => {
					try {
						if (this.resubOpts?.logResubMessages) {
							console.log(
								'[grpcDriftClientAccountSubscriberV2] perp markets subscriber unsubscribed; resubscribing'
							);
						}
						await this.subscribeToPerpMarketAccounts();
					} catch (e) {
						console.error('Perp markets resubscribe failed:', e);
					}
				}
			);
		await this.perpMarketsSubscriber.subscribe(
			perpMarketPubkeys,
			(_accountId, data) => {
				this.eventEmitter.emit(
					'perpMarketAccountUpdate',
					data as PerpMarketAccount
				);
				this.eventEmitter.emit('update');
			}
		);

		return true;
	}

	override async subscribeToSpotMarketAccounts(): Promise<boolean> {
		const spotMarketPubkeys = await Promise.all(
			this.spotMarketIndexes.map((marketIndex) =>
				getSpotMarketPublicKey(this.program.programId, marketIndex)
			)
		);

		this.spotMarketsSubscriber =
			await grpcMultiAccountSubscriber.create<SpotMarketAccount>(
				this.grpcConfigs,
				'spotMarket',
				this.program,
				undefined,
				this.resubOpts,
				undefined,
				async () => {
					try {
						if (this.resubOpts?.logResubMessages) {
							console.log(
								'[grpcDriftClientAccountSubscriberV2] spot markets subscriber unsubscribed; resubscribing'
							);
						}
						await this.subscribeToSpotMarketAccounts();
					} catch (e) {
						console.error('Spot markets resubscribe failed:', e);
					}
				}
			);
		await this.spotMarketsSubscriber.subscribe(
			spotMarketPubkeys,
			(_accountId, data) => {
				this.eventEmitter.emit(
					'spotMarketAccountUpdate',
					data as SpotMarketAccount
				);
				this.eventEmitter.emit('update');
			}
		);

		return true;
	}

	override async subscribeToOracles(): Promise<boolean> {
		// Build list of unique oracle pubkeys and a lookup for sources
		const uniqueOraclePubkeys = new Map<string, OracleInfo>();
		for (const info of this.oracleInfos) {
			const id = getOracleId(info.publicKey, info.source);
			if (
				!uniqueOraclePubkeys.has(id) &&
				!info.publicKey.equals((PublicKey as any).default)
			) {
				uniqueOraclePubkeys.set(id, info);
			}
		}

		const oraclePubkeys = Array.from(uniqueOraclePubkeys.values()).map(
			(i) => i.publicKey
		);
		const pubkeyToSource = new Map<string, OracleInfo['source']>(
			Array.from(uniqueOraclePubkeys.values()).map((i) => [
				i.publicKey.toBase58(),
				i.source,
			])
		);

		this.oracleMultiSubscriber =
			await grpcMultiAccountSubscriber.create<OraclePriceData>(
				this.grpcConfigs,
				'oracle',
				this.program,
				(buffer: Buffer, pubkey?: string) => {
					if (!pubkey) {
						throw new Error('Oracle pubkey missing in decode');
					}
					const source = pubkeyToSource.get(pubkey);
					const client = this.oracleClientCache.get(
						source,
						this.program.provider.connection,
						this.program
					);
					return client.getOraclePriceDataFromBuffer(buffer);
				},
				this.resubOpts,
				undefined,
				async () => {
					try {
						if (this.resubOpts?.logResubMessages) {
							console.log(
								'[grpcDriftClientAccountSubscriberV2] oracle subscriber unsubscribed; resubscribing'
							);
						}
						await this.subscribeToOracles();
					} catch (e) {
						console.error('Oracle resubscribe failed:', e);
					}
				}
			);

		await this.oracleMultiSubscriber.subscribe(
			oraclePubkeys,
			(accountId, data) => {
				const source = pubkeyToSource.get(accountId.toBase58());
				this.eventEmitter.emit('oraclePriceUpdate', accountId, source, data);
				this.eventEmitter.emit('update');
			}
		);

		return true;
	}

	async unsubscribeFromOracles(): Promise<void> {
		if (this.oracleMultiSubscriber) {
			await this.oracleMultiSubscriber.unsubscribe();
			this.oracleMultiSubscriber = undefined;
			return;
		}
		await super.unsubscribeFromOracles();
	}

	override async unsubscribe(): Promise<void> {
		if (this.isSubscribed) {
			return;
		}

		await this.stateAccountSubscriber.unsubscribe();
	}
}
