import { base64, bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import fs from 'fs';
import { logger } from './logger';
import {
	BASE_PRECISION,
	BN,
	DLOB,
	DLOBNode,
	DataAndSlot,
	DriftClient,
	HeliusPriorityLevel,
	JupiterClient,
	DriftEnv,
	MakerInfo,
	MarketType,
	NodeToFill,
	NodeToTrigger,
	OraclePriceData,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	PerpMarketAccount,
	PriorityFeeSubscriber,
	QUOTE_PRECISION,
	SpotMarketAccount,
	User,
	Wallet,
	convertToNumber,
	getOrderSignature,
	getVariant,
	WhileValidTxSender,
	PriorityFeeSubscriberMap,
	isOneOfVariant,
	PhoenixV1FulfillmentConfigAccount,
	PhoenixSubscriber,
	BulkAccountLoader,
	PollingDriftClientAccountSubscriber,
	isVariant,
	SpotMarketConfig,
	PerpMarketConfig,
	DRIFT_ORACLE_RECEIVER_ID,
	OpenbookV2FulfillmentConfigAccount,
	OpenbookV2Subscriber,
	OracleInfo,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	Order,
	isFallbackAvailableLiquiditySource,
	calculateBaseAssetAmountForAmmToFulfill,
	isOrderExpired,
	MMOraclePriceData,
	StateAccount,
	PythLazerSubscriber,
} from '@drift-labs/sdk';
import {
	NATIVE_MINT,
	createAssociatedTokenAccountInstruction,
	createCloseAccountInstruction,
	getAssociatedTokenAddress,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PythLazerSubscriber as PythLazerSubscriberDeprecated } from './pythLazerSubscriber';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	Connection,
	Keypair,
	PublicKey,
	Transaction,
	TransactionError,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { webhookMessage } from './webhook';
import { FallbackLiquiditySource } from './experimental-bots/filler-common/types';

// devnet only
export const TOKEN_FAUCET_PROGRAM_ID = new PublicKey(
	'V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB'
);

export const MEMO_PROGRAM_ID = new PublicKey(
	'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
);

const JUPITER_SLIPPAGE_BPS = 100;
export const PRIORITY_FEE_SERVER_RATE_LIMIT_PER_MIN = 300;

export async function getOrCreateAssociatedTokenAccount(
	connection: Connection,
	mint: PublicKey,
	wallet: Wallet
): Promise<PublicKey> {
	const associatedTokenAccount = await getAssociatedTokenAddress(
		mint,
		wallet.publicKey
	);

	const accountInfo = await connection.getAccountInfo(associatedTokenAccount);
	if (accountInfo == null) {
		const tx = new Transaction().add(
			createAssociatedTokenAccountInstruction(
				wallet.publicKey,
				associatedTokenAccount,
				wallet.publicKey,
				mint
			)
		);
		const txSig = await connection.sendTransaction(tx, [wallet.payer]);
		const latestBlock = await connection.getLatestBlockhash();
		await connection.confirmTransaction(
			{
				signature: txSig,
				blockhash: latestBlock.blockhash,
				lastValidBlockHeight: latestBlock.lastValidBlockHeight,
			},
			'confirmed'
		);
	}

	return associatedTokenAccount;
}

export function loadCommaDelimitToArray(str: string): number[] {
	try {
		return str
			.split(',')
			.filter((element) => {
				if (element.trim() === '') {
					return false;
				}

				return !isNaN(Number(element));
			})
			.map((element) => {
				return Number(element);
			});
	} catch (e) {
		return [];
	}
}

export function parsePositiveIntArray(
	intArray: string | undefined,
	separator = ','
): number[] | undefined {
	if (!intArray) {
		return undefined;
	}
	return intArray
		.split(separator)
		.map((s) => s.trim())
		.map((s) => parseInt(s))
		.filter((n) => !isNaN(n) && n >= 0);
}

export function loadCommaDelimitToStringArray(str: string): string[] {
	try {
		return str.split(',').filter((element) => {
			return element.trim() !== '';
		});
	} catch (e) {
		return [];
	}
}

export function convertToMarketType(input: string): MarketType {
	switch (input.toUpperCase()) {
		case 'PERP':
			return MarketType.PERP;
		case 'SPOT':
			return MarketType.SPOT;
		default:
			throw new Error(`Invalid market type: ${input}`);
	}
}

export function loadKeypair(privateKey: string): Keypair {
	// try to load privateKey as a filepath
	let loadedKey: Uint8Array;
	if (fs.existsSync(privateKey)) {
		logger.info(`loading private key from ${privateKey}`);
		privateKey = fs.readFileSync(privateKey).toString();
	}

	if (privateKey.includes('[') && privateKey.includes(']')) {
		logger.info(`Trying to load private key as numbers array`);
		loadedKey = Uint8Array.from(JSON.parse(privateKey));
	} else if (privateKey.includes(',')) {
		logger.info(`Trying to load private key as comma separated numbers`);
		loadedKey = Uint8Array.from(
			privateKey.split(',').map((val) => Number(val))
		);
	} else {
		logger.info(`Trying to load private key as base58 string`);
		privateKey = privateKey.replace(/\s/g, '');
		loadedKey = new Uint8Array(bs58.decode(privateKey));
	}

	return Keypair.fromSecretKey(Uint8Array.from(loadedKey));
}

export function getWallet(privateKeyOrFilepath: string): [Keypair, Wallet] {
	const keypair = loadKeypair(privateKeyOrFilepath);
	return [keypair, new Wallet(keypair)];
}

export function sleepMs(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepS(s: number) {
	return sleepMs(s * 1000);
}

export function decodeName(bytes: number[]): string {
	const buffer = Buffer.from(bytes);
	return buffer.toString('utf8').trim();
}

export function getNodeToFillSignature(node: NodeToFill): string {
	if (!node.node.userAccount) {
		return '~';
	}
	return `${node.node.userAccount}-${node.node.order?.orderId.toString()}`;
}

export function getFillSignatureFromUserAccountAndOrderId(
	userAccount: string,
	orderId: string
): string {
	return `${userAccount}-${orderId}`;
}

export function getNodeToTriggerSignature(node: NodeToTrigger): string {
	return getOrderSignature(node.node.order.orderId, node.node.userAccount);
}

export async function waitForAllSubscribesToFinish(
	subscriptionPromises: Promise<boolean>[]
): Promise<boolean> {
	const results = await Promise.all(subscriptionPromises);
	const falsePromises = subscriptionPromises.filter(
		(_, index) => !results[index]
	);
	if (falsePromises.length > 0) {
		logger.info('waiting to subscribe to DriftClient and User');
		await sleepMs(1000);
		return waitForAllSubscribesToFinish(falsePromises);
	} else {
		return true;
	}
}

export function getBestLimitBidExcludePubKey<T extends MarketType>(
	dlob: DLOB,
	marketIndex: number,
	marketType: T,
	slot: number,
	oraclePriceData: T extends { spot: unknown }
		? OraclePriceData
		: MMOraclePriceData,
	excludedPubKey: string,
	excludedUserAccountsAndOrder?: [string, number][]
): DLOBNode | undefined {
	const bids = dlob.getRestingLimitBids(
		marketIndex,
		slot,
		marketType,
		oraclePriceData
	);

	for (const bid of bids) {
		if (bid.userAccount === excludedPubKey) {
			continue;
		}
		if (
			excludedUserAccountsAndOrder?.some(
				(entry) =>
					entry[0] === (bid.userAccount ?? '') &&
					entry[1] === (bid.order?.orderId ?? -1)
			)
		) {
			continue;
		}
		return bid;
	}

	return undefined;
}

export function getBestLimitAskExcludePubKey<T extends MarketType>(
	dlob: DLOB,
	marketIndex: number,
	marketType: T,
	slot: number,
	oraclePriceData: T extends { spot: unknown }
		? OraclePriceData
		: MMOraclePriceData,
	excludedPubKey: string,
	excludedUserAccountsAndOrder?: [string, number][]
): DLOBNode | undefined {
	const asks = dlob.getRestingLimitAsks(
		marketIndex,
		slot,
		marketType,
		oraclePriceData
	);
	for (const ask of asks) {
		if (ask.userAccount === excludedPubKey) {
			continue;
		}
		if (
			excludedUserAccountsAndOrder?.some(
				(entry) =>
					entry[0] === (ask.userAccount ?? '') &&
					entry[1] === (ask.order?.orderId || -1)
			)
		) {
			continue;
		}

		return ask;
	}

	return undefined;
}

export function calculateAccountValueUsd(user: User): number {
	const netSpotValue = convertToNumber(
		user.getNetSpotMarketValue(),
		QUOTE_PRECISION
	);
	const unrealizedPnl = convertToNumber(
		user.getUnrealizedPNL(true, undefined, undefined),
		QUOTE_PRECISION
	);
	return netSpotValue + unrealizedPnl;
}

export function calculateBaseAmountToMarketMakePerp(
	perpMarketAccount: PerpMarketAccount,
	user: User,
	targetLeverage = 1
) {
	const basePriceNormed = convertToNumber(
		perpMarketAccount.amm.historicalOracleData.lastOraclePriceTwap
	);

	const accountValueUsd = calculateAccountValueUsd(user);

	targetLeverage *= 0.95;

	const maxBase = (accountValueUsd / basePriceNormed) * targetLeverage;
	const marketSymbol = decodeName(perpMarketAccount.name);

	logger.info(
		`(mkt index: ${marketSymbol}) base to market make (targetLvg=${targetLeverage.toString()}): ${maxBase.toString()} = ${accountValueUsd.toString()} / ${basePriceNormed.toString()} * ${targetLeverage.toString()}`
	);

	return maxBase;
}

export function calculateBaseAmountToMarketMakeSpot(
	spotMarketAccount: SpotMarketAccount,
	user: User,
	targetLeverage = 1
) {
	const basePriceNormalized = convertToNumber(
		spotMarketAccount.historicalOracleData.lastOraclePriceTwap
	);

	const accountValueUsd = calculateAccountValueUsd(user);

	targetLeverage *= 0.95;

	const maxBase = (accountValueUsd / basePriceNormalized) * targetLeverage;
	const marketSymbol = decodeName(spotMarketAccount.name);

	logger.info(
		`(mkt index: ${marketSymbol}) base to market make (targetLvg=${targetLeverage.toString()}): ${maxBase.toString()} = ${accountValueUsd.toString()} / ${basePriceNormalized.toString()} * ${targetLeverage.toString()}`
	);

	return maxBase;
}

export function isMarketVolatile(
	perpMarketAccount: PerpMarketAccount,
	oraclePriceData: OraclePriceData,
	volatileThreshold = 0.005 // 50 bps
) {
	const twapPrice =
		perpMarketAccount.amm.historicalOracleData.lastOraclePriceTwap5Min;
	const lastPrice = perpMarketAccount.amm.historicalOracleData.lastOraclePrice;
	const currentPrice = oraclePriceData.price;
	const minDenom = BN.min(BN.min(currentPrice, lastPrice), twapPrice);
	const cVsL =
		Math.abs(
			currentPrice.sub(lastPrice).mul(PRICE_PRECISION).div(minDenom).toNumber()
		) / PERCENTAGE_PRECISION.toNumber();
	const cVsT =
		Math.abs(
			currentPrice.sub(twapPrice).mul(PRICE_PRECISION).div(minDenom).toNumber()
		) / PERCENTAGE_PRECISION.toNumber();

	const recentStd =
		perpMarketAccount.amm.oracleStd
			.mul(PRICE_PRECISION)
			.div(minDenom)
			.toNumber() / PERCENTAGE_PRECISION.toNumber();

	if (
		recentStd > volatileThreshold ||
		cVsT > volatileThreshold ||
		cVsL > volatileThreshold
	) {
		return true;
	}

	return false;
}

export function isSpotMarketVolatile(
	spotMarketAccount: SpotMarketAccount,
	oraclePriceData: OraclePriceData,
	volatileThreshold = 0.005
) {
	const twapPrice =
		spotMarketAccount.historicalOracleData.lastOraclePriceTwap5Min;
	const lastPrice = spotMarketAccount.historicalOracleData.lastOraclePrice;
	const currentPrice = oraclePriceData.price;
	const minDenom = BN.min(BN.min(currentPrice, lastPrice), twapPrice);
	const cVsL =
		Math.abs(
			currentPrice.sub(lastPrice).mul(PRICE_PRECISION).div(minDenom).toNumber()
		) / PERCENTAGE_PRECISION.toNumber();
	const cVsT =
		Math.abs(
			currentPrice.sub(twapPrice).mul(PRICE_PRECISION).div(minDenom).toNumber()
		) / PERCENTAGE_PRECISION.toNumber();

	if (cVsT > volatileThreshold || cVsL > volatileThreshold) {
		return true;
	}

	return false;
}
export function isSetComputeUnitsIx(ix: TransactionInstruction): boolean {
	// Compute budget program discriminator is first byte
	// 2: set compute unit limit
	// 3: set compute unit price
	if (ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2) {
		return true;
	}
	return false;
}

const PLACEHOLDER_BLOCKHASH = 'Fdum64WVeej6DeL85REV9NvfSxEJNPZ74DBk7A8kTrKP';
export function getVersionedTransaction(
	payerKey: PublicKey,
	ixs: Array<TransactionInstruction>,
	lookupTableAccounts: AddressLookupTableAccount[],
	recentBlockhash: string
): VersionedTransaction {
	const message = new TransactionMessage({
		payerKey,
		recentBlockhash,
		instructions: ixs,
	}).compileToV0Message(lookupTableAccounts);

	return new VersionedTransaction(message);
}

export type SimulateAndGetTxWithCUsParams = {
	connection: Connection;
	payerPublicKey: PublicKey;
	lookupTableAccounts: AddressLookupTableAccount[];
	/// instructions to simulate and create transaction from
	ixs: Array<TransactionInstruction>;
	/// multiplier to apply to the estimated CU usage, default: 1.0
	cuLimitMultiplier?: number;
	/// minimum CU limit to use, will not use a min CU if not set
	minCuLimit?: number;
	/// set false to only create a tx without simulating for CU estimate
	doSimulation?: boolean;
	/// recentBlockhash to use in the final tx. If undefined, PLACEHOLDER_BLOCKHASH
	/// will be used for simulation, the final tx will have an empty blockhash so
	/// attempts to sign it will throw.
	recentBlockhash?: string;
	/// set true to dump base64 transaction before and after simulating for CUs
	dumpTx?: boolean;
	removeLastIxPostSim?: boolean; // remove the last instruction post simulation (used for fillers)
};

export type SimulateAndGetTxWithCUsResponse = {
	cuEstimate: number;
	simTxLogs: Array<string> | null;
	simError: TransactionError | string | null;
	simSlot: number;
	simTxDuration: number;
	tx: VersionedTransaction;
};

/**
 * Simulates the instructions in order to determine how many CUs it needs,
 * applies `cuLimitMulitplier` to the estimate and inserts or modifies
 * the CU limit request ix.
 *
 * If `recentBlockhash` is provided, it is used as is to generate the final
 * tx. If it is undefined, uses `PLACEHOLDER_BLOCKHASH` which is a valid
 * blockhash to perform simulation and removes it from the final tx. Signing
 * a tx without a valid blockhash will throw.
 * @param params
 * @returns
 */
export async function simulateAndGetTxWithCUs(
	params: SimulateAndGetTxWithCUsParams
): Promise<SimulateAndGetTxWithCUsResponse> {
	if (params.ixs.length === 0) {
		throw new Error('cannot simulate empty tx');
	}

	let setCULimitIxIdx = -1;
	for (let idx = 0; idx < params.ixs.length; idx++) {
		if (isSetComputeUnitsIx(params.ixs[idx])) {
			setCULimitIxIdx = idx;
			break;
		}
	}

	// if we don't have a set CU limit ix, add one to the beginning
	// otherwise the default CU limit for sim is 400k, which may be too low
	if (setCULimitIxIdx === -1) {
		params.ixs.unshift(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 1_400_000,
			})
		);
		setCULimitIxIdx = 0;
	}
	let simTxDuration = 0;

	const tx = getVersionedTransaction(
		params.payerPublicKey,
		params.ixs,
		params.lookupTableAccounts,
		params.recentBlockhash ?? PLACEHOLDER_BLOCKHASH
	);

	if (!params.doSimulation) {
		return {
			cuEstimate: -1,
			simTxLogs: null,
			simError: null,
			simSlot: -1,
			simTxDuration,
			tx,
		};
	}
	if (params.dumpTx) {
		console.log(`===== Simulating The following transaction =====`);
		const serializedTx = base64.encode(Buffer.from(tx.serialize()));
		console.log(serializedTx);
		console.log(`================================================`);
	}

	let resp;
	try {
		const start = Date.now();
		resp = await params.connection.simulateTransaction(tx, {
			sigVerify: false,
			replaceRecentBlockhash: true,
			commitment: 'processed',
		});
		simTxDuration = Date.now() - start;
	} catch (e) {
		console.error(e);
		logger.error(`Error simulating transaction: ${JSON.stringify(e)}`);
	}
	if (!resp) {
		throw new Error('Failed to simulate transaction');
	}

	if (resp.value.unitsConsumed === undefined) {
		throw new Error(`Failed to get units consumed from simulateTransaction`);
	}

	const simTxLogs = resp.value.logs;
	const cuEstimate = resp.value.unitsConsumed!;
	const cusToUse = Math.max(
		cuEstimate * (params.cuLimitMultiplier ?? 1.0),
		params.minCuLimit ?? 0
	);
	params.ixs[setCULimitIxIdx] = ComputeBudgetProgram.setComputeUnitLimit({
		units: cusToUse,
	});

	const ixsToUse = params.removeLastIxPostSim
		? params.ixs.slice(0, -1)
		: params.ixs;
	const txWithCUs = getVersionedTransaction(
		params.payerPublicKey,
		ixsToUse,
		params.lookupTableAccounts,
		params.recentBlockhash ?? PLACEHOLDER_BLOCKHASH
	);

	if (params.dumpTx) {
		console.log(
			`== Simulation result, cuEstimate: ${cuEstimate}, using: ${cusToUse}, blockhash: ${params.recentBlockhash} ==`
		);
		const serializedTx = base64.encode(Buffer.from(txWithCUs.serialize()));
		console.log(serializedTx);
		console.log(`================================================`);
	}

	// strip out the placeholder blockhash so user doesn't try to send the tx.
	// sending a tx with placeholder blockhash will cause `blockhash not found error`
	// which is suppressed if flight checks are skipped.
	if (!params.recentBlockhash) {
		txWithCUs.message.recentBlockhash = '';
	}

	return {
		cuEstimate,
		simTxLogs,
		simTxDuration,
		simError: resp.value.err,
		simSlot: resp.context.slot,
		tx: txWithCUs,
	};
}

