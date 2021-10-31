import { BN, Idl, Program, Provider } from '@project-serum/anchor';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	MarketsAccount,
	StateAccount,
	CurveHistoryAccount,
	DepositHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	IWallet,
	LiquidationHistoryAccount,
	PositionDirection,
	TradeHistoryAccount,
	UserAccount,
	UserPosition,
	UserPositionsAccount,
	Market,
} from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';
import { squareRootBN } from './utils';

import {
	Connection,
	PublicKey,
	TransactionSignature,
	Keypair,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';

import { assert } from './assert/assert';
import { MockUSDCFaucet } from './mockUSDCFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getClearingHouseStateAccountPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeyAndNonce,
} from './addresses';
import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
} from './accounts/types';
import { DefaultClearingHouseAccountSubscriber } from './accounts/defaultClearingHouseAccountSubscriber';
import { TxSender } from './tx/types';
import { DefaultTxSender } from './tx/defaultTxSender';
import { wrapInTx } from './tx/utils';

export const USDC_PRECISION = new BN(10 ** 6);
export const AMM_MANTISSA = new BN(10 ** 10);
export const FUNDING_MANTISSA = new BN(10000);
export const PEG_SCALAR = new BN(1000);

export const BASE_ASSET_PRECISION = AMM_MANTISSA.mul(PEG_SCALAR);
export const QUOTE_BASE_PRECISION_DIFF =
	BASE_ASSET_PRECISION.div(USDC_PRECISION); // 10**(10+3-6)
export const PRICE_TO_USDC_PRECISION = AMM_MANTISSA.div(USDC_PRECISION);

const ZERO = new BN(0);
const MAXPCT = new BN(1000); //percentage units are [0,1000] => [0,1]

export class ClearingHouse {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: Provider;
	opts?: ConfirmOptions;
	accountSubscriber: ClearingHouseAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	isSubscribed = false;
	txSender: TxSender;

	public static from(
		connection: Connection,
		wallet: IWallet,
		clearingHouseProgramId: PublicKey,
		opts: ConfirmOptions = Provider.defaultOptions()
	): ClearingHouse {
		const provider = new Provider(connection, wallet, opts);
		const program = new Program(
			clearingHouseIDL as Idl,
			clearingHouseProgramId,
			provider
		);
		const accountSubscriber = new DefaultClearingHouseAccountSubscriber(
			program
		);
		const txSender = new DefaultTxSender(provider);
		return new ClearingHouse(
			connection,
			wallet,
			program,
			accountSubscriber,
			txSender,
			opts
		);
	}

