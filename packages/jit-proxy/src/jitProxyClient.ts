import {
	BN,
	VelocityClient,
	getSignedMsgUserAccountPublicKey,
	isVariant,
	MakerInfo,
	MarketType,
	PostOnlyParams,
	QUOTE_SPOT_MARKET_INDEX,
	ReferrerInfo,
	SignedMsgOrderParams,
	TxParams,
	UserAccount,
	hasBuilder,
	getRevenueShareEscrowAccountPublicKey,
} from '@velocity-exchange/sdk';
import { JitProxy } from './types/jit_proxy';
import jitProxyIDL from './idl/jit_proxy.json';
import {
	ComputeBudgetProgram,
	PublicKey,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { TxSigAndSlot } from '@velocity-exchange/sdk';

export const DEFAULT_CU_LIMIT = 1_400_000;

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

export type JitSignedMsgIxParams = JitIxParams & {
	authorityToUse: PublicKey;
	signedMsgOrderParams: SignedMsgOrderParams;
	uuid: Uint8Array;
	marketIndex: number;
};

export class PriceType {
	static readonly LIMIT = { limit: {} };
	static readonly ORACLE = { oracle: {} };
}

/**
 * Validates the price type and returns the corresponding enum value. (required for type checking because of how anchor handles recursive types in IDL)
 */
export function validatePriceType(
	priceType: PriceType
): typeof PriceType.LIMIT | typeof PriceType.ORACLE {
	if (isVariant(priceType, 'limit')) {
		return PriceType.LIMIT;
	}
	if (isVariant(priceType, 'oracle')) {
		return PriceType.ORACLE;
	}
	throw new Error('Invalid price type');
}

/**
 * Validates the PostOnlyParams and returns the corresponding enum value. (required for type checking because of how anchor handles recursive types in IDL)
 */
export function validatePostOnlyParams(
	postOnly: PostOnlyParams | null
):
	| typeof PostOnlyParams.NONE
	| typeof PostOnlyParams.MUST_POST_ONLY
	| typeof PostOnlyParams.TRY_POST_ONLY
	| typeof PostOnlyParams.SLIDE {
	if (postOnly === null) {
		return PostOnlyParams.NONE;
	}
	if (isVariant(postOnly, 'none')) {
		return PostOnlyParams.NONE;
	}
	if (isVariant(postOnly, 'mustPostOnly')) {
		return PostOnlyParams.MUST_POST_ONLY;
	}
	if (isVariant(postOnly, 'tryPostOnly')) {
		return PostOnlyParams.TRY_POST_ONLY;
	}
	if (isVariant(postOnly, 'slide')) {
		return PostOnlyParams.SLIDE;
	}
	throw new Error('Invalid post only params');
}

/**
 * Validates the market type and returns the corresponding enum value. (required for type checking because of how anchor handles recursive types in IDL)
 */
export function validateMarketType(
	marketType: MarketType
): typeof MarketType.PERP | typeof MarketType.SPOT {
	if (isVariant(marketType, 'perp')) {
		return MarketType.PERP;
	}
	if (isVariant(marketType, 'spot')) {
		return MarketType.SPOT;
	}
	throw new Error('Invalid market type');
}

export type OrderConstraint = {
	maxPosition: BN;
	minPosition: BN;
	marketIndex: number;
	marketType: MarketType;
};

export class JitProxyClient {
	private driftClient: VelocityClient;
	private program: Program<JitProxy>;

	constructor({
		driftClient,
		programId,
	}: {
		driftClient: VelocityClient;
		programId: PublicKey;
	}) {
		this.driftClient = driftClient;
		// Anchor 1.0: the program address lives in the IDL and the Program
		// constructor is (idl, provider). Honor a caller-supplied programId by
		// overriding the IDL address before constructing.
		const idl = {
			...(jitProxyIDL as JitProxy),
			address: programId.toBase58(),
		} as JitProxy;
		this.program = new Program(idl, driftClient.provider);
	}

	public async jit(
		params: JitIxParams,
		txParams?: TxParams
	): Promise<TxSigAndSlot> {
		const ix = await this.getJitIx(params);
		const tx = await this.driftClient.buildTransaction([ix], txParams);
		return await this.driftClient.sendTransaction(tx);
	}

	public async jitSignedMsg(
		params: JitSignedMsgIxParams,
		computeBudgetParams?: {
			computeUnits: number;
			computeUnitsPrice: number;
		}
	): Promise<TxSigAndSlot> {
		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: computeBudgetParams?.computeUnits || DEFAULT_CU_LIMIT,
			}),
			ComputeBudgetProgram.setComputeUnitPrice({
				microLamports: computeBudgetParams?.computeUnitsPrice || 0,
			}),
		];

		const signedMsgTakerIxs =
			await this.driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
				params.signedMsgOrderParams,
				params.marketIndex,
				{
					taker: params.takerKey,
					takerStats: params.takerStatsKey,
					takerUserAccount: params.taker,
					signingAuthority: params.authorityToUse,
				},
				ixs
			);
		ixs.push(...signedMsgTakerIxs);

		const ix = await this.getJitSignedMsgIx(params);
		ixs.push(ix);

		const v0Message = new TransactionMessage({
			instructions: ixs,
			payerKey: this.driftClient.wallet.publicKey,
			recentBlockhash: (
				await this.driftClient.txHandler.getLatestBlockhashForTransaction()
			).blockhash,
		}).compileToV0Message(await this.driftClient.fetchAllLookupTableAccounts());
		const tx = new VersionedTransaction(v0Message);

		return await this.driftClient.txSender.sendVersionedTransaction(tx);
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
		} else {
			if (hasBuilder(order)) {
				remainingAccounts.push({
					pubkey: getRevenueShareEscrowAccountPublicKey(
						this.program.programId,
						taker.authority
					),
					isWritable: true,
					isSigner: false,
				});
			}
		}

		const jitParams = {
			takerOrderId,
			maxPosition,
			minPosition,
			bid,
			ask,
			postOnly: validatePostOnlyParams(postOnly),
			priceType: validatePriceType(priceType),
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

	public async getJitSignedMsgIx({
		takerKey,
		takerStatsKey,
		taker,
		maxPosition,
		minPosition,
		bid,
		ask,
		postOnly = null,
		priceType = PriceType.LIMIT,
		referrerInfo,
		subAccountId,
		uuid,
		marketIndex,
		signedMsgOrderParams,
		authorityToUse,
	}: JitSignedMsgIxParams): Promise<TransactionInstruction> {
		subAccountId =
			subAccountId !== undefined
				? subAccountId
				: this.driftClient.activeSubAccountId;
		const remainingAccounts = this.driftClient.getRemainingAccounts({
			userAccounts: [taker, this.driftClient.getUserAccount(subAccountId)],
			writableSpotMarketIndexes: [],
			writablePerpMarketIndexes: [marketIndex],
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

		const isDelegateSigner = authorityToUse.equals(taker.delegate);
		const borshBuf = Buffer.from(
			signedMsgOrderParams.orderParams.toString(),
			'hex'
		);

		const signedMessage = this.driftClient.decodeSignedMsgOrderParamsMessage(
			borshBuf,
			isDelegateSigner
		);
		if (
			signedMessage.builderFeeTenthBps !== null &&
			signedMessage.builderIdx !== null
		) {
			remainingAccounts.push({
				pubkey: getRevenueShareEscrowAccountPublicKey(
					this.program.programId,
					taker.authority
				),
				isWritable: true,
				isSigner: false,
			});
		}

		const jitSignedMsgParams = {
			signedMsgOrderUuid: Array.from(uuid),
			maxPosition,
			minPosition,
			bid,
			ask,
			postOnly: validatePostOnlyParams(postOnly),
			priceType: validatePriceType(priceType),
		};

		return this.program.methods
			.jitSignedMsg(jitSignedMsgParams)
			.accounts({
				taker: takerKey,
				takerStats: takerStatsKey,
				takerSignedMsgUserOrders: getSignedMsgUserAccountPublicKey(
					this.driftClient.program.programId,
					taker.authority
				),
				authority: this.driftClient.wallet.payer.publicKey,
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

		const validatedOrderConstraints = orderConstraints.map(
			(orderConstraint) => ({
				...orderConstraint,
				marketType: validateMarketType(orderConstraint.marketType),
			})
		);

		return this.program.methods
			.checkOrderConstraints(validatedOrderConstraints)
			.accounts({
				user: await this.driftClient.getUserAccountPublicKey(subAccountId),
			})
			.remainingAccounts(remainingAccounts)
			.instruction();
	}

	public async arbPerp(
		params: {
			makerInfos: MakerInfo[];
			marketIndex: number;
		},
		txParams?: TxParams
	): Promise<TxSigAndSlot> {
		const ix = await this.getArbPerpIx(params);
		const tx = await this.driftClient.buildTransaction([ix], txParams);
		return await this.driftClient.sendTransaction(tx);
	}

	public async getArbPerpIx({
		makerInfos,
		marketIndex,
		referrerInfo,
	}: {
		makerInfos: MakerInfo[];
		marketIndex: number;
		referrerInfo?: ReferrerInfo;
	}): Promise<TransactionInstruction> {
		const userAccounts = [this.driftClient.getUserAccount()];
		for (const makerInfo of makerInfos) {
			userAccounts.push(makerInfo.makerUserAccount);
		}

		const remainingAccounts = this.driftClient.getRemainingAccounts({
			userAccounts,
			writablePerpMarketIndexes: [marketIndex],
		});

		for (const makerInfo of makerInfos) {
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: makerInfo.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		if (referrerInfo) {
			const referrerIsMaker =
				makerInfos.find((maker) =>
					maker.maker.equals(referrerInfo.referrer)
				) !== undefined;
			if (!referrerIsMaker) {
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
		}

		return this.program.methods
			.arbPerp(marketIndex)
			.accounts({
				state: await this.driftClient.getStatePublicKey(),
				user: await this.driftClient.getUserAccountPublicKey(),
				userStats: this.driftClient.getUserStatsAccountPublicKey(),
				driftProgram: this.driftClient.program.programId,
			})
			.remainingAccounts(remainingAccounts)
			.instruction();
	}
}
