import { BN, Idl, Program, Provider } from '@project-serum/anchor';
import { AccountLayout, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { IWallet, PositionDirection } from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';
import { PythClient } from './pythClient';
import {squareRootBN} from './utils';

import {
	Connection,
	PublicKey,
	SystemProgram,
	TransactionSignature,
	Keypair,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
	SYSVAR_RENT_PUBKEY,
	SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';

import { assert } from './assert/assert';
import { MockUSDCFaucet } from './mockUSDCFaucet';
import {
	ClearingHouseMarketsAccountData,
	ClearingHouseState,
	FundingHistoryAccountData,
	TradeHistoryAccount,
	UserAccountData,
	UserPosition,
	UserPositionData,
} from './DataTypes';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';

interface ClearingHouseEvents {
	programStateUpdate: (payload: ClearingHouseState) => void;
	marketsAccountUpdate: (payload: ClearingHouseMarketsAccountData) => void;
	fundingHistoryAccountUpdate: (payload: FundingHistoryAccountData) => void;
	tradeHistoryAccountUpdate: (payload: TradeHistoryAccount) => void;
	update: void;
}

export const USDC_PRECISION = new BN(10 ** 6);
export const AMM_MANTISSA = new BN(10 ** 10);
export const FUNDING_MANTISSA = new BN(10000);
export const PEG_SCALAR = new BN(1000);

export const BASE_ASSET_PRECISION = AMM_MANTISSA.mul(PEG_SCALAR);
export const QUOTE_BASE_PRECISION_DIFF = BASE_ASSET_PRECISION.div(USDC_PRECISION); // 10**(10+3-6)
export const PRICE_TO_USDC_PRECISION = AMM_MANTISSA.div(USDC_PRECISION);

const ZERO = new BN(0);
const MAXPCT = new BN(1000); //percentage units are [0,1000] => [0,1]

export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

export class ClearingHouse {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: Provider;
	opts?: ConfirmOptions;
	private state?: ClearingHouseState;
	private marketsAccount?: ClearingHouseMarketsAccountData;
	private fundingRateHistory?: FundingHistoryAccountData;
	private tradeHistoryAccount?: TradeHistoryAccount;
	isSubscribed = false;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseEvents>;

	public constructor(
		connection: Connection,
		wallet: IWallet,
		clearingHouseProgramId: PublicKey,
		opts?: ConfirmOptions
	) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts || Provider.defaultOptions();
		const provider = new Provider(connection, wallet, this.opts);
		this.program = new Program(
			clearingHouseIDL as Idl,
			clearingHouseProgramId,
			provider
		);
		this.eventEmitter = new EventEmitter();
	}

	public async getClearingHouseStatePublicKeyAndNonce(): Promise<[PublicKey, number]> {
		return anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('clearing_house')),
			],
			this.program.programId
		);
	}

	statePublicKey? : PublicKey;
	public async getStatePublicKey(): Promise<PublicKey> {
		if (this.statePublicKey) {
			return this.statePublicKey;
		}
		this.statePublicKey = (await this.getClearingHouseStatePublicKeyAndNonce())[0];
		return this.statePublicKey;
	}

	// Initialise Clearinghouse
	public async initialize(
		usdcMint: PublicKey,
		adminControlsPrices: boolean
	): Promise<TransactionSignature> {
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			await this.getStatePublicKey()
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Clearing house already initialized');
		}

		const collateralVault = Keypair.generate();
		const [chCollateralAccountAuthority, _chCollateralAccountNonce] =
			await PublicKey.findProgramAddress(
				[collateralVault.publicKey.toBuffer()],
				this.program.programId
			);

		const createCollateralTokenAccountIx = SystemProgram.createAccount({
			fromPubkey: this.wallet.publicKey,
			newAccountPubkey: collateralVault.publicKey,
			lamports: await Token.getMinBalanceRentForExemptAccount(this.connection),
			space: AccountLayout.span,
			programId: TOKEN_PROGRAM_ID,
		});
		const initCollateralTokenAccountIx = Token.createInitAccountInstruction(
			TOKEN_PROGRAM_ID,
			usdcMint,
			collateralVault.publicKey,
			chCollateralAccountAuthority
		);

		const insuranceVault = Keypair.generate();
		const [insuranceAccountOwner, _insuranceAccountNonce] =
			await PublicKey.findProgramAddress(
				[insuranceVault.publicKey.toBuffer()],
				this.program.programId
			);
		const createInsuranceTokenAccountIx = SystemProgram.createAccount({
			fromPubkey: this.wallet.publicKey,
			newAccountPubkey: insuranceVault.publicKey,
			lamports: await Token.getMinBalanceRentForExemptAccount(this.connection),
			space: AccountLayout.span,
			programId: TOKEN_PROGRAM_ID,
		});
		const initInsuranceTokenAccountIx = Token.createInitAccountInstruction(
			TOKEN_PROGRAM_ID,
			usdcMint,
			insuranceVault.publicKey,
			insuranceAccountOwner
		);

		const markets = anchor.web3.Keypair.generate();
		const fundingPaymentHistory = anchor.web3.Keypair.generate();
		const tradeHistory = anchor.web3.Keypair.generate();

		const [clearingHouseStatePublicKey, clearingHouseNonce] = await this.getClearingHouseStatePublicKeyAndNonce();
		return await this.program.rpc.initialize(clearingHouseNonce, adminControlsPrices, {
			accounts: {
				admin: this.wallet.publicKey,
				state: clearingHouseStatePublicKey,
				collateralVault: collateralVault.publicKey,
				insuranceVault: insuranceVault.publicKey,
				markets: markets.publicKey,
				fundingPaymentHistory: fundingPaymentHistory.publicKey,
				tradeHistory: tradeHistory.publicKey,
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
			},
			instructions: [
				createCollateralTokenAccountIx,
				initCollateralTokenAccountIx,
				createInsuranceTokenAccountIx,
				initInsuranceTokenAccountIx,
				await this.program.account.markets.createInstruction(
					markets
				),
				await this.program.account.fundingPaymentHistory.createInstruction(
					fundingPaymentHistory
				),
				await this.program.account.tradeHistory.createInstruction(
					tradeHistory
				),
			],
			signers: [
				collateralVault,
				insuranceVault,
				markets,
				fundingPaymentHistory,
				tradeHistory,
			],
		});
	}

	public async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return;
		}

		//return and set up subscriber for state data
		const [clearingHouseStatePublicKey, _] = await this.getClearingHouseStatePublicKeyAndNonce();
		const latestState =
			(await this.program.account.state.fetch(
				clearingHouseStatePublicKey
			)) as ClearingHouseState;
		this.state = latestState;
		this.eventEmitter.emit('programStateUpdate', latestState);

		this.program.account.state
			.subscribe(clearingHouseStatePublicKey, this.opts.commitment)
			.on('change', async (updateData) => {
				this.state = updateData;

				this.eventEmitter.emit('programStateUpdate', updateData);
			});

		//return and set up subscriber for markets data
		const latestMarketsAccount =
			(await this.program.account.markets.fetch(
				this.state.markets
			)) as ClearingHouseMarketsAccountData;
		this.marketsAccount = latestMarketsAccount;

		this.eventEmitter.emit('marketsAccountUpdate', latestMarketsAccount);

		this.program.account.markets
			.subscribe(this.state.markets, this.opts.commitment)
			.on('change', async (updateData) => {
				this.marketsAccount = updateData;

				this.eventEmitter.emit('marketsAccountUpdate', updateData);
			});

		const latestFundingPaymentHistory =
			(await this.program.account.fundingPaymentHistory.fetch(
				this.state.fundingPaymentHistory
			)) as FundingHistoryAccountData;
		this.fundingRateHistory = latestFundingPaymentHistory;

		this.eventEmitter.emit(
			'fundingHistoryAccountUpdate',
			latestFundingPaymentHistory
		);

		this.program.account.fundingPaymentHistory
			.subscribe(this.state.fundingPaymentHistory, this.opts.commitment)
			.on('change', async (updateData) => {
				this.fundingRateHistory = updateData;

				this.eventEmitter.emit('fundingHistoryAccountUpdate', updateData);
			});

		const lastTradeHistoryAccount =
			(await this.program.account.tradeHistory.fetch(
				this.state.tradeHistory
			)) as TradeHistoryAccount;
		this.tradeHistoryAccount = lastTradeHistoryAccount;

		this.eventEmitter.emit(
			'tradeHistoryAccountUpdate',
			lastTradeHistoryAccount
		);

		this.program.account.tradeHistory
			.subscribe(this.state.tradeHistory, this.opts.commitment)
			.on('change', async (updateData) => {
				this.tradeHistoryAccount = updateData;

				this.eventEmitter.emit('tradeHistoryAccountUpdate', updateData);
			});

		this.isSubscribed = true;

		this.eventEmitter.emit('update');

		return true;
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await this.program.account.state.unsubscribe(await this.getStatePublicKey());
		await this.program.account.markets.unsubscribe(this.state.markets);
		await this.program.account.fundingPaymentHistory.unsubscribe(
			this.state.fundingPaymentHistory
		);
		await this.program.account.tradeHistory.unsubscribe(
			this.state.tradeHistory
		);
		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public updateWallet(newWallet: IWallet): void {
		const newProvider = new Provider(this.connection, newWallet, this.opts);
		const newProgram = new Program(
			clearingHouseIDL as Idl,
			this.program.programId,
			newProvider
		);

		this.wallet = newWallet;
		this.provider = newProvider;
		this.program = newProgram;
	}

	public getState(): ClearingHouseState {
		this.assertIsSubscribed();
		return this.state;
	}

	public getMarketsAccount(): ClearingHouseMarketsAccountData {
		this.assertIsSubscribed();
		return this.marketsAccount;
	}

	public getFundingRateHistory(): FundingHistoryAccountData {
		this.assertIsSubscribed();
		return this.fundingRateHistory;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		return this.tradeHistoryAccount;
	}

	public async initializeMarket(
		marketIndex: BN,
		priceOracle: PublicKey,
		baseAmount: BN,
		quoteAmount: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_SCALAR
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		if (this.getMarketsAccount().markets[marketIndex.toNumber()].initialized) {
			throw Error(`MarketIndex ${marketIndex.toNumber()} already initialized`);
		}

		const txSig = await this.program.rpc.initializeMarket(
			marketIndex,
			baseAmount,
			quoteAmount,
			periodicity,
			pegMultiplier,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					oracle: priceOracle,
					markets: this.state.markets,
				},
			}
		);
		return txSig;
	}

	public async initializeUserAccount(): Promise<
		[TransactionSignature, PublicKey]
	> {
		this.assertIsSubscribed();

		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
		] = await this.getInitializeUserInstructions();

		const tx = new Transaction()
			.add(initializeUserAccountIx);
		const txSig = await this.program.provider.send(tx, [userPositionsAccount]);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(): Promise<
		[Keypair, PublicKey, TransactionInstruction]
	> {
		const [userPublicKey, userAccountNonce] =
			await this.getUserAccountPublicKey();

		const userPositions = new Keypair();
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(userAccountNonce, {
				accounts: {
					user: userPublicKey,
					authority: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					userPositions: userPositions.publicKey,
					clock: SYSVAR_CLOCK_PUBKEY,
				},
			});
		return [
			userPositions,
			userPublicKey,
			initializeUserAccountIx,
		];
	}

	public getPositionsAccountClient(): anchor.AccountClient {
		return this.program.account.userPositions;
	}

	public getPositionsAccountData(
		positionsKey: PublicKey
	): Promise<UserPositionData> {
		return this.getPositionsAccountClient().fetch(
			positionsKey
		) as Promise<UserPositionData>;
	}

	public getUserAccountClient(): anchor.AccountClient {
		return this.program.account.user;
	}

	public getUserAccountData(accountKey: PublicKey): Promise<UserAccountData> {
		return this.getUserAccountClient().fetch(
			accountKey
		) as Promise<UserAccountData>;
	}

	public getUserAccountPublicKey(
		userPublicKey?: PublicKey
	): Promise<[PublicKey, number]> {
		userPublicKey = userPublicKey ?? this.wallet.publicKey;
		return anchor.web3.PublicKey.findProgramAddress(
			[
				Buffer.from(anchor.utils.bytes.utf8.encode('user')),
				userPublicKey.toBuffer(),
			],
			this.program.programId
		);
	}

	public async depositCollateral(
		userAccountPublicKey: PublicKey,
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			userAccountPublicKey,
			amount,
			collateralAccountPublicKey
		);

		const tx = new Transaction().add(depositCollateralIx);

		return await this.program.provider.send(tx);
	}

	async getDepositCollateralInstruction(
		userPublicKey: PublicKey,
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		userPositionsPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		if (!userPositionsPublicKey) {
			const user: any = await this.program.account.user.fetch(
				userPublicKey
			);
			userPositionsPublicKey = user.positions;
		}

		return await this.program.instruction.depositCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userPublicKey,
				collateralVault: this.state.collateralVault,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: this.state.markets,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
				userPositions: userPositionsPublicKey,
			},
		});
	}

	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<[TransactionSignature, PublicKey]> {
		this.assertIsSubscribed();

		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
		] = await this.getInitializeUserInstructions();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			userAccountPublicKey,
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
		this.assertIsSubscribed();

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
			userAccountPublicKey,
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

	public async withdrawCollateral(
		userAccountPublicKey: PublicKey,
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const user: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		return await this.program.rpc.withdrawCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				collateralVault: this.state.collateralVault,
				collateralVaultAuthority:
					this.state.collateralVaultAuthority,
				insuranceVault: this.state.insuranceVault,
				insuranceVaultAuthority:
					this.state.insuranceVaultAuthority,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: this.state.markets,
				userPositions: user.positions,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
			},
		});
	}

	public async openPosition(
		userAccountPublicKey: PublicKey,
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const user: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		if (limitPrice == undefined) {
			limitPrice = new BN(0); // no limit
		}

		return await this.program.rpc.openPosition(
			direction,
			amount,
			marketIndex,
			limitPrice,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					markets: this.state.markets,
					userPositions: user.positions,
					tradeHistory: this.state.tradeHistory,
					fundingPaymentHistory: this.state.fundingPaymentHistory,
				},
			}
		);
	}

	public async closePosition(
		userAccountPublicKey: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const user: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		return await this.program.rpc.closePosition(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				markets: this.state.markets,
				userPositions: user.positions,
				tradeHistoryAccount: this.state.tradeHistory,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
			},
		});
	}

	public async moveAmmPrice(
		baseAmount: BN,
		quoteAmount: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		return await this.program.rpc.moveAmmPrice(
			baseAmount,
			quoteAmount,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					markets: this.state.markets,
					clock: SYSVAR_CLOCK_PUBKEY,
				},
			}
		);
	}

	public async moveAmmToPrice(
		marketIndex: BN,
		targetPrice: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		const _peg = market.amm.pegMultiplier;

		const [direction, tradeSize, _] = this.calculateTargetPriceTrade(
			marketIndex,
			targetPrice
		);

		const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);

		const [newQuoteAssetAmount, newBaseAssetAmount] = this.findSwapOutput(
			market.amm.quoteAssetReserve,
			market.amm.baseAssetReserve,
			direction,
			tradeSize,
			'quote',
			invariant,
			market.amm.pegMultiplier
		);

		return await this.program.rpc.moveAmmPrice(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					markets: this.state.markets,
					clock: SYSVAR_CLOCK_PUBKEY,
				},
			}
		);
	}

	public async repegAmmCurve(
		newPeg: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const marketsAccount: any = await this.program.account.markets.fetch(
			this.state.markets
		);
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammData = marketData.amm;

		return await this.program.rpc.repegAmmCurve(newPeg, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				markets: this.state.markets,
			},
		});
	}

	public async liquidate(
		liquidatorUSDCTokenPublicKey: PublicKey,
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const liquidateeUserAccount : any = await this.program.account.user.fetch(
			liquidateeUserAccountPublicKey
		);

		return await this.program.rpc.liquidate({
			accounts: {
				state: await this.getStatePublicKey(),
				liquidator: this.wallet.publicKey,
				user: liquidateeUserAccountPublicKey,
				collateralVault: this.state.collateralVault,
				collateralVaultAuthority:
					this.state.collateralVaultAuthority,
				insuranceVault: this.state.insuranceVault,
				insuranceVaultAuthority:
					this.state.insuranceVaultAuthority,
				liquidatorAccount: liquidatorUSDCTokenPublicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: this.state.markets,
				userPositions: liquidateeUserAccount.positions,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
				tradeHistory: this.state.tradeHistory,
			},
		});
	}

	public async updateFundingRate(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const tx = await this.program.rpc.updateFundingRate(marketIndex, {
			accounts: {
				markets: this.state.markets,
				oracle: oracle,
				insuranceVault: this.state.insuranceVault,
				insuranceVaultAuthority:
					this.state.insuranceVaultAuthority,
			},
		});

		return tx;
	}

	public async settleFundingPayment(
		userAccount: PublicKey,
		userPositionsAccount: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		return await this.program.rpc.settleFundingPayment({
			accounts: {
				markets: this.state.markets,
				user: userAccount,
				userPositions: userPositionsAccount,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
			},
		});
	}

	public async calculateEstimatedFundingRate(
		marketIndex: BN,
		pythClient: PythClient, // todo
		periodAdjustment: BN = new BN(1),
		estimationMethod: 'interpolated' | 'lowerbound'
	): Promise<BN> {
		// periodAdjustment
		// 	1: hourly
		//  24: daily
		//  24 * 365.25: annualized
		const marketsAccount: any = await this.getMarketsAccount();

		const market = marketsAccount.markets[marketIndex.toNumber()];
		if (!market.initialized) {
			return new BN(0);
		}

		const payFreq = new BN(market.amm.periodicity);

		const oraclePriceData = await pythClient.getPriceData(market.amm.oracle);
		const oracleTwapWithMantissa = new BN(
			oraclePriceData.twap.value * AMM_MANTISSA.toNumber()
		);
		const markTwapWithMantissa = market.amm.lastMarkPriceTwap;

		const twapSpreadPct = (markTwapWithMantissa
			.sub(oracleTwapWithMantissa))
			.mul(AMM_MANTISSA)
			.mul(new BN(100))
			.div(oracleTwapWithMantissa);

		const now = new BN((Date.now() / 1000).toFixed(0));
		const timeSinceLastUpdate = now.sub(market.amm.lastFundingRateTs);

		if (estimationMethod == 'lowerbound') {
			//assuming remaining funding period has no gap
			const estFundingRateLowerBound = twapSpreadPct
				.mul(payFreq)
				.mul(timeSinceLastUpdate)
				.mul(periodAdjustment)
				.div(new BN(3600))
				.div(new BN(3600))
				.div(new BN(24));
			return estFundingRateLowerBound;
		} else {
			const estFundingRate = twapSpreadPct
				.mul(periodAdjustment)
				.div(new BN(24));

			return estFundingRate;
		}
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

		return quoteAssetAmount.mul(AMM_MANTISSA).mul(peg).div(PEG_SCALAR).div(baseAssetAmount);
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
	 * Calculates various types of price impact:
	 *
	 * Unit argument and returned value :
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
		this.assertIsSubscribed();

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

	public liquidityBook(marketIndex: BN, N = 5, incrementSize = 0.1) {
		// show snapshot of liquidity, similar to traditional orderbook

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

	public calculateTargetPriceTrade(
		marketIndex: BN,
		targetPrice: BN,
		pct: BN = MAXPCT
	): [PositionDirection, BN, BN, BN] {
		// simple function for funding rate arbitrage bot
		// return the trade direction/size in order to push price to a targetPrice
		// set a pct optional default is 100% gap filling, can set smaller.
		this.assertIsSubscribed();
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
			tradeSize = y1.sub(y2).mul(peg).div(PEG_SCALAR).div(QUOTE_BASE_PRECISION_DIFF);
			baseSize = x1.sub(x2);
		} else if (markPriceWithMantissa.lt(targetPrice)) {
			// underestimate y2, todo Math.sqrt
			x2 =squareRootBN(
					k.div(targetPrice).mul(peg).div(PEG_SCALAR).add(biasModifer)
				).add(new BN(1));
			y2 = k.div(AMM_MANTISSA).div(x2);

			targetPriceCalced = this.calculateCurvePriceWithMantissa(x2, y2, peg);

			direction = PositionDirection.LONG;
			tradeSize = y2.sub(y1).mul(peg).div(PEG_SCALAR).div(QUOTE_BASE_PRECISION_DIFF);
			baseSize = x2.sub(x1);
		} else {
			// no trade, market is at target
			direction = PositionDirection.LONG;
			tradeSize = 0;
			baseSize = 0;
			return [direction, new BN(tradeSize), new BN(0), targetPrice];
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

		return [direction, new BN(tradeSize), entryPrice, targetPrice];
	}

	public calculateBaseAssetValue(marketPosition: UserPosition) {
		if (marketPosition.baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}

		const market =
			this.marketsAccount.markets[marketPosition.marketIndex.toNumber()];

		const directionToClose = marketPosition.baseAssetAmount.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);
		const [, newQuoteAssetAmount] = this.findSwapOutput(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			directionToClose,
			marketPosition.baseAssetAmount.abs(),
			'base',
			invariant,
			market.amm.pegMultiplier
		);

		switch (directionToClose) {
			case PositionDirection.SHORT:
				return market.amm.quoteAssetReserve
					.sub(newQuoteAssetAmount)
					.mul(market.amm.pegMultiplier);

			case PositionDirection.LONG:
				return newQuoteAssetAmount
					.sub(market.amm.quoteAssetReserve)
					.mul(market.amm.pegMultiplier);
		}
	}

	public calculatePositionPNL(
		marketPosition: UserPosition,
		withFunding = false
	): BN {
		if (marketPosition.baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}

		const directionToClose = marketPosition.baseAssetAmount.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		const baseAssetValue = this.calculateBaseAssetValue(marketPosition).div(AMM_MANTISSA);
		let pnlAssetAmount;

		switch (directionToClose) {
			case PositionDirection.SHORT:
				pnlAssetAmount = baseAssetValue.sub(
					marketPosition.quoteAssetAmount
				);
				break;

			case PositionDirection.LONG:
				pnlAssetAmount =
					marketPosition.quoteAssetAmount.sub(baseAssetValue);
				break;
		}

		if (withFunding) {
			const fundingRatePnL =
				this.calculatePositionFundingPNL(marketPosition).div(PRICE_TO_USDC_PRECISION);

			pnlAssetAmount = pnlAssetAmount.add(fundingRatePnL);
		}

		return pnlAssetAmount;
	}

	public calculatePositionFundingPNL(marketPosition: UserPosition): BN {
		if (marketPosition.baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}

		const market =
			this.getMarketsAccount().markets[marketPosition.marketIndex.toNumber()];

		const perPositionFundingRate = market.amm.cumulativeFundingRate
			.sub(marketPosition.lastCumulativeFundingRate)
			.mul(marketPosition.baseAssetAmount)
			.div(BASE_ASSET_PRECISION)
			.div(FUNDING_MANTISSA)
			.mul(new BN(-1));

		return perPositionFundingRate;
	}
}
