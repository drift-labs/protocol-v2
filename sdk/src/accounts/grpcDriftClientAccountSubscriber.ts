import { WebSocketDriftClientAccountSubscriber } from './webSocketDriftClientAccountSubscriber';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { Program } from '@coral-xyz/anchor';
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

export class gprcDriftClientAccountSubscriber extends WebSocketDriftClientAccountSubscriber {
	private grpcConfigs: GrpcConfigs;
	private perpMarketsSubscriber?: grpcMultiAccountSubscriber<PerpMarketAccount>;
	private spotMarketsSubscriber?: grpcMultiAccountSubscriber<SpotMarketAccount>;

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

		// subscribe to perp + spot markets using two gRPC streams and subscribe to oracles
		await Promise.all([
			this.subscribeToPerpAndSpotMarkets(),
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

	private async subscribeToPerpAndSpotMarkets(): Promise<boolean> {
		const [perpMarketPubkeys, spotMarketPubkeys] = await Promise.all([
			Promise.all(
				this.perpMarketIndexes.map((marketIndex) =>
					getPerpMarketPublicKey(this.program.programId, marketIndex)
				)
			),
			Promise.all(
				this.spotMarketIndexes.map((marketIndex) =>
					getSpotMarketPublicKey(this.program.programId, marketIndex)
				)
			),
		]);

		this.perpMarketsSubscriber =
			await grpcMultiAccountSubscriber.create<PerpMarketAccount>(
				this.grpcConfigs,
				'PerpMarket',
				this.program,
				undefined,
				this.resubOpts
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

		this.spotMarketsSubscriber =
			await grpcMultiAccountSubscriber.create<SpotMarketAccount>(
				this.grpcConfigs,
				'SpotMarket',
				this.program,
				undefined,
				this.resubOpts
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

	override async subscribeToSpotMarketAccount(
		marketIndex: number
	): Promise<boolean> {
		const marketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const accountSubscriber =
			await grpcAccountSubscriber.create<SpotMarketAccount>(
				this.grpcConfigs,
				'spotMarket',
				this.program,
				marketPublicKey,
				undefined,
				this.resubOpts
			);
		accountSubscriber.setData(
			this.initialSpotMarketAccountData.get(marketIndex)
		);
		await accountSubscriber.subscribe((data: SpotMarketAccount) => {
			this.eventEmitter.emit('spotMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.spotMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	async subscribeToPerpMarketAccount(marketIndex: number): Promise<boolean> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const accountSubscriber =
			await grpcAccountSubscriber.create<PerpMarketAccount>(
				this.grpcConfigs,
				'perpMarket',
				this.program,
				perpMarketPublicKey,
				undefined,
				this.resubOpts
			);
		accountSubscriber.setData(
			this.initialPerpMarketAccountData.get(marketIndex)
		);
		await accountSubscriber.subscribe((data: PerpMarketAccount) => {
			this.eventEmitter.emit('perpMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.perpMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	async subscribeToOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
		const client = this.oracleClientCache.get(
			oracleInfo.source,
			this.program.provider.connection,
			this.program
		);
		const accountSubscriber =
			await grpcAccountSubscriber.create<OraclePriceData>(
				this.grpcConfigs,
				'oracle',
				this.program,
				oracleInfo.publicKey,
				(buffer: Buffer) => {
					return client.getOraclePriceDataFromBuffer(buffer);
				},
				this.resubOpts
			);
		accountSubscriber.setData(this.initialOraclePriceData.get(oracleId));
		await accountSubscriber.subscribe((data: OraclePriceData) => {
			this.eventEmitter.emit(
				'oraclePriceUpdate',
				oracleInfo.publicKey,
				oracleInfo.source,
				data
			);
			this.eventEmitter.emit('update');
		});

		this.oracleSubscribers.set(oracleId, accountSubscriber);
		return true;
	}
}
