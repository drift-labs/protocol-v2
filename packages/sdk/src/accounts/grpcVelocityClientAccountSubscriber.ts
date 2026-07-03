import { WebSocketVelocityClientAccountSubscriber } from './webSocketVelocityClientAccountSubscriber';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { findAllMarketAndOracles, VelocityProgram } from '../config';
import {
	getVelocityStateAccountPublicKey,
	getPerpMarketPublicKey,
	getSpotMarketPublicKey,
} from '../addresses/pda';
import { DelistedMarketSetting, GrpcConfigs, ResubOpts } from './types';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { PerpMarketAccount, SpotMarketAccount, StateAccount } from '../types';
import { getOracleId } from '../oracles/oracleId';

/**
 * `VelocityClientAccountSubscriber` variant of `WebSocketVelocityClientAccountSubscriber` that
 * subscribes each per-account subscriber via `grpcAccountSubscriber.create` (gRPC Geyser stream)
 * instead of `connection.onAccountChange`. Reuses the parent class's `setInitialData`/oracle-map/
 * delisted-market logic verbatim; only the account-subscription creation is overridden.
 */
export class grpcVelocityClientAccountSubscriber extends WebSocketVelocityClientAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	/**
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param program Anchor program used to derive PDAs, decode accounts, and resolve oracle clients.
	 * @param perpMarketIndexes Perp market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param spotMarketIndexes Spot market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param oracleInfos Oracles to track up front, if `shouldFindAllMarketsAndOracles` is false.
	 * @param shouldFindAllMarketsAndOracles If true, `subscribe()` first discovers every market/oracle from on-chain state.
	 * @param delistedMarketSetting Behavior applied to delisted perp markets/oracles after subscribing.
	 * @param resubOpts Resubscription watchdog options passed to every per-account subscriber.
	 */
	constructor(
		grpcConfigs: GrpcConfigs,
		program: VelocityProgram,
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

	/**
	 * Subscribes the `State` account via gRPC, batch-seeds all market/oracle accounts via
	 * `setInitialData()` (inherited RPC-based batch fetch), then subscribes every per-account gRPC
	 * subscriber for perp markets, spot markets, and oracles. Applies `delistedMarketSetting`
	 * afterward. Idempotent: a no-op if already subscribed, and concurrent calls while a subscribe
	 * is in flight share the same result via `subscriptionPromise`.
	 */
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

		const statePublicKey = await getVelocityStateAccountPublicKey(
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

		await Promise.all([
			// subscribe to market accounts
			this.subscribeToPerpMarketAccounts(),
			// subscribe to spot market accounts
			this.subscribeToSpotMarketAccounts(),
			// subscribe to oracles
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

	/**
	 * Creates and subscribes a `grpcAccountSubscriber` for one spot market, seeding it from
	 * `initialSpotMarketAccountData` if available.
	 * @param marketIndex Spot market index to subscribe.
	 */
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
		const initialSpotMarketData =
			this.initialSpotMarketAccountData?.get(marketIndex);
		if (initialSpotMarketData) {
			accountSubscriber.setData(initialSpotMarketData);
		}
		await accountSubscriber.subscribe((data: SpotMarketAccount) => {
			this.eventEmitter.emit('spotMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.spotMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	/**
	 * Creates and subscribes a `grpcAccountSubscriber` for one perp market, seeding it from
	 * `initialPerpMarketAccountData` if available. Unlike the parent class's WebSocket variant,
	 * does not call `ensureAccountFetched` — the gRPC subscriber's own initial `fetch()` (inside
	 * `subscribe`) is relied on directly.
	 * @param marketIndex Perp market index to subscribe.
	 */
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
		const initialPerpMarketData =
			this.initialPerpMarketAccountData?.get(marketIndex);
		if (initialPerpMarketData) {
			accountSubscriber.setData(initialPerpMarketData);
		}
		await accountSubscriber.subscribe((data: PerpMarketAccount) => {
			this.eventEmitter.emit('perpMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.perpMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	/**
	 * Creates and subscribes a `grpcAccountSubscriber` for one oracle, decoding buffers with the
	 * source-appropriate `OracleClient`. Seeds from `initialOraclePriceData` if available.
	 * @param oracleInfo Oracle pubkey and source to subscribe.
	 * @returns `false` if no `OracleClient` is registered for `oracleInfo.source`; otherwise `true`.
	 */
	async subscribeToOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
		const client = this.oracleClientCache.get(
			oracleInfo.source,
			this.program.provider.connection,
			this.program
		);
		if (!client) {
			return false;
		}
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
		const initialOraclePriceData = this.initialOraclePriceData?.get(oracleId);
		if (initialOraclePriceData) {
			accountSubscriber.setData(initialOraclePriceData);
		}
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