export function handleSimResultError(
	simResult: SimulateAndGetTxWithCUsResponse,
	errorCodesToSuppress: number[],
	msgSuffix: string,
	suppressOutOfCUsMessage = true,
	suppressErrorString?: string
): undefined | number {
	if (
		(simResult.simError as ExtendedTransactionError).InstructionError ===
		undefined
	) {
		return;
	}
	const err = (simResult.simError as ExtendedTransactionError).InstructionError;
	if (!err) {
		return;
	}
	if (err.length < 2) {
		logger.error(
			`${msgSuffix} sim error has no error code. ${JSON.stringify(simResult)}`
		);
		return;
	}
	if (!err[1]) {
		return;
	}

	let errorCode: number | undefined;

	const shouldSuppressByString =
		suppressErrorString !== undefined &&
		Array.isArray(simResult.simTxLogs) &&
		simResult.simTxLogs.some((line) => line.includes(suppressErrorString));

	if (typeof err[1] === 'object' && 'Custom' in err[1]) {
		const customErrorCode = Number((err[1] as CustomError).Custom);
		errorCode = customErrorCode;
		if (errorCodesToSuppress.includes(customErrorCode)) {
			return errorCode;
		} else {
			const msg = `${msgSuffix} sim error with custom error code, simError: ${JSON.stringify(
				simResult.simError
			)}, cuEstimate: ${simResult.cuEstimate}, sim logs:\n${
				simResult.simTxLogs ? simResult.simTxLogs.join('\n') : 'none'
			}`;
			if (!shouldSuppressByString) {
				webhookMessage(msg, process.env.TX_LOG_WEBHOOK_URL);
			}
			logger.error(msg);
		}
	} else {
		const msg = `${msgSuffix} sim error with no error code, simError: ${JSON.stringify(
			simResult.simError
		)}, cuEstimate: ${simResult.cuEstimate}, sim logs:\n${
			simResult.simTxLogs ? simResult.simTxLogs.join('\n') : 'none'
		}`;
		logger.error(msg);

		// early return if out of CU error.
		if (
			suppressOutOfCUsMessage &&
			simResult.simTxLogs &&
			simResult.simTxLogs[simResult.simTxLogs.length - 1].includes(
				'exceeded CUs meter at BPF instruction'
			)
		) {
			return errorCode;
		}

		if (!shouldSuppressByString) {
			webhookMessage(msg, process.env.TX_LOG_WEBHOOK_URL);
		}
	}

	return errorCode;
}

