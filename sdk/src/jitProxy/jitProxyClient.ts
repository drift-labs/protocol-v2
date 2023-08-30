import {
	BN,
	DriftClient,
	isVariant,
	MarketType,
	PostOnlyParams,
	QUOTE_SPOT_MARKET_INDEX,
	ReferrerInfo,
	TxParams,
	UserAccount,
	TxSigAndSlot,
} from '..';
import { IDL, JitProxy } from './types/jit_proxy';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';

export type JitIxParams = {
	takerKey: PublicKey;
	takerStatsKey: PublicKey;
	taker: UserAccount;
	takerOrderId: number;
	maxPosition: BN;
	minPosition: BN;
	bid: BN;
	ask: BN;
	postOnly: PostOnlyParams | null;
	priceType?: PriceType;
	referrerInfo?: ReferrerInfo;
	subAccountId?: number;
};

export class PriceType {
	static readonly LIMIT = { limit: {} };
	static readonly ORACLE = { oracle: {} };
}

export type OrderConstraint = {
	maxPosition: BN;
	minPosition: BN;
	marketIndex: number;
	marketType: MarketType;
};

export class JitProxyClient {
	private driftClient: DriftClient;
	private program: Program<JitProxy>;

	constructor({
		driftClient,
		programId,
	}: {
		driftClient: DriftClient;
		programId: PublicKey;
	}) {
		this.driftClient = driftClient;
		this.program = new Program(IDL, programId, driftClient.provider);
	}

	public async jit(
		params: JitIxParams,
		txParams?: TxParams
	): Promise<TxSigAndSlot> {
		const ix = await this.getJitIx(params);
		const tx = await this.driftClient.buildTransaction([ix], txParams);
		return await this.driftClient.sendTransaction(tx);
	}

	public async getJitIx({
		takerKey,
		takerStatsKey,
		taker,
		takerOrderId,
		maxPosition,
		minPosition,
		bid,
		ask,
		postOnly = null,
		priceType = PriceType.LIMIT,
		referrerInfo,
		subAccountId,
	}: JitIxParams): Promise<TransactionInstruction> {
		subAccountId =
			subAccountId !== undefined
				? subAccountId
				: this.driftClient.activeSubAccountId;
		const order = taker.orders.find((order) => order.orderId === takerOrderId);
		const remainingAccounts = this.driftClient.getRemainingAccounts({
			userAccounts: [taker, this.driftClient.getUserAccount(subAccountId)],
			writableSpotMarketIndexes: isVariant(order.marketType, 'spot')
				? [order.marketIndex, QUOTE_SPOT_MARKET_INDEX]
				: [],
			writablePerpMarketIndexes: isVariant(order.marketType, 'perp')
				? [order.marketIndex]
				: [],
		});

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		if (isVariant(order.marketType, 'spot')) {
			remainingAccounts.push({
				pubkey: this.driftClient.getSpotMarketAccount(order.marketIndex).vault,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: this.driftClient.getQuoteSpotMarketAccount().vault,
				isWritable: false,
				isSigner: false,
			});
		}

		const jitParams = {
			takerOrderId,
			maxPosition,
			minPosition,
			bid,
			ask,
			postOnly,
			priceType,
		};

		return this.program.methods
			.jit(jitParams)
			.accounts({
				taker: takerKey,
				takerStats: takerStatsKey,
				state: await this.driftClient.getStatePublicKey(),
				user: await this.driftClient.getUserAccountPublicKey(subAccountId),
				userStats: this.driftClient.getUserStatsAccountPublicKey(),
				driftProgram: this.driftClient.program.programId,
			})
			.remainingAccounts(remainingAccounts)
			.instruction();
	}

	public async getCheckOrderConstraintIx({
		subAccountId,
		orderConstraints,
	}: {
		subAccountId: number;
		orderConstraints: OrderConstraint[];
	}): Promise<TransactionInstruction> {
		subAccountId =
			subAccountId !== undefined
				? subAccountId
				: this.driftClient.activeSubAccountId;

		const readablePerpMarketIndex = [];
		const readableSpotMarketIndexes = [];
		for (const orderConstraint of orderConstraints) {
			if (isVariant(orderConstraint.marketType, 'perp')) {
				readablePerpMarketIndex.push(orderConstraint.marketIndex);
			} else {
				readableSpotMarketIndexes.push(orderConstraint.marketIndex);
			}
		}

		const remainingAccounts = this.driftClient.getRemainingAccounts({
			userAccounts: [this.driftClient.getUserAccount(subAccountId)],
			readableSpotMarketIndexes,
			readablePerpMarketIndex,
		});

		return this.program.methods
			.checkOrderConstraints(orderConstraints)
			.accounts({
				user: await this.driftClient.getUserAccountPublicKey(subAccountId),
			})
			.remainingAccounts(remainingAccounts)
			.instruction();
	}
}
