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
import {
	DataAndSlot,
	DelistedMarketSetting,
	GrpcConfigs,
	ResubOpts,
} from './types';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { grpcMultiAccountSubscriber } from './grpcMultiAccountSubscriber';
import { PerpMarketAccount, SpotMarketAccount, StateAccount } from '../types';
import {
	getOracleId,
	getPublicKeyAndSourceFromOracleId,
} from '../oracles/oracleId';

export class grpcDriftClientAccountSubscriberV2 extends WebSocketDriftClientAccountSubscriber {
	private grpcConfigs: GrpcConfigs;
	private perpMarketsSubscriber?: grpcMultiAccountSubscriber<PerpMarketAccount>;
	private spotMarketsSubscriber?: grpcMultiAccountSubscriber<SpotMarketAccount>;
	private oracleMultiSubscriber?: grpcMultiAccountSubscriber<OraclePriceData>;
	private perpMarketIndexToAccountPubkeyMap = new Map<number, string>();
	private spotMarketIndexToAccountPubkeyMap = new Map<number, string>();

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

	override getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		return this.perpMarketsSubscriber?.getAccountData(
			this.perpMarketIndexToAccountPubkeyMap.get(marketIndex)
		);
	}

	override getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		return this.spotMarketsSubscriber?.getAccountData(
			this.spotMarketIndexToAccountPubkeyMap.get(marketIndex)
		);
	}

	override async setPerpOracleMap() {
		const perpMarketsMap = this.perpMarketsSubscriber?.getAccountDataMap();
		const perpMarkets = Array.from(perpMarketsMap.values());
		const addOraclePromises = [];
		for (const perpMarket of perpMarkets) {
			if (!perpMarket || !perpMarket.data) {
				continue;
			}
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.amm.oracle;
			const oracleId = getOracleId(oracle, perpMarket.data.amm.oracleSource);
			if (!this.oracleSubscribers.has(oracleId)) {
				addOraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: perpMarket.data.amm.oracleSource,
					})
				);
			}
			this.perpOracleMap.set(perpMarketIndex, oracle);
			this.perpOracleStringMap.set(perpMarketIndex, oracleId);
		}
		await Promise.all(addOraclePromises);
	}

	override async setSpotOracleMap() {
		const spotMarketsMap = this.spotMarketsSubscriber?.getAccountDataMap();
		const spotMarkets = Array.from(spotMarketsMap.values());
		const addOraclePromises = [];
		for (const spotMarket of spotMarkets) {
			if (!spotMarket || !spotMarket.data) {
				continue;
			}
			const spotMarketAccount = spotMarket.data;
			const spotMarketIndex = spotMarketAccount.marketIndex;
			const oracle = spotMarketAccount.oracle;
			const oracleId = getOracleId(oracle, spotMarketAccount.oracleSource);
			if (!this.oracleSubscribers.has(oracleId)) {
				addOraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: spotMarketAccount.oracleSource,
					})
				);
			}
			this.spotOracleMap.set(spotMarketIndex, oracle);
			this.spotOracleStringMap.set(spotMarketIndex, oracleId);
		}
		await Promise.all(addOraclePromises);
	}

	override async subscribeToPerpMarketAccounts(): Promise<boolean> {
		const perpMarketIndexToAccountPubkeys: Array<[number, PublicKey]> =
			await Promise.all(
				this.perpMarketIndexes.map(async (marketIndex) => [
					marketIndex,
					await getPerpMarketPublicKey(this.program.programId, marketIndex),
				])
			);
		for (const [
			marketIndex,
			accountPubkey,
		] of perpMarketIndexToAccountPubkeys) {
			this.perpMarketIndexToAccountPubkeyMap.set(
				marketIndex,
				accountPubkey.toBase58()
			);
		}

		const perpMarketPubkeys = perpMarketIndexToAccountPubkeys.map(
			([_, accountPubkey]) => accountPubkey
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

		for (const data of this.initialPerpMarketAccountData.values()) {
			this.perpMarketsSubscriber.setAccountData(data.pubkey.toBase58(), data);
		}

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
		const spotMarketIndexToAccountPubkeys: Array<[number, PublicKey]> =
			await Promise.all(
				this.spotMarketIndexes.map(async (marketIndex) => [
					marketIndex,
					await getSpotMarketPublicKey(this.program.programId, marketIndex),
				])
			);
		for (const [
			marketIndex,
			accountPubkey,
		] of spotMarketIndexToAccountPubkeys) {
			this.spotMarketIndexToAccountPubkeyMap.set(
				marketIndex,
				accountPubkey.toBase58()
			);
		}

		const spotMarketPubkeys = spotMarketIndexToAccountPubkeys.map(
			([_, accountPubkey]) => accountPubkey
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

		for (const data of this.initialSpotMarketAccountData.values()) {
			this.spotMarketsSubscriber.setAccountData(data.pubkey.toBase58(), data);
		}

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
		const pubkeyToSources = new Map<string, Set<OracleInfo['source']>>();
		for (const info of this.oracleInfos) {
			if (info.publicKey.equals((PublicKey as any).default)) {
				continue;
			}
			const key = info.publicKey.toBase58();
			let sources = pubkeyToSources.get(key);
			if (!sources) {
				sources = new Set<OracleInfo['source']>();
				pubkeyToSources.set(key, sources);
			}
			sources.add(info.source);
		}

		const oraclePubkeys = Array.from(pubkeyToSources.keys()).map(
			(k) => new PublicKey(k)
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
					const sources = pubkeyToSources.get(pubkey);
					if (!sources || sources.size === 0) {
						throw new Error('Oracle sources missing for pubkey in decode');
					}
					const primarySource = sources.values().next().value;
					const client = this.oracleClientCache.get(
						primarySource,
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

		for (const data of this.initialOraclePriceData.entries()) {
			const { publicKey } = getPublicKeyAndSourceFromOracleId(data[0]);
			this.oracleMultiSubscriber.setAccountData(publicKey.toBase58(), data[1]);
		}

		await this.oracleMultiSubscriber.subscribe(
			oraclePubkeys,
			(accountId, data) => {
				const sources = pubkeyToSources.get(accountId.toBase58());
				if (sources) {
					for (const source of sources.values()) {
						this.eventEmitter.emit(
							'oraclePriceUpdate',
							accountId,
							source,
							data
						);
					}
				}
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