export interface ExtendedTransactionError {
	InstructionError?: [number, string | object];
}

export interface CustomError {
	Custom?: number;
}

export function logMessageForNodeToFill(
	node: NodeToFill,
	takerUser: string,
	takerUserSlot: number,
	makerInfos: Array<DataAndSlot<MakerInfo>>,
	currSlot: number,
	fillId: number,
	fillType: string,
	revertOnFailure: boolean,
	removeLastIxPreSim: boolean,
	fallbackSource?: FallbackLiquiditySource,
	basePrecision: BN = BASE_PRECISION
) {
	const takerNode = node.node;
	const takerOrder = takerNode.order;
	if (!takerOrder) {
		return 'no taker order';
	}

	if (node.makerNodes.length !== makerInfos.length) {
		logger.error(
			`makerNodes and makerInfos length mismatch, makerNodes: ${node.makerNodes.length}, makerInfos: ${makerInfos.length}`
		);
	}

	// json log might be inefficient, but makes log parsing easier
	logger.info(
		'fill attempt: ' +
			JSON.stringify({
				marketIndex: takerOrder.marketIndex,
				marketType: getVariant(takerOrder.marketType),
				taker: takerUser,
				takerOrderId: takerOrder.orderId,
				takerOrderDirection: getVariant(takerOrder.direction),
				takerSlot: takerUserSlot,
				currSlot,
				takerBaseAssetAmountFilled: convertToNumber(
					takerOrder.baseAssetAmountFilled,
					basePrecision
				),
				takerBaseAssetAmount: convertToNumber(
					takerOrder.baseAssetAmount,
					basePrecision
				),
				takerPrice: convertToNumber(takerOrder.price, PRICE_PRECISION),
				takerOrderPrice: getVariant(takerOrder.orderType),
				takerOrderPriceOffset:
					takerOrder.oraclePriceOffset / PRICE_PRECISION.toNumber(),
				makers: makerInfos.length,
				fillType,
				fillId,
				revertOnFailure,
				removeLastIxPreSim,
				isSignedMsg: node.node.isSignedMsg,
				fallbackSource,
			})
	);

	if (makerInfos.length > 0) {
		for (let i = 0; i < makerInfos.length; i++) {
			const maker = makerInfos[i].data;
			const makerSlot = makerInfos[i].slot;
			const makerOrder = maker.order!;
			logger.info(
				'fill attempt maker: ' +
					JSON.stringify({
						marketIndex: makerOrder.marketIndex,
						marketType: getVariant(makerOrder.marketType),
						makerIdx: i,
						maker: maker.maker.toBase58(),
						makerSlot: makerSlot,
						makerOrderId: makerOrder.orderId,
						makerOrderType: getVariant(makerOrder.orderType),
						makerOrderMarketIndex: makerOrder.marketIndex,
						makerOrderDirection: getVariant(makerOrder.direction),
						makerOrderBaseAssetAmountFilled: convertToNumber(
							makerOrder.baseAssetAmountFilled,
							basePrecision
						),
						makerOrderBaseAssetAmount: convertToNumber(
							makerOrder.baseAssetAmount,
							basePrecision
						),
						makerOrderPrice: convertToNumber(makerOrder.price, PRICE_PRECISION),
						makerOrderPriceOffset:
							makerOrder.oraclePriceOffset / PRICE_PRECISION.toNumber(),
						fillType,
						fillId,
						revertOnFailure,
						removeLastIxPreSim,
					})
			);
		}
	}
}

