import {
	Connection,
	PublicKey,
	TransactionMessage,
	AddressLookupTableAccount,
	VersionedTransaction,
	TransactionInstruction,
} from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import {
	JupiterClient,
	QuoteResponse as JupiterQuoteResponse,
} from '../jupiter/jupiterClient';
import {
	TitanClient,
	QuoteResponse as TitanQuoteResponse,
	SwapMode as TitanSwapMode,
} from '../titan/titanClient';

export type SwapMode = 'ExactIn' | 'ExactOut';
export type SwapClientType = 'jupiter' | 'titan';

/**
 * Unified quote response interface that combines properties from both Jupiter and Titan
 * This provides a consistent interface while allowing for provider-specific fields
 */
export interface UnifiedQuoteResponse {
	// Core properties available in both providers
	inputMint: string;
	inAmount: string;
	outputMint: string;
	outAmount: string;
	swapMode: SwapMode;
	slippageBps: number;
	routePlan: Array<{ swapInfo: any; percent: number }>;

	// Optional properties that may not be available in all providers
	otherAmountThreshold?: string; // Jupiter has this, Titan doesn't
	priceImpactPct?: string; // Jupiter provides this, Titan doesn't (we calculate it)
	platformFee?: { amount?: string; feeBps?: number }; // Format varies between providers
	contextSlot?: number;
	timeTaken?: number;
	error?: string;
	errorCode?: string;
}

export interface SwapQuoteParams {
	inputMint: PublicKey;
	outputMint: PublicKey;
	amount: BN;
	userPublicKey?: PublicKey; // Required for Titan, optional for Jupiter
	maxAccounts?: number;
	slippageBps?: number;
	swapMode?: SwapMode;
	onlyDirectRoutes?: boolean;
	excludeDexes?: string[];
	sizeConstraint?: number; // Titan-specific
	accountsLimitWritable?: number; // Titan-specific
	autoSlippage?: boolean; // Jupiter-specific
	maxAutoSlippageBps?: number; // Jupiter-specific
	usdEstimate?: number; // Jupiter-specific
}

export interface SwapTransactionParams {
	quote: UnifiedQuoteResponse;
	userPublicKey: PublicKey;
	slippageBps?: number;
}

export interface SwapTransactionResult {
	transaction?: VersionedTransaction; // Jupiter returns this
	transactionMessage?: TransactionMessage; // Titan returns this
	lookupTables?: AddressLookupTableAccount[]; // Titan returns this
}

export class UnifiedSwapClient {
	private client: JupiterClient | TitanClient;
	private clientType: SwapClientType;

	constructor({
		clientType,
		connection,
		authToken,
		url,
		proxyUrl,
	}: {
		clientType: SwapClientType;
		connection: Connection;
		authToken?: string; // Required for Titan when not using proxy, optional for Jupiter
		url?: string; // Optional custom URL
		proxyUrl?: string; // Optional proxy URL for Titan
	}) {
		this.clientType = clientType;

		if (clientType === 'jupiter') {
			this.client = new JupiterClient({
				connection,
				url,
			});
		} else if (clientType === 'titan') {
			this.client = new TitanClient({
				connection,
				authToken: authToken || '', // Not needed when using proxy
				url,
				proxyUrl,
			});
		} else {
			throw new Error(`Unsupported client type: ${clientType}`);
		}
	}

	/**
	 * Get a swap quote from the underlying client
	 */
	public async getQuote(
		params: SwapQuoteParams
	): Promise<UnifiedQuoteResponse> {
		if (this.clientType === 'jupiter') {
			const jupiterClient = this.client as JupiterClient;
			const {
				userPublicKey: _userPublicKey, // Not needed for Jupiter
				sizeConstraint: _sizeConstraint, // Jupiter-specific params to exclude
				accountsLimitWritable: _accountsLimitWritable,
				...jupiterParams
			} = params;

			return await jupiterClient.getQuote(jupiterParams);
		} else {
			const titanClient = this.client as TitanClient;
			const {
				autoSlippage: _autoSlippage, // Titan-specific params to exclude
				maxAutoSlippageBps: _maxAutoSlippageBps,
				usdEstimate: _usdEstimate,
				...titanParams
			} = params;

			if (!titanParams.userPublicKey) {
				throw new Error('userPublicKey is required for Titan quotes');
			}

			// Cast to ensure TypeScript knows userPublicKey is defined
			const titanParamsWithUser = {
				...titanParams,
				userPublicKey: titanParams.userPublicKey,
				swapMode: titanParams.swapMode as string, // Titan expects string
				sizeConstraint: titanParams.sizeConstraint || 1280 - 375, // Use same default as getSwapInstructions
			};

			return await titanClient.getQuote(titanParamsWithUser);
		}
	}

