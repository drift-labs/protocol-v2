import {
	DriftClient,
	getMarketOrderParams,
	isVariant,
	MarketType,
	PositionDirection,
	digestSignature,
	generateSignedMsgUuid,
	BN,
	OrderParams,
	QUOTE_PRECISION,
	BASE_PRECISION,
	PRICE_PRECISION,
} from '@drift-labs/sdk';
import { RuntimeSpec } from 'src/metrics';
import * as axios from 'axios';
import { sleepMs } from '../../utils';

const CONFIRM_TIMEOUT = 30_000;

export class SwiftTaker {
	interval: NodeJS.Timeout | null = null;
	swiftUrl: string;

	constructor(
		private driftClient: DriftClient,
		runtimeSpec: RuntimeSpec,
		private intervalMs: number
	) {
		this.swiftUrl =
			runtimeSpec.driftEnv === 'mainnet-beta'
				? 'https://swift.drift.trade'
				: 'https://master.swift.drift.trade';
	}

	async init() {
		await this.startInterval();
	}

	public async healthCheck() {
		return true;
	}

	async startInterval() {
		const marketIndexes = [0, 1, 2];
		this.interval = setInterval(async () => {
			await sleepMs(Math.random() * 5000); // Randomize for different grafana metrics
			const slot = await this.driftClient.connection.getSlot();
			const direction =
				Math.random() > 0.5 ? PositionDirection.LONG : PositionDirection.SHORT;

			const marketIndex =
				marketIndexes[Math.floor(Math.random() * marketIndexes.length)];

			const oracleInfo =
				this.driftClient.getMMOracleDataForPerpMarket(marketIndex);
			const EPS_BPS = 10; // 0.1%
			const plusBps = (p: BN, bps: number) => p.muln(10_000 + bps).divn(10_000);
			const minusBps = (p: BN, bps: number) =>
				p.muln(10_000 - bps).divn(10_000);

			const highPrice = plusBps(oracleInfo.price, EPS_BPS);
			const lowPrice = minusBps(oracleInfo.price, EPS_BPS);

			const tradeSizeDollars = sampleTradeSizeDollars();
			const tradeSize = new BN(tradeSizeDollars)
				.mul(QUOTE_PRECISION)
				.mul(PRICE_PRECISION)
				.mul(BASE_PRECISION.div(PRICE_PRECISION))
				.div(oracleInfo.price);

			const perpMarketAccount =
				this.driftClient.getPerpMarketAccount(marketIndex);
			if (!perpMarketAccount) {
				console.error(`Perp market ${marketIndex} not found`);
				return;
			}

			const marketOrderParams = getMarketOrderParams({
				marketIndex,
				marketType: MarketType.PERP,
				direction,
				baseAssetAmount: floorBNToNearest(
					tradeSize,
					perpMarketAccount.amm.orderStepSize
				),
				auctionStartPrice: isVariant(direction, 'long') ? lowPrice : highPrice,
				auctionEndPrice: isVariant(direction, 'long') ? highPrice : lowPrice,
				auctionDuration: 50,
			});

			const orderMessage = {
				signedMsgOrderParams: marketOrderParams as OrderParams,
				subAccountId: this.driftClient.activeSubAccountId,
				slot: new BN(slot),
				uuid: generateSignedMsgUuid(),
				stopLossOrderParams: null,
				takeProfitOrderParams: null,
			};
			const { orderParams: message, signature } =
				this.driftClient.signSignedMsgOrderParamsMessage(orderMessage);

			const hash = digestSignature(Uint8Array.from(signature));
			console.log(
				`Sending order in slot: ${slot}, time: ${Date.now()}, hash: ${hash}`
			);

			try {
				const response = await axios.default.post(
					this.swiftUrl + '/orders',
					{
						market_index: marketIndex,
						market_type: 'perp',
						message: message.toString(),
						signature: signature.toString('base64'),
						taker_pubkey: this.driftClient.wallet.publicKey.toBase58(),
					},
					{
						headers: {
							'Content-Type': 'application/json',
						},
						validateStatus: (_status) => true,
					}
				);
				if (response.status !== 200) {
					console.error('Failed to send order', {
						status: response.status,
						data: response.data,
					});
					return;
				}
			} catch (e) {
				if (axios.isAxiosError(e)) {
					console.error('Failed to send order', {
						message: e.message,
						status: e.response?.status,
						data: e.response?.data,
					});
				} else {
					console.error('Failed to send order', e);
				}
				return;
			}

			const expireTime = Date.now() + CONFIRM_TIMEOUT;
			while (Date.now() < expireTime) {
				const response = await axios.default.get(
					this.swiftUrl +
						'/confirmation/hash-status?hash=' +
						encodeURIComponent(hash),
					{
						validateStatus: (_status) => true,
					}
				);
				if (response.status === 200) {
					console.log('Confirmed hash ', hash);
					return;
				} else if (response.status >= 500) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10000));
			}
			console.error('Failed to confirm hash: ', hash);
		}, this.intervalMs);
	}
}

function sampleTradeSizeDollars(): number {
	const random = Math.random();

	if (random < 0.6) {
		// 60% small trades: $100 - $5,000
		return 100 + Math.random() * 10_000;
	} else if (random < 0.85) {
		// 25% medium trades: $5,000 - $20,000
		return 10_000 + Math.random() * 30_000;
	} else {
		// 15% large trades: $20,000 - $70,000
		return 30_000 + Math.random() * 70_000;
	}
}

function floorBNToNearest(value: BN, roundTo: BN): BN {
	return value.div(roundTo).mul(roundTo);
}