export function getTransactionAccountMetas(
	tx: VersionedTransaction,
	lutAccounts: Array<AddressLookupTableAccount>
): {
	estTxSize: number;
	accountMetas: any[];
	writeAccs: number;
	txAccounts: number;
} {
	let writeAccs = 0;
	const accountMetas: any[] = [];
	const estTxSize = tx.message.serialize().length;
	const acc = tx.message.getAccountKeys({
		addressLookupTableAccounts: lutAccounts,
	});
	const txAccounts = acc.length;
	for (let i = 0; i < txAccounts; i++) {
		const meta: any = {};
		if (tx.message.isAccountWritable(i)) {
			writeAccs++;
			meta['writeable'] = true;
		}
		if (tx.message.isAccountSigner(i)) {
			meta['signer'] = true;
		}
		meta['address'] = acc.get(i)!.toBase58();
		accountMetas.push(meta);
	}

	return {
		estTxSize,
		accountMetas,
		writeAccs,
		txAccounts,
	};
}

export async function swapFillerHardEarnedUSDCForSOL(
	priorityFeeSubscriber: PriorityFeeSubscriber | PriorityFeeSubscriberMap,
	driftClient: DriftClient,
	jupiterClient: JupiterClient,
	blockhash: string,
	subaccount?: number
) {
	try {
		const usdc = driftClient.getUser(subaccount).getTokenAmount(0);
		const sol = driftClient.getUser(subaccount).getTokenAmount(1);

		console.log(
			`${driftClient.authority.toBase58()} has ${convertToNumber(
				usdc,
				QUOTE_PRECISION
			)} usdc, ${convertToNumber(sol, BASE_PRECISION)} sol`
		);

		const usdcMarket = driftClient.getSpotMarketAccount(0);
		const solMarket = driftClient.getSpotMarketAccount(1);

		if (!usdcMarket || !solMarket) {
			console.log('Market not found, skipping...');
			return;
		}

		const inPrecision = new BN(10).pow(new BN(usdcMarket.decimals));
		const outPrecision = new BN(10).pow(new BN(solMarket.decimals));

		if (usdc.lt(new BN(1).mul(QUOTE_PRECISION))) {
			console.log(
				`${driftClient.authority.toBase58()} not enough USDC to swap (${convertToNumber(
					usdc,
					QUOTE_PRECISION
				)}), skipping...`
			);
			return;
		}

		const start = performance.now();
		const quote = await jupiterClient.getQuote({
			inputMint: usdcMarket.mint,
			outputMint: solMarket.mint,
			amount: usdc.sub(new BN(1)),
			maxAccounts: 10,
			slippageBps: JUPITER_SLIPPAGE_BPS,
			swapMode: 'ExactIn',
		});

		const quoteInNum = convertToNumber(new BN(quote.inAmount), inPrecision);
		const quoteOutNum = convertToNumber(new BN(quote.outAmount), outPrecision);
		const swapPrice = quoteInNum / quoteOutNum;
		const oracleData = driftClient.getOracleDataForSpotMarket(1);
		if (!oracleData) {
			console.log('Oracle data not found, skipping...');
			return;
		}
		const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);

		if (swapPrice / oraclePrice - 1 > 0.01) {
			console.log(`Swap price is 1% higher than oracle price, skipping...`);
			return;
		}

		console.log(
			`Quoted ${quoteInNum} USDC for ${quoteOutNum} SOL, swapPrice: ${swapPrice}, oraclePrice: ${oraclePrice}`
		);

		const driftLuts = await driftClient.fetchAllLookupTableAccounts();

		const transaction = await jupiterClient.getSwap({
			quote,
			userPublicKey: driftClient.provider.wallet.publicKey,
			slippageBps: JUPITER_SLIPPAGE_BPS,
		});

		const { transactionMessage, lookupTables } =
			await jupiterClient.getTransactionMessageAndLookupTables({
				transaction,
			});

		const jupiterInstructions = jupiterClient.getJupiterInstructions({
			transactionMessage,
			inputMint: usdcMarket.mint,
			outputMint: solMarket.mint,
		});

		const preInstructions = [];

		const withdrawerWrappedSolAta = getAssociatedTokenAddressSync(
			NATIVE_MINT,
			driftClient.authority
		);

		const solAccountInfo = await driftClient.connection.getAccountInfo(
			withdrawerWrappedSolAta
		);

		if (!solAccountInfo) {
			preInstructions.push(
				driftClient.createAssociatedTokenAccountIdempotentInstruction(
					withdrawerWrappedSolAta,
					driftClient.provider.wallet.publicKey,
					driftClient.provider.wallet.publicKey,
					solMarket.mint
				)
			);
		}

		const withdrawerUsdcAta = await driftClient.getAssociatedTokenAccount(0);

		const usdcAccountInfo = await driftClient.connection.getAccountInfo(
			withdrawerUsdcAta
		);

		if (!usdcAccountInfo) {
			preInstructions.push(
				driftClient.createAssociatedTokenAccountIdempotentInstruction(
					withdrawerUsdcAta,
					driftClient.provider.wallet.publicKey,
					driftClient.provider.wallet.publicKey,
					usdcMarket.mint
				)
			);
		}

		const withdrawIx = await driftClient.getWithdrawIx(
			usdc.muln(10), // gross overestimate just to get everything out of the account
			0,
			withdrawerUsdcAta,
			true,
			subaccount
		);

		const closeAccountInstruction = createCloseAccountInstruction(
			withdrawerWrappedSolAta,
			driftClient.authority,
			driftClient.authority
		);

		const ixs = [
			...preInstructions,
			withdrawIx,
			...jupiterInstructions,
			closeAccountInstruction,
		];

		const buildTx = (cu: number): VersionedTransaction => {
			return getVersionedTransaction(
				driftClient.txSender.wallet.publicKey,
				[
					ComputeBudgetProgram.setComputeUnitLimit({
						units: cu,
					}),
					ComputeBudgetProgram.setComputeUnitPrice({
						microLamports:
							priorityFeeSubscriber instanceof PriorityFeeSubscriberMap
								? Math.floor(
										priorityFeeSubscriber.getPriorityFees('spot', 0)!.low * 1.1
								  )
								: Math.floor(
										priorityFeeSubscriber.getHeliusPriorityFeeLevel(
											HeliusPriorityLevel.LOW
										) * 1.1
								  ),
					}),
					...ixs,
				],
				[...lookupTables, ...driftLuts],
				blockhash
			);
		};

		const simTxResult = await driftClient.connection.simulateTransaction(
			buildTx(1_400_000),
			{
				replaceRecentBlockhash: true,
				commitment: 'confirmed',
			}
		);

		if (simTxResult.value.err) {
			console.log('Sim error:');
			console.error(simTxResult.value.err);
			console.log('Sim logs:');
			console.log(simTxResult.value.logs);
			console.log(`Units consumed: ${simTxResult.value.unitsConsumed}`);
			return;
		}

		console.log(
			`${driftClient.authority.toBase58()} sending swap tx... ${
				performance.now() - start
			}`
		);

		const txSender = new WhileValidTxSender({
			connection: driftClient.connection,
			wallet: driftClient.wallet,
			retrySleep: 1000,
		});

		const txSigAndSlot = await txSender.sendVersionedTransaction(
			// @ts-ignore
			buildTx(Math.floor(simTxResult.value.unitsConsumed * 1.2)),
			[],
			driftClient.opts
		);
		console.log(`Swap tx: https://solana.fm/tx/${txSigAndSlot.txSig}`);
	} catch (e) {
		console.error(e);
	}
}
export function getDriftPriorityFeeEndpoint(driftEnv: DriftEnv): string {
	switch (driftEnv) {
		case 'devnet':
		case 'mainnet-beta':
			return 'https://dlob.drift.trade';
	}
}