	/**
	 * Get a swap transaction from the underlying client
	 */
	public async getSwap(
		params: SwapTransactionParams
	): Promise<SwapTransactionResult> {
		if (this.clientType === 'jupiter') {
			const jupiterClient = this.client as JupiterClient;
			// Cast the quote to Jupiter's specific QuoteResponse type
			const jupiterParams = {
				...params,
				quote: params.quote as JupiterQuoteResponse,
			};
			const transaction = await jupiterClient.getSwap(jupiterParams);
			return { transaction };
		} else {
			const titanClient = this.client as TitanClient;
			const { quote, userPublicKey, slippageBps } = params;

			// For Titan, we need to reconstruct the parameters from the quote
			const titanQuote = quote as TitanQuoteResponse;
			const result = await titanClient.getSwap({
				inputMint: new PublicKey(titanQuote.inputMint),
				outputMint: new PublicKey(titanQuote.outputMint),
				amount: new BN(titanQuote.inAmount),
				userPublicKey,
				slippageBps: slippageBps || titanQuote.slippageBps,
				swapMode: titanQuote.swapMode,
				sizeConstraint: 1280 - 375, // MAX_TX_BYTE_SIZE - buffer for drift instructions
			});

			return {
				transactionMessage: result.transactionMessage,
				lookupTables: result.lookupTables,
			};
		}
	}

	/**
	 * Get swap instructions from the underlying client (Jupiter or Titan)
	 * This is the core swap logic without any context preparation
	 */
	public async getSwapInstructions({
		inputMint,
		outputMint,
		amount,
		userPublicKey,
		slippageBps,
		swapMode = 'ExactIn',
		onlyDirectRoutes = false,
		quote,
		sizeConstraint,
	}: {
		inputMint: PublicKey;
		outputMint: PublicKey;
		amount: BN;
		userPublicKey: PublicKey;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		quote?: UnifiedQuoteResponse;
		sizeConstraint?: number;
	}): Promise<{
		instructions: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		const isExactOut = swapMode === 'ExactOut';
		let swapInstructions: TransactionInstruction[];
		let lookupTables: AddressLookupTableAccount[];

		if (this.clientType === 'jupiter') {
			const jupiterClient = this.client as JupiterClient;

			// Get quote if not provided
			let finalQuote = quote as JupiterQuoteResponse;
			if (!finalQuote) {
				finalQuote = await jupiterClient.getQuote({
					inputMint,
					outputMint,
					amount,
					slippageBps,
					swapMode,
					onlyDirectRoutes,
				});
			}

			if (!finalQuote) {
				throw new Error('Could not fetch swap quote. Please try again.');
			}

			// Get swap transaction and extract instructions
			const transaction = await jupiterClient.getSwap({
				quote: finalQuote,
				userPublicKey,
				slippageBps,
			});

			const { transactionMessage, lookupTables: jupiterLookupTables } =
				await jupiterClient.getTransactionMessageAndLookupTables({
					transaction,
				});

			swapInstructions = jupiterClient.getJupiterInstructions({
				transactionMessage,
				inputMint,
				outputMint,
			});

			lookupTables = jupiterLookupTables;
		} else {
			const titanClient = this.client as TitanClient;

			// For Titan, get swap directly (it handles quote internally)
			const { transactionMessage, lookupTables: titanLookupTables } =
				await titanClient.getSwap({
					inputMint,
					outputMint,
					amount,
					userPublicKey,
					slippageBps,
					swapMode: isExactOut ? TitanSwapMode.ExactOut : TitanSwapMode.ExactIn,
					onlyDirectRoutes,
					sizeConstraint: sizeConstraint || 1280 - 375, // MAX_TX_BYTE_SIZE - buffer for drift instructions
				});

			swapInstructions = titanClient.getTitanInstructions({
				transactionMessage,
				inputMint,
				outputMint,
			});

			lookupTables = titanLookupTables;
		}

		return { instructions: swapInstructions, lookupTables };
	}

	/**
	 * Get the underlying client instance
	 */
	public getClient(): JupiterClient | TitanClient {
		return this.client;
	}

	/**
	 * Get the client type
	 */
	public getClientType(): SwapClientType {
		return this.clientType;
	}

	/**
	 * Check if this is a Jupiter client
	 */
	public isJupiter(): boolean {
		return this.clientType === 'jupiter';
	}

	/**
	 * Check if this is a Titan client
	 */
	public isTitan(): boolean {
		return this.clientType === 'titan';
	}
}