	public constructor(
		connection: Connection,
		wallet: IWallet,
		program: Program,
		accountSubscriber: ClearingHouseAccountSubscriber,
		txSender: TxSender,
		opts: ConfirmOptions
	) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.program = program;
		this.accountSubscriber = accountSubscriber;
		this.eventEmitter = this.accountSubscriber.eventEmitter;
		this.txSender = txSender;
	}

	public async subscribe(): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe();
		return this.isSubscribed;
	}

	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	statePublicKey?: PublicKey;
	public async getStatePublicKey(): Promise<PublicKey> {
		if (this.statePublicKey) {
			return this.statePublicKey;
		}
		this.statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);
		return this.statePublicKey;
	}

	public getStateAccount(): StateAccount {
		return this.accountSubscriber.getStateAccount();
	}

	public getMarketsAccount(): MarketsAccount {
		return this.accountSubscriber.getMarketsAccount();
	}

	public getMarket(marketIndex: BN | number): Market {
		if (marketIndex instanceof BN) {
			marketIndex = marketIndex.toNumber();
		}
		return this.getMarketsAccount().markets[marketIndex];
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		return this.accountSubscriber.getFundingPaymentHistoryAccount();
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		return this.accountSubscriber.getFundingRateHistoryAccount();
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		return this.accountSubscriber.getTradeHistoryAccount();
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		return this.accountSubscriber.getLiquidationHistoryAccount();
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		return this.accountSubscriber.getDepositHistoryAccount();
	}

	public getCurveHistoryAccount(): CurveHistoryAccount {
		return this.accountSubscriber.getCurveHistoryAccount();
	}

	public updateWallet(newWallet: IWallet): void {
		const newProvider = new Provider(this.connection, newWallet, this.opts);
		const newProgram = new Program(
			clearingHouseIDL as Idl,
			this.program.programId,
			newProvider
		);
		const newTxSender = new DefaultTxSender(newProvider);

		this.wallet = newWallet;
		this.provider = newProvider;
		this.program = newProgram;
		this.txSender = newTxSender;
		this.userAccountPublicKey = undefined;
		this.userAccount = undefined;
	}

	public async initializeUserAccount(): Promise<
		[TransactionSignature, PublicKey]
	> {
		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
		] = await this.getInitializeUserInstructions();

		const tx = new Transaction().add(initializeUserAccountIx);
		const txSig = await this.txSender.send(
			tx,
			[userPositionsAccount],
			this.opts
		);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(): Promise<
		[Keypair, PublicKey, TransactionInstruction]
	> {
		const [userPublicKey, userAccountNonce] =
			await getUserAccountPublicKeyAndNonce(
				this.program.programId,
				this.wallet.publicKey
			);

		const remainingAccounts = [];
		const optionalAccounts = {
			whitelistToken: false,
		};

		const state = this.getStateAccount();
		if (state.whitelistMint) {
			optionalAccounts.whitelistToken = true;
			const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
				ASSOCIATED_TOKEN_PROGRAM_ID,
				TOKEN_PROGRAM_ID,
				state.whitelistMint,
				this.wallet.publicKey
			);
			remainingAccounts.push({
				pubkey: associatedTokenPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		const userPositions = new Keypair();
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(
				userAccountNonce,
				optionalAccounts,
				{
					accounts: {
						user: userPublicKey,
						authority: this.wallet.publicKey,
						rent: anchor.web3.SYSVAR_RENT_PUBKEY,
						systemProgram: anchor.web3.SystemProgram.programId,
						userPositions: userPositions.publicKey,
						state: await this.getStatePublicKey(),
					},
					remainingAccounts: remainingAccounts,
				}
			);
		return [userPositions, userPublicKey, initializeUserAccountIx];
	}

	userAccountPublicKey?: PublicKey;
	public async getUserAccountPublicKey(): Promise<PublicKey> {
		if (this.userAccountPublicKey) {
			return this.userAccountPublicKey;
		}

		this.userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey
		);
		return this.userAccountPublicKey;
	}

	userAccount?: UserAccount;
	public async getUserAccount(): Promise<UserAccount> {
		if (this.userAccount) {
			return this.userAccount;
		}

		this.userAccount = (await this.program.account.user.fetch(
			await this.getUserAccountPublicKey()
		)) as UserAccount;
		return this.userAccount;
	}

	public async depositCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		userPositionsAccountPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			collateralAccountPublicKey,
			userPositionsAccountPublicKey
		);

		const tx = new Transaction().add(depositCollateralIx);

		return await this.txSender.send(tx);
	}

	async getDepositCollateralInstruction(
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		userPositionsAccountPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		if (!userPositionsAccountPublicKey) {
			userPositionsAccountPublicKey = (await this.getUserAccount()).positions;
		}

		const state = this.getStateAccount();
		return await this.program.instruction.depositCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				collateralVault: state.collateralVault,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: state.markets,
				fundingPaymentHistory: state.fundingPaymentHistory,
				depositHistory: state.depositHistory,
				userPositions: userPositionsAccountPublicKey,
			},
		});
	}

	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<[TransactionSignature, PublicKey]> {
		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
		] = await this.getInitializeUserInstructions();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			collateralAccountPublicKey,
			userPositionsAccount.publicKey
		);

		const tx = new Transaction()
			.add(initializeUserAccountIx)
			.add(depositCollateralIx);

		const txSig = await this.program.provider.send(tx, [userPositionsAccount]);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		mockUSDCFaucet: MockUSDCFaucet,
		amount: BN
	): Promise<[TransactionSignature, PublicKey]> {
		const [associateTokenPublicKey, createAssociatedAccountIx, mintToIx] =
			await mockUSDCFaucet.createAssociatedTokenAccountAndMintToInstructions(
				this.wallet.publicKey,
				amount
			);

		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
		] = await this.getInitializeUserInstructions();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			associateTokenPublicKey,
			userPositionsAccount.publicKey
		);

		const tx = new Transaction()
			.add(createAssociatedAccountIx)
			.add(mintToIx)
			.add(initializeUserAccountIx)
			.add(depositCollateralIx);

		const txSig = await this.program.provider.send(tx, [userPositionsAccount]);

		return [txSig, userAccountPublicKey];
	}

	public async deleteUser(): Promise<TransactionSignature> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const user = await this.program.account.user.fetch(userAccountPublicKey);
		const deleteUserTx = await this.program.transaction.deleteUser({
			accounts: {
				user: userAccountPublicKey,
				userPositions: user.positions,
				authority: this.wallet.publicKey,
			},
		});
		return this.txSender.send(deleteUserTx, [], this.opts);
	}

	public async withdrawCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(
				await this.getWithdrawCollateralIx(amount, collateralAccountPublicKey)
			),
			[],
			this.opts
		);
	}

	public async getWithdrawCollateralIx(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const user: UserAccount = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		const state = this.getStateAccount();
		return await this.program.instruction.withdrawCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: state.markets,
				userPositions: user.positions,
				fundingPaymentHistory: state.fundingPaymentHistory,
				depositHistory: state.depositHistory,
			},
		});
	}

	public async openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getOpenPositionIx(
					direction,
					amount,
					marketIndex,
					limitPrice,
					discountToken,
					referrer
				)
			),
			[],
			this.opts
		);
	}

	public async getOpenPositionIx(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		if (limitPrice == undefined) {
			limitPrice = new BN(0); // no limit
		}

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};
		const remainingAccounts = [];
		if (discountToken) {
			optionalAccounts.discountToken = true;
			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}
		if (referrer) {
			optionalAccounts.referrer = true;
			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const priceOracle =
			this.getMarketsAccount().markets[marketIndex.toNumber()].amm.oracle;

		const state = this.getStateAccount();
		return await this.program.instruction.openPosition(
			direction,
			amount,
			marketIndex,
			limitPrice,
			optionalAccounts,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					markets: state.markets,
					userPositions: userAccount.positions,
					tradeHistory: state.tradeHistory,
					fundingPaymentHistory: state.fundingPaymentHistory,
					fundingRateHistory: state.fundingRateHistory,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async closePosition(
		marketIndex: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getClosePositionIx(marketIndex, discountToken, referrer)
			),
			[],
			this.opts
		);
	}

	public async getClosePositionIx(
		marketIndex: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		const priceOracle =
			this.getMarketsAccount().markets[marketIndex.toNumber()].amm.oracle;

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};
		const remainingAccounts = [];
		if (discountToken) {
			optionalAccounts.discountToken = true;
			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}
		if (referrer) {
			optionalAccounts.referrer = true;
			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		return await this.program.instruction.closePosition(
			marketIndex,
			optionalAccounts,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					markets: state.markets,
					userPositions: userAccount.positions,
					tradeHistory: state.tradeHistory,
					fundingPaymentHistory: state.fundingPaymentHistory,
					fundingRateHistory: state.fundingRateHistory,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidate(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.getLiquidateIx(liquidateeUserAccountPublicKey)),
			[],
			this.opts
		);
	}

	public async getLiquidateIx(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const liquidateeUserAccount: any = await this.program.account.user.fetch(
			liquidateeUserAccountPublicKey
		);
		const liquidateePositions: UserPositionsAccount =
			await this.program.account.userPositions.fetch(
				liquidateeUserAccount.positions
			);
		const markets = this.getMarketsAccount();

		const remainingAccounts = [];
		for (const position of liquidateePositions.positions) {
			if (!position.baseAssetAmount.eq(new BN(0))) {
				const market = markets.markets[position.marketIndex.toNumber()];
				remainingAccounts.push({
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		const state = this.getStateAccount();
		return await this.program.instruction.liquidate({
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: liquidateeUserAccountPublicKey,
				liquidator: userAccountPublicKey,
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: state.markets,
				userPositions: liquidateeUserAccount.positions,
				tradeHistory: state.tradeHistory,
				liquidationHistory: state.liquidationHistory,
				fundingPaymentHistory: state.fundingPaymentHistory,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async updateFundingRate(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.getUpdateFundingRateIx(oracle, marketIndex)),
			[],
			this.opts
		);
	}

	public async getUpdateFundingRateIx(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const state = this.getStateAccount();
		return await this.program.instruction.updateFundingRate(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				markets: state.markets,
				oracle: oracle,
				fundingRateHistory: state.fundingRateHistory,
			},
		});
	}

	public async settleFundingPayment(
		userAccount: PublicKey,
		userPositionsAccount: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(
				await this.getSettleFundingPaymentIx(userAccount, userPositionsAccount)
			),
			[],
			this.opts
		);
	}

	public async getSettleFundingPaymentIx(
		userAccount: PublicKey,
		userPositionsAccount: PublicKey
	): Promise<TransactionInstruction> {
		const state = this.getStateAccount();
		return await this.program.instruction.settleFundingPayment({
			accounts: {
				state: await this.getStatePublicKey(),
				markets: state.markets,
				user: userAccount,
				userPositions: userPositionsAccount,
				fundingPaymentHistory: state.fundingPaymentHistory,
			},
		});
	}

	public findSwapOutput(
		inputAssetAmount: BN,
		outputAssetAmount: BN,
		direction: PositionDirection,
		inputAmount: BN,
		inputAsset: string,
		invariant: BN,
		pegMultiplier: BN
	): [BN, BN] {
		assert(inputAmount.gte(ZERO)); // must be abs term
		// constant product

		if (inputAsset == 'quote') {
			inputAmount = inputAmount.mul(AMM_MANTISSA).div(pegMultiplier);
		}

		let newInputAssetAmount;

		if (
			(direction == PositionDirection.LONG && inputAsset == 'base') ||
			(direction == PositionDirection.SHORT && inputAsset == 'quote')
		) {
			newInputAssetAmount = inputAssetAmount.sub(inputAmount);
		} else {
			newInputAssetAmount = inputAssetAmount.add(inputAmount);
		}
		const newOutputAssetAmount = invariant.div(newInputAssetAmount);

		return [newInputAssetAmount, newOutputAssetAmount];
	}

	public calculateCurvePriceWithMantissa(
		baseAssetAmount: BN,
		quoteAssetAmount: BN,
		peg: BN
	) {
		if (baseAssetAmount.abs().lte(ZERO)) {
			return new BN(0);
		}

		return quoteAssetAmount
			.mul(AMM_MANTISSA)
			.mul(peg)
			.div(PEG_SCALAR)
			.div(baseAssetAmount);
	}

	public calculateBaseAssetPriceWithMantissa(marketIndex: BN): BN {
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		const baseAssetPriceWithMantissa = this.calculateCurvePriceWithMantissa(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);

		return baseAssetPriceWithMantissa;
	}

	public calculateBaseAssetPriceAsNumber(marketIndex: BN): number {
		return (
			this.calculateBaseAssetPriceWithMantissa(marketIndex).toNumber() /
			AMM_MANTISSA.toNumber()
		);
	}

	/**
	 * Calculates various types of price impact statistics
	 * @param unit
	 * 	| 'entryPrice' => the average price a user gets the position at : BN
	 * 	| 'maxPrice' =>  the price that the market is moved to after the trade : BN
	 * 	| 'priceDelta' =>  the change in price (with MANTISSA) : BN
	 * 	| 'priceDeltaAsNumber' =>  the change in price (as number, no MANTISSA) : number
	 * 	| 'pctAvg' =>  the percentage change from entryPrice (average est slippage in execution) : BN
	 * 	| 'pctMax' =>  the percentage change to maxPrice (highest est slippage in execution) : BN
	 * 	| 'quoteAssetAmount' => the amount of quote paid (~amount w/ slight rounding?) : BN
	 * 	| 'quoteAssetAmountPeg' => the amount of quotePeg paid (quote/pegMultiplier) : BN
	 */
	public calculatePriceImpact(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		unit?:
			| 'entryPrice'
			| 'maxPrice'
			| 'priceDelta'
			| 'priceDeltaAsNumber'
			| 'pctAvg'
			| 'pctMax'
			| 'quoteAssetAmount'
			| 'quoteAssetAmountPeg'
			| 'acquiredBaseAssetAmount'
			| 'acquiredQuoteAssetAmount'
	) {
		if (amount.eq(new BN(0))) {
			return new BN(0);
		}
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		const oldPrice = this.calculateBaseAssetPriceWithMantissa(marketIndex);
		const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);

		const [newQuoteAssetAmount, newBaseAssetAmount] = this.findSwapOutput(
			market.amm.quoteAssetReserve,
			market.amm.baseAssetReserve,
			direction,
			amount.abs(),
			'quote',
			invariant,
			market.amm.pegMultiplier
		);

		if (unit == 'acquiredBaseAssetAmount') {
			return market.amm.baseAssetReserve.sub(newBaseAssetAmount);
		}
		if (unit == 'acquiredQuoteAssetAmount') {
			return market.amm.quoteAssetReserve.sub(newQuoteAssetAmount);
		}

		const entryPrice = this.calculateCurvePriceWithMantissa(
			market.amm.baseAssetReserve.sub(newBaseAssetAmount),
			market.amm.quoteAssetReserve.sub(newQuoteAssetAmount),
			market.amm.pegMultiplier
		).mul(new BN(-1));

		if (entryPrice.eq(new BN(0))) {
			return new BN(0);
		}

		if (unit == 'entryPrice') {
			return entryPrice;
		}

		const newPrice = this.calculateCurvePriceWithMantissa(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			market.amm.pegMultiplier
		);

		if (unit == 'maxPrice') {
			return newPrice;
		}

		if (oldPrice == newPrice) {
			throw new Error('insufficient `amount` passed:');
		}

		let slippage;
		if (newPrice.gt(oldPrice)) {
			assert(direction == PositionDirection.LONG);
			if (unit == 'pctMax') {
				slippage = newPrice.sub(oldPrice).mul(AMM_MANTISSA).div(oldPrice);
			} else if (unit == 'pctAvg') {
				slippage = entryPrice.sub(oldPrice).mul(AMM_MANTISSA).div(oldPrice);
			} else if (
				[
					'priceDelta',
					'quoteAssetAmount',
					'quoteAssetAmountPeg',
					'priceDeltaAsNumber',
				].includes(unit)
			) {
				slippage = newPrice.sub(oldPrice);
			}
		} else {
			assert(direction == PositionDirection.SHORT);
			if (unit == 'pctMax') {
				slippage = oldPrice.sub(newPrice).mul(AMM_MANTISSA).div(oldPrice);
			} else if (unit == 'pctAvg') {
				slippage = oldPrice.sub(entryPrice).mul(AMM_MANTISSA).div(oldPrice);
			} else if (
				[
					'priceDelta',
					'quoteAssetAmount',
					'quoteAssetAmountPeg',
					'priceDeltaAsNumber',
				].includes(unit)
			) {
				slippage = oldPrice.sub(newPrice);
			}
		}
		if (unit == 'quoteAssetAmount') {
			slippage = slippage.mul(amount);
		} else if (unit == 'quoteAssetAmountPeg') {
			slippage = slippage.mul(amount).div(market.amm.pegMultiplier);
		} else if (unit == 'priceDeltaAsNumber') {
			slippage = slippage.toNumber() / AMM_MANTISSA.toNumber();
		}

		return slippage;
	}

	/**
	 * liquidityBook
	 * show snapshot of liquidity, similar to traditional orderbook
	 * @param marketIndex
	 * @param N number of bids/asks
	 * @param incrementSize grouping of liquidity by pct price move
	 * @returns
	 */
	public liquidityBook(marketIndex: BN, N = 5, incrementSize = 0.1) {
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		const defaultSlippageBN = new BN(incrementSize * AMM_MANTISSA.toNumber());
		const baseAssetPriceWithMantissa = this.calculateCurvePriceWithMantissa(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);
		const bidsPrice = [];
		const bidsCumSize = [];
		const asksPrice = [];
		const asksCumSize = [];

		for (let i = 1; i <= N; i++) {
			const targetPriceDefaultSlippage = baseAssetPriceWithMantissa
				.mul(AMM_MANTISSA.add(defaultSlippageBN.mul(new BN(i))))
				.div(AMM_MANTISSA);
			const [_direction, liquidity, entryPrice] =
				this.calculateTargetPriceTrade(
					marketIndex,
					BN.max(targetPriceDefaultSlippage, new BN(1))
				);
			asksPrice.push(entryPrice);
			asksCumSize.push(liquidity);

			const targetPriceDefaultSlippageBid = baseAssetPriceWithMantissa
				.mul(AMM_MANTISSA.sub(defaultSlippageBN.mul(new BN(i))))
				.div(AMM_MANTISSA);
			const [_directionBid, liquidityBid, entryPriceBid] =
				this.calculateTargetPriceTrade(
					marketIndex,
					BN.max(targetPriceDefaultSlippageBid, new BN(1))
				);
			bidsPrice.push(entryPriceBid);
			bidsCumSize.push(liquidityBid);
		}

		return [bidsPrice, bidsCumSize, asksPrice, asksCumSize];
	}

	/**
	 * calculateTargetPriceTrade
	 * simple function for finding arbitraging trades
	 * @param marketIndex
	 * @param targetPrice
	 * @param pct optional default is 100% gap filling, can set smaller.
	 * @returns trade direction/size in order to push price to a targetPrice
	 */
	public calculateTargetPriceTrade(
		marketIndex: BN,
		targetPrice: BN,
		pct: BN = MAXPCT
	): [PositionDirection, BN, BN, BN] {
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		assert(market.amm.baseAssetReserve.gt(ZERO));
		assert(targetPrice.gt(ZERO));
		assert(pct.lte(MAXPCT) && pct.gt(ZERO));

		const markPriceWithMantissa = this.calculateCurvePriceWithMantissa(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);

		if (targetPrice.gt(markPriceWithMantissa)) {
			const priceGap = targetPrice.sub(markPriceWithMantissa);
			const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
			targetPrice = markPriceWithMantissa.add(priceGapScaled);
		} else {
			const priceGap = markPriceWithMantissa.sub(targetPrice);
			const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
			targetPrice = markPriceWithMantissa.sub(priceGapScaled);
		}

		let direction;
		let tradeSize;
		let baseSize;

		const x1 = market.amm.baseAssetReserve;
		const y1 = market.amm.quoteAssetReserve;
		const peg = market.amm.pegMultiplier;
		const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);
		const k = invariant.mul(AMM_MANTISSA);

		let x2;
		let y2;
		const biasModifer = new BN(1);
		let targetPriceCalced;

		if (markPriceWithMantissa.gt(targetPrice)) {
			// overestimate y2, todo Math.sqrt
			x2 = squareRootBN(
				k.div(targetPrice).mul(peg).div(PEG_SCALAR).sub(biasModifer)
			).sub(new BN(1));
			y2 = k.div(AMM_MANTISSA).div(x2);

			targetPriceCalced = this.calculateCurvePriceWithMantissa(x2, y2, peg);
			direction = PositionDirection.SHORT;
			tradeSize = y1
				.sub(y2)
				.mul(peg)
				.div(PEG_SCALAR)
				.div(QUOTE_BASE_PRECISION_DIFF);
			baseSize = x1.sub(x2);
		} else if (markPriceWithMantissa.lt(targetPrice)) {
			// underestimate y2, todo Math.sqrt
			x2 = squareRootBN(
				k.div(targetPrice).mul(peg).div(PEG_SCALAR).add(biasModifer)
			).add(new BN(1));
			y2 = k.div(AMM_MANTISSA).div(x2);

			targetPriceCalced = this.calculateCurvePriceWithMantissa(x2, y2, peg);

			direction = PositionDirection.LONG;
			tradeSize = y2
				.sub(y1)
				.mul(peg)
				.div(PEG_SCALAR)
				.div(QUOTE_BASE_PRECISION_DIFF);
			baseSize = x2.sub(x1);
		} else {
			// no trade, market is at target
			direction = PositionDirection.LONG;
			tradeSize = ZERO;
			baseSize = ZERO;
			return [direction, tradeSize, targetPrice, targetPrice];
		}

		let tp1 = targetPrice;
		let tp2 = targetPriceCalced;
		let ogDiff = targetPrice.sub(markPriceWithMantissa);

		if (direction == PositionDirection.SHORT) {
			tp1 = targetPriceCalced;
			tp2 = targetPrice;
			ogDiff = markPriceWithMantissa.sub(targetPrice);
		}

		const entryPrice = this.calculateCurvePriceWithMantissa(
			baseSize.abs(),
			tradeSize,
			AMM_MANTISSA
		);
		assert(tp1.sub(tp2).lte(ogDiff), 'Target Price Calculation incorrect');
		// assert(tp1.sub(tp2).lt(AMM_MANTISSA), 'Target Price Calculation incorrect'); //  super OoB shorts do not
		assert(
			tp2.lte(tp1) || tp2.sub(tp1).abs() < 100000,
			'Target Price Calculation incorrect' +
				tp2.toString() +
				'>=' +
				tp1.toString() +
				'err: ' +
				tp2.sub(tp1).abs().toString()
		); //todo

		return [direction, tradeSize, entryPrice, targetPrice];
	}

	public triggerEvent(eventName: keyof ClearingHouseAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}
}