export function validMinimumGasAmount(amount: number | undefined): boolean {
	if (amount === undefined || amount < 0) {
		return false;
	}
	return true;
}

export function validRebalanceSettledPnlThreshold(
	amount: number | undefined
): boolean {
	if (amount === undefined || amount < 1 || !Number.isInteger(amount)) {
		return false;
	}
	return true;
}

export const getStaleOracleMarketIndexes = (
	driftClient: DriftClient,
	markets: (PerpMarketConfig | SpotMarketConfig)[],
	marketType: MarketType,
	numFeeds = 2
) => {
	let oracleInfos: { oracleInfo: OraclePriceData; marketIndex: number }[] =
		markets
			.map((market) => {
				if (isVariant(marketType, 'perp')) {
					const oracleInfo = driftClient.getOracleDataForPerpMarket(
						market.marketIndex
					);
					if (!oracleInfo) return null;
					return {
						oracleInfo,
						marketIndex: market.marketIndex,
					};
				} else {
					const oracleInfo = driftClient.getOracleDataForSpotMarket(
						market.marketIndex
					);
					if (!oracleInfo) return null;
					return {
						oracleInfo,
						marketIndex: market.marketIndex,
					};
				}
			})
			.filter(
				(item): item is { oracleInfo: OraclePriceData; marketIndex: number } =>
					item !== null
			);
	oracleInfos = oracleInfos.sort(
		(a, b) => a.oracleInfo.slot.toNumber() - b.oracleInfo.slot.toNumber()
	);
	return oracleInfos
		.slice(0, numFeeds)
		.map((oracleInfo) => oracleInfo.marketIndex);
};

export const getAllPythOracleUpdateIxs = async (
	marketIndex: number,
	driftClient: DriftClient,
	pythLazerSubscriber?: PythLazerSubscriber | PythLazerSubscriberDeprecated,
	precedingIxs: TransactionInstruction[] = []
): Promise<TransactionInstruction[]> => {
	const updateMessage =
		await pythLazerSubscriber?.getLatestPriceMessageForMarketIndex(marketIndex);
	const feedIds =
		pythLazerSubscriber?.getPriceFeedIdsFromMarketIndex(marketIndex);
	if (!updateMessage || !feedIds) {
		logger.debug(
			'No update message or feed ids found for marketIndex',
			marketIndex
		);
		return [];
	}
	return await driftClient.getPostPythLazerOracleUpdateIxs(
		feedIds,
		updateMessage,
		precedingIxs
	);
};

export function canFillSpotMarket(spotMarket: SpotMarketAccount): boolean {
	if (
		isOneOfVariant(spotMarket.status, ['initialized', 'fillPaused', 'delisted'])
	) {
		logger.info(
			`Skipping market ${decodeName(
				spotMarket.name
			)} because its SpotMarket.status is ${getVariant(spotMarket.status)}`
		);
		return false;
	}
	return true;
}

export async function initializeSpotFulfillmentAccounts(
	driftClient: DriftClient,
	includeSubscribers = true,
	marketsOfInterest?: number[]
): Promise<{
	phoenixFulfillmentConfigs: Map<number, PhoenixV1FulfillmentConfigAccount>;
	openbookFulfillmentConfigs: Map<number, OpenbookV2FulfillmentConfigAccount>;
	phoenixSubscribers?: Map<number, PhoenixSubscriber>;
	openbookSubscribers?: Map<number, OpenbookV2Subscriber>;
}> {
	const phoenixFulfillmentConfigs = new Map<
		number,
		PhoenixV1FulfillmentConfigAccount
	>();
	const openbookFulfillmentConfigs = new Map<
		number,
		OpenbookV2FulfillmentConfigAccount
	>();
	const phoenixSubscribers = includeSubscribers
		? new Map<number, PhoenixSubscriber>()
		: undefined;
	const openbookSubscribers = includeSubscribers
		? new Map<number, OpenbookV2Subscriber>()
		: undefined;

	let accountSubscription:
		| {
				type: 'polling';
				accountLoader: BulkAccountLoader;
		  }
		| {
				type: 'websocket';
		  };
	if (
		(driftClient.accountSubscriber as PollingDriftClientAccountSubscriber)
			.accountLoader
	) {
		accountSubscription = {
			type: 'polling',
			accountLoader: (
				driftClient.accountSubscriber as PollingDriftClientAccountSubscriber
			).accountLoader,
		};
	} else {
		accountSubscription = {
			type: 'websocket',
		};
	}
	const marketSetupPromises: Promise<void>[] = [];
	const subscribePromises: Promise<void>[] = [];

	marketSetupPromises.push(
		new Promise((resolve) => {
			(async () => {
				const phoenixMarketConfigs =
					await driftClient.getPhoenixV1FulfillmentConfigs();
				for (const config of phoenixMarketConfigs) {
					if (
						marketsOfInterest &&
						!marketsOfInterest.includes(config.marketIndex)
					) {
						continue;
					}
					const spotMarket = driftClient.getSpotMarketAccount(
						config.marketIndex
					);
					if (!spotMarket) {
						logger.warn(
							`SpotMarket not found for PhoenixV1FulfillmentConfig for marketIndex: ${config.marketIndex}`
						);
						continue;
					}
					const symbol = decodeName(spotMarket.name);

					phoenixFulfillmentConfigs.set(config.marketIndex, config);

					if (includeSubscribers && isVariant(config.status, 'enabled')) {
						// set up phoenix price subscriber
						const phoenixSubscriber = new PhoenixSubscriber({
							connection: driftClient.connection,
							programId: config.phoenixProgramId,
							marketAddress: config.phoenixMarket,
							accountSubscription,
						});
						logger.info(`Initializing PhoenixSubscriber for ${symbol}...`);
						subscribePromises.push(
							phoenixSubscriber.subscribe().then(() => {
								phoenixSubscribers!.set(config.marketIndex, phoenixSubscriber);
							})
						);
					}
				}
				resolve();
			})();
		})
	);

	marketSetupPromises.push(
		new Promise((resolve) => {
			(async () => {
				const openbookMarketConfigs =
					await driftClient.getOpenbookV2FulfillmentConfigs();
				for (const config of openbookMarketConfigs) {
					if (
						marketsOfInterest &&
						!marketsOfInterest.includes(config.marketIndex)
					) {
						continue;
					}

					const spotMarket = driftClient.getSpotMarketAccount(
						config.marketIndex
					);

					if (!spotMarket) {
						logger.warn(
							`SpotMarket not found for OpenbookV2FulfillmentConfig for marketIndex: ${config.marketIndex}`
						);
						continue;
					}

					const symbol = decodeName(spotMarket.name);

					openbookFulfillmentConfigs.set(config.marketIndex, config);

					if (includeSubscribers && isVariant(config.status, 'enabled')) {
						// set up openbook subscriber
						const openbookSubscriber = new OpenbookV2Subscriber({
							connection: driftClient.connection,
							programId: config.openbookV2ProgramId,
							marketAddress: config.openbookV2Market,
							accountSubscription,
						});
						logger.info(`Initializing OpenbookSubscriber for ${symbol}...`);
						subscribePromises.push(
							openbookSubscriber.subscribe().then(() => {
								openbookSubscribers!.set(
									config.marketIndex,
									openbookSubscriber
								);
							})
						);
					}
				}
				resolve();
			})();
		})
	);

	const marketSetupStart = Date.now();
	logger.info(`Waiting for spot market startup...`);
	await Promise.all(marketSetupPromises);
	logger.info(`Market setup finished in ${Date.now() - marketSetupStart}ms`);

	const subscribeStart = Date.now();
	logger.info(`Waiting for spot markets to subscribe...`);
	await Promise.all(subscribePromises);
	logger.info(`Subscribed to spot markets in ${Date.now() - subscribeStart}ms`);

	return {
		phoenixFulfillmentConfigs,
		openbookFulfillmentConfigs,
		phoenixSubscribers,
		openbookSubscribers,
	};
}

export const chunks = <T>(array: readonly T[], size: number): T[][] => {
	return new Array(Math.ceil(array.length / size))
		.fill(null)
		.map((_, index) => index * size)
		.map((begin) => array.slice(begin, begin + size));
};

export const shuffle = <T>(array: T[]): T[] => {
	let currentIndex = array.length,
		randomIndex;

	while (currentIndex !== 0) {
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex--;
		[array[currentIndex], array[randomIndex]] = [
			array[randomIndex],
			array[currentIndex],
		];
	}

	return array;
};

export function removePythIxs(
	ixs: TransactionInstruction[],
	receiverPublicKeyStr: string = DRIFT_ORACLE_RECEIVER_ID
): TransactionInstruction[] {
	return ixs.filter(
		(ix) =>
			!(
				ix.keys
					.map((meta) => meta.pubkey.toString())
					.includes(receiverPublicKeyStr) ||
				ix.keys
					.map((meta) => meta.pubkey.toString())
					.includes(PYTH_LAZER_STORAGE_ACCOUNT_KEY.toString())
			)
	);
}

export function getSizeOfTransaction(
	instructions: TransactionInstruction[],
	versionedTransaction = true,
	addressLookupTables: AddressLookupTableAccount[] = []
): { bytes: number; accounts: number } {
	const programs = new Set<string>();
	const signers = new Set<string>();
	let accounts = new Set<string>();

	instructions.map((ix) => {
		programs.add(ix.programId.toBase58());
		accounts.add(ix.programId.toBase58());
		ix.keys.map((key) => {
			if (key.isSigner) {
				signers.add(key.pubkey.toBase58());
			}
			accounts.add(key.pubkey.toBase58());
		});
	});

	const instruction_sizes: number = instructions
		.map(
			(ix) =>
				1 +
				getSizeOfCompressedU16(ix.keys.length) +
				ix.keys.length +
				getSizeOfCompressedU16(ix.data.length) +
				ix.data.length
		)
		.reduce((a, b) => a + b, 0);

	let numberOfAddressLookups = 0;
	const totalNumberOfAccounts = accounts.size;
	if (addressLookupTables.length > 0) {
		const lookupTableAddresses = addressLookupTables
			.map((addressLookupTable) =>
				addressLookupTable.state.addresses.map((address) => address.toBase58())
			)
			.flat();
		accounts = new Set(
			[...accounts].filter((account) => !lookupTableAddresses.includes(account))
		);
		accounts = new Set([...accounts, ...programs, ...signers]);
		numberOfAddressLookups = totalNumberOfAccounts - accounts.size;
	}

	return {
		bytes:
			getSizeOfCompressedU16(signers.size) +
			signers.size * 64 + // array of signatures
			3 +
			getSizeOfCompressedU16(accounts.size) +
			32 * accounts.size + // array of account addresses
			32 + // recent blockhash
			getSizeOfCompressedU16(instructions.length) +
			instruction_sizes + // array of instructions
			(versionedTransaction ? 1 + getSizeOfCompressedU16(0) : 0) +
			(versionedTransaction ? 32 * addressLookupTables.length : 0) +
			(versionedTransaction && addressLookupTables.length > 0 ? 2 : 0) +
			numberOfAddressLookups,
		accounts: totalNumberOfAccounts,
	};
}

function getSizeOfCompressedU16(n: number) {
	return 1 + Number(n >= 128) + Number(n >= 16384);
}

export async function checkIfAccountExists(
	connection: Connection,
	account: PublicKey
): Promise<boolean> {
	try {
		const accountInfo = await connection.getAccountInfo(account);
		return accountInfo != null;
	} catch (e) {
		// Doesn't already exist
		return false;
	}
}

export function getMarketsAndOracleInfosToLoad(
	sdkConfig: any,
	perpMarketIndicies: number[] | undefined,
	spotMarketIndicies: number[] | undefined
): {
	oracleInfos: OracleInfo[];
	perpMarketIndicies: number[] | undefined;
	spotMarketIndicies: number[] | undefined;
} {
	const oracleInfos: OracleInfo[] = [];
	const oraclesTracked = new Set();

	// only watch all markets if neither env vars are specified
	const noMarketsSpecified = !perpMarketIndicies && !spotMarketIndicies;

	let perpIndexes = perpMarketIndicies;
	if (!perpIndexes) {
		if (noMarketsSpecified) {
			perpIndexes = sdkConfig.PERP_MARKETS.map(
				(m: PerpMarketConfig) => m.marketIndex
			);
		} else {
			perpIndexes = [];
		}
	}
	let spotIndexes = spotMarketIndicies;
	if (!spotIndexes) {
		if (noMarketsSpecified) {
			spotIndexes = sdkConfig.SPOT_MARKETS.map(
				(m: SpotMarketConfig) => m.marketIndex
			);
		} else {
			spotIndexes = [];
		}
	}

	if (perpIndexes && perpIndexes.length > 0) {
		for (const idx of perpIndexes) {
			const perpMarketConfig = sdkConfig.PERP_MARKETS[idx] as PerpMarketConfig;
			if (!perpMarketConfig) {
				throw new Error(`Perp market config for ${idx} not found`);
			}
			const oracleKey =
				perpMarketConfig.oracle.toBase58() +
				getVariant(perpMarketConfig.oracleSource);
			if (!oraclesTracked.has(oracleKey)) {
				logger.info(`Tracking oracle ${oracleKey} for perp market ${idx}`);
				oracleInfos.push({
					publicKey: perpMarketConfig.oracle,
					source: perpMarketConfig.oracleSource,
				});
				oraclesTracked.add(oracleKey);
			}
		}
		logger.info(`Bot tracking perp markets: ${JSON.stringify(perpIndexes)}`);
	}

	if (spotIndexes && spotIndexes.length > 0) {
		for (const idx of spotIndexes) {
			const spotMarketConfig = sdkConfig.SPOT_MARKETS[idx] as SpotMarketConfig;
			if (!spotMarketConfig) {
				throw new Error(`Spot market config for ${idx} not found`);
			}
			const oracleKey = spotMarketConfig.oracle.toBase58();
			if (!oraclesTracked.has(oracleKey)) {
				logger.info(`Tracking oracle ${oracleKey} for spot market ${idx}`);
				oracleInfos.push({
					publicKey: spotMarketConfig.oracle,
					source: spotMarketConfig.oracleSource,
				});
				oraclesTracked.add(oracleKey);
			}
		}
		logger.info(`Bot tracking spot markets: ${JSON.stringify(spotIndexes)}`);
	}

	return {
		oracleInfos,
		perpMarketIndicies:
			perpIndexes && perpIndexes.length > 0 ? perpIndexes : undefined,
		spotMarketIndicies:
			spotIndexes && spotIndexes.length > 0 ? spotIndexes : undefined,
	};
}

export function isSolLstToken(spotMarketIndex: number): boolean {
	return [
		2, // mSOL
		6, // jitoSOL
		8, // bSOL
		16, // INF
		17, // dSOL
		25, // BNSOL
	].includes(spotMarketIndex);
}

export function isFillableByVAMMDetails(
	order: Order,
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	slot: number,
	ts: number,
	state: StateAccount
): {
	fillable: boolean;
	fallbackAvailableLiquiditySource: boolean;
	baseAssetAmountForAmmToFulfill: number;
	minOrderSize: number;
	orderExpired: boolean;
} {
	const fallbackAvailableLiquiditySource = isFallbackAvailableLiquiditySource(
		order,
		mmOraclePriceData,
		slot,
		state,
		market
	);
	const baseAssetAmountForAmmToFulfill =
		calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			mmOraclePriceData,
			slot
		);
	const minOrderSize = market.amm.minOrderSize;
	const orderExpired = isOrderExpired(order, ts);
	return {
		fillable:
			(fallbackAvailableLiquiditySource &&
				baseAssetAmountForAmmToFulfill.gte(minOrderSize)) ||
			orderExpired,
		fallbackAvailableLiquiditySource,
		baseAssetAmountForAmmToFulfill: convertToNumber(
			baseAssetAmountForAmmToFulfill,
			BASE_PRECISION
		),
		minOrderSize: convertToNumber(minOrderSize, BASE_PRECISION),
		orderExpired,
	};
}
