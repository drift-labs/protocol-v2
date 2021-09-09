import { BN, Idl, Program, Provider } from '@project-serum/anchor';
import { AccountLayout, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { IWallet, PositionDirection } from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';
import { PythClient } from './pythClient';

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
import { Network } from './network';

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

export const AMM_MANTISSA = new BN(10 ** 6);
export const FUNDING_MANTISSA = new BN(10000);

const ZERO = new BN(0);
const MAXPCT = new BN(1000); //percentage units are [0,1000] => [0,1]

export class ClearingHouse {
	connection: Connection;
	network: Network;
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
		network: Network,
		wallet: IWallet,
		clearingHouseProgramId: PublicKey,
		opts?: ConfirmOptions
	) {
		this.connection = connection;
		this.network = network;
		this.wallet = wallet;
		this.opts = opts || Provider.defaultOptions();
		const provider = new Provider(connection, wallet, this.opts);
		switch (network) {
			case Network.LOCAL:
				this.program = new Program(
					clearingHouseIDL as Idl,
					clearingHouseProgramId,
					provider
				);
				break;
			default:
				throw new Error('Not supported');
		}

		this.eventEmitter = new EventEmitter();
	}

	// Initialise Clearinghouse
	public async initialize(
		usdcMint: PublicKey,
		adminControlsPrices: boolean
	): Promise<TransactionSignature> {
		const stateAddress = this.program.state.address();
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			stateAddress
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Clearing house already initialized');
		}

		const collateralAccount = Keypair.generate();
		const [chCollateralAccountAuthority, _chCollateralAccountNonce] =
			await PublicKey.findProgramAddress(
				[collateralAccount.publicKey.toBuffer()],
				this.program.programId
			);

		const createCollateralTokenAccountIx = SystemProgram.createAccount({
			fromPubkey: this.wallet.publicKey,
			newAccountPubkey: collateralAccount.publicKey,
			lamports: await Token.getMinBalanceRentForExemptAccount(this.connection),
			space: AccountLayout.span,
			programId: TOKEN_PROGRAM_ID,
		});
		const initCollateralTokenAccountIx = Token.createInitAccountInstruction(
			TOKEN_PROGRAM_ID,
			usdcMint,
			collateralAccount.publicKey,
			chCollateralAccountAuthority
		);

		const insuranceAccount = Keypair.generate();
		const [insuranceAccountOwner, _insuranceAccountNonce] =
			await PublicKey.findProgramAddress(
				[insuranceAccount.publicKey.toBuffer()],
				this.program.programId
			);
		const createInsuranceTokenAccountIx = SystemProgram.createAccount({
			fromPubkey: this.wallet.publicKey,
			newAccountPubkey: insuranceAccount.publicKey,
			lamports: await Token.getMinBalanceRentForExemptAccount(this.connection),
			space: AccountLayout.span,
			programId: TOKEN_PROGRAM_ID,
		});
		const initInsuranceTokenAccountIx = Token.createInitAccountInstruction(
			TOKEN_PROGRAM_ID,
			usdcMint,
			insuranceAccount.publicKey,
			insuranceAccountOwner
		);

		const marketsAccount = anchor.web3.Keypair.generate();
		const fundingRateHistory = anchor.web3.Keypair.generate();
		const tradeHistoryAccount = anchor.web3.Keypair.generate();

		return await this.program.state.rpc.new(adminControlsPrices, {
			accounts: {
				admin: this.wallet.publicKey,
				collateralAccount: collateralAccount.publicKey,
				insuranceAccount: insuranceAccount.publicKey,
				marketsAccount: marketsAccount.publicKey,
				fundingRateHistory: fundingRateHistory.publicKey,
				tradeHistoryAccount: tradeHistoryAccount.publicKey,
				rent: SYSVAR_RENT_PUBKEY,
			},
			instructions: [
				createCollateralTokenAccountIx,
				initCollateralTokenAccountIx,
				createInsuranceTokenAccountIx,
				initInsuranceTokenAccountIx,
				await this.program.account.marketsAccount.createInstruction(
					marketsAccount
				),
				await this.program.account.fundingRateHistory.createInstruction(
					fundingRateHistory
				),
				await this.program.account.tradeHistoryAccount.createInstruction(
					tradeHistoryAccount
				),
			],
			signers: [
				collateralAccount,
				insuranceAccount,
				marketsAccount,
				fundingRateHistory,
				tradeHistoryAccount,
			],
		});
	}

	public async subscribe(): Promise<boolean> {
		try {
			if (this.isSubscribed) {
				return;
			}

			//return and set up subscriber for state data
			const latestState =
				(await this.program.state.fetch()) as ClearingHouseState;
			this.state = latestState;
			this.eventEmitter.emit('programStateUpdate', latestState);

			this.program.state
				.subscribe(this.opts.commitment)
				.on('change', async (updateData) => {
					this.state = updateData;

					this.eventEmitter.emit('programStateUpdate', updateData);
				});

			console.log(`Subscribing to clearing house marketsAccount`);

			//return and set up subscriber for markets data
			const latestMarketsAccount =
				(await this.program.account.marketsAccount.fetch(
					this.state.marketsAccount
				)) as ClearingHouseMarketsAccountData;
			this.marketsAccount = latestMarketsAccount;

			this.eventEmitter.emit('marketsAccountUpdate', latestMarketsAccount);

			this.program.account.marketsAccount
				.subscribe(this.state.marketsAccount, this.opts.commitment)
				.on('change', async (updateData) => {
					this.marketsAccount = updateData;

					this.eventEmitter.emit('marketsAccountUpdate', updateData);
				});

			const latestFundingRateHistory =
				(await this.program.account.fundingRateHistory.fetch(
					this.state.fundingRateHistory
				)) as FundingHistoryAccountData;
			this.fundingRateHistory = latestFundingRateHistory;

			this.eventEmitter.emit(
				'fundingHistoryAccountUpdate',
				latestFundingRateHistory
			);

			this.program.account.fundingRateHistory
				.subscribe(this.state.fundingRateHistory, this.opts.commitment)
				.on('change', async (updateData) => {
					this.fundingRateHistory = updateData;

					this.eventEmitter.emit('fundingHistoryAccountUpdate', updateData);
				});

			const lastTradeHistoryAccount =
				(await this.program.account.tradeHistoryAccount.fetch(
					this.state.tradeHistoryAccount
				)) as TradeHistoryAccount;
			this.tradeHistoryAccount = lastTradeHistoryAccount;

			this.eventEmitter.emit(
				'tradeHistoryAccountUpdate',
				lastTradeHistoryAccount
			);

			this.program.account.tradeHistoryAccount
				.subscribe(this.state.tradeHistoryAccount, this.opts.commitment)
				.on('change', async (updateData) => {
					this.tradeHistoryAccount = updateData;

					this.eventEmitter.emit('tradeHistoryAccountUpdate', updateData);
				});

			this.isSubscribed = true;

			return true;
		} catch (error) {
			console.error(`Caught error trying to subscribe to ClearingHouse`, error);
			return false;
		}
	}

	public async unsubscribe(): Promise<void> {
		this.program.state.unsubscribe();
		this.program.account.marketsAccount.unsubscribe(this.state.marketsAccount);
		this.program.account.fundingRateHistory.unsubscribe(
			this.state.fundingRateHistory
		);
		this.program.account.tradeHistoryAccount.unsubscribe(
			this.state.tradeHistoryAccount
		);
		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw Error('You must call `subscribe` before using this function');
		}
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
		pegMultiplier: BN = AMM_MANTISSA
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		if (this.getMarketsAccount().markets[marketIndex.toNumber()].initialized) {
			throw Error(`MarketIndex ${marketIndex.toNumber()} already initialized`);
		}

		const txSig = await this.program.state.rpc.initializeMarket(
			marketIndex,
			baseAmount,
			quoteAmount,
			periodicity,
			pegMultiplier,
			{
				accounts: {
					admin: this.wallet.publicKey,
					oracle: priceOracle,
					marketsAccount: this.state.marketsAccount,
					clock: SYSVAR_CLOCK_PUBKEY,
				},
			}
		);
		return txSig;
	}

	public async uninitializeMarket(
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		if (
			this.getMarketsAccount().markets[marketIndex.toNumber()].initialized ==
			false
		) {
			throw Error(`MarketIndex ${marketIndex.toNumber()} is not initialized`);
		}

		const txSig = await this.program.state.rpc.unInitializeMarket(marketIndex, {
			accounts: {
				admin: this.wallet.publicKey,
				marketsAccount: this.state.marketsAccount,
				clock: SYSVAR_CLOCK_PUBKEY,
			},
		});
		return txSig;
	}
	public async initializeUserAccount(): Promise<
		[TransactionSignature, PublicKey]
	> {
		this.assertIsSubscribed();

		const [
			userPositionsAccount,
			createUserPositionsAccountIx,
			userAccountPublicKey,
			initializeUserAccountIx,
		] = await this.getInitializeUserInstructions();

		const tx = new Transaction()
			.add(createUserPositionsAccountIx)
			.add(initializeUserAccountIx);
		const txSig = await this.program.provider.send(tx, [userPositionsAccount]);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(): Promise<
		[Keypair, TransactionInstruction, PublicKey, TransactionInstruction]
	> {
		const [userAccountPublicKey, userAccountNonce] =
			await this.getUserAccountPublicKey();

		const userPositionsAccount = new Keypair();
		const createUserPositionsAccountIx =
			await this.program.account.userPositionsAccount.createInstruction(
				userPositionsAccount
			);

		const initializeUserAccountIx =
			await this.program.instruction.initializeUserAccount(userAccountNonce, {
				accounts: {
					userAccount: userAccountPublicKey,
					authority: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					userPositionsAccount: userPositionsAccount.publicKey,
					clock: SYSVAR_CLOCK_PUBKEY,
				},
			});
		return [
			userPositionsAccount,
			createUserPositionsAccountIx,
			userAccountPublicKey,
			initializeUserAccountIx,
		];
	}

	public getPositionsAccountClient(): anchor.AccountClient {
		return this.program.account.userPositionsAccount;
	}

	public getPositionsAccountData(
		positionsKey: PublicKey
	): Promise<UserPositionData> {
		return this.getPositionsAccountClient().fetch(
			positionsKey
		) as Promise<UserPositionData>;
	}

	public getUserAccountClient(): anchor.AccountClient {
		return this.program.account.userAccount;
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
		userAccountPublicKey: PublicKey,
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		userPositionPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		if (!userPositionPublicKey) {
			const user: any = await this.program.account.userAccount.fetch(
				userAccountPublicKey
			);
			userPositionPublicKey = user.positions;
		}

		return await this.program.state.instruction.depositCollateral(amount, {
			accounts: {
				userAccount: userAccountPublicKey,
				clearingHouseCollateralAccount: this.state.collateralAccount,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				marketsAccount: this.state.marketsAccount,
				fundingRateHistory: this.state.fundingRateHistory,
				userPositionsAccount: userPositionPublicKey,
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
			createUserPositionsAccountIx,
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
			.add(createUserPositionsAccountIx)
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
			createUserPositionsAccountIx,
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
			.add(createUserPositionsAccountIx)
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

		const user: any = await this.program.account.userAccount.fetch(
			userAccountPublicKey
		);

		return await this.program.state.rpc.withdrawCollateral(amount, {
			accounts: {
				userAccount: userAccountPublicKey,
				clearingHouseCollateralAccount: this.state.collateralAccount,
				clearingHouseCollateralAccountAuthority:
					this.state.collateralAccountAuthority,
				clearingHouseInsuranceAccount: this.state.insuranceAccount,
				clearingHouseInsuranceAccountAuthority:
					this.state.insuranceAccountAuthority,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				marketsAccount: this.state.marketsAccount,
				userPositionsAccount: user.positions,
				fundingRateHistory: this.state.fundingRateHistory,
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

		const user: any = await this.program.account.userAccount.fetch(
			userAccountPublicKey
		);

		if (limitPrice == undefined) {
			limitPrice = new BN(0); // no limit
		}

		return await this.program.state.rpc.openPosition(
			direction,
			amount,
			marketIndex,
			limitPrice,
			{
				accounts: {
					userAccount: userAccountPublicKey,
					authority: this.wallet.publicKey,
					marketsAccount: this.state.marketsAccount,
					userPositionsAccount: user.positions,
					tradeHistoryAccount: this.state.tradeHistoryAccount,
					clock: SYSVAR_CLOCK_PUBKEY,
					fundingRateHistory: this.state.fundingRateHistory,
				},
			}
		);
	}

	public async closePosition(
		userAccountPublicKey: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const user: any = await this.program.account.userAccount.fetch(
			userAccountPublicKey
		);

		return await this.program.state.rpc.closePosition(marketIndex, {
			accounts: {
				userAccount: userAccountPublicKey,
				authority: this.wallet.publicKey,
				marketsAccount: this.state.marketsAccount,
				userPositionsAccount: user.positions,
				clock: SYSVAR_CLOCK_PUBKEY,
				tradeHistoryAccount: this.state.tradeHistoryAccount,
				fundingRateHistory: this.state.fundingRateHistory,
			},
		});
	}

	public async moveAmmPrice(
		baseAmount: BN,
		quoteAmount: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		return await this.program.state.rpc.moveAmmPrice(
			baseAmount,
			quoteAmount,
			marketIndex,
			{
				accounts: {
					admin: this.wallet.publicKey,
					marketsAccount: this.state.marketsAccount,
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

		console.log(
			'direction',
			direction,

			'tradeSizeInternal',
			tradeSize.toNumber()
		);
		const [newQuoteAssetAmount, newBaseAssetAmount] = this.findSwapOutput(
			market.amm.quoteAssetAmount,
			market.amm.baseAssetAmount,
			direction,
			tradeSize,
			'quote',
			market.amm.k,
			market.amm.pegMultiplier
		);

		return await this.program.state.rpc.moveAmmPrice(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			marketIndex,
			{
				accounts: {
					admin: this.wallet.publicKey,
					marketsAccount: this.state.marketsAccount,
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

		const marketsAccount: any = await this.program.account.marketsAccount.fetch(
			this.state.marketsAccount
		);
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammData = marketData.amm;

		return await this.program.state.rpc.repegAmmCurve(newPeg, marketIndex, {
			accounts: {
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				marketsAccount: this.state.marketsAccount,
				clock: SYSVAR_CLOCK_PUBKEY,
			},
		});
	}

	public async liquidate(
		liquidatorUSDCTokenPublicKey: PublicKey,
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const [liquidatorUserAccountPublicKey, liquidateeUserAccount] =
			await Promise.all([
				(async () => {
					return (await this.getUserAccountPublicKey(this.wallet.publicKey))[0];
				})(),
				(async (): Promise<any> => {
					return await this.program.account.userAccount.fetch(
						liquidateeUserAccountPublicKey
					);
				})(),
			]);

		return await this.program.state.rpc.liquidate({
			accounts: {
				liquidator: this.wallet.publicKey,
				userAccount: liquidateeUserAccountPublicKey,
				liquidatorUserAccount: liquidatorUserAccountPublicKey,
				clearingHouseCollateralAccount: this.state.collateralAccount,
				clearingHouseCollateralAccountAuthority:
					this.state.collateralAccountAuthority,
				clearingHouseInsuranceAccount: this.state.insuranceAccount,
				clearingHouseInsuranceAccountAuthority:
					this.state.insuranceAccountAuthority,
				liquidatorAccount: liquidatorUSDCTokenPublicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				marketsAccount: this.state.marketsAccount,
				userPositionsAccount: liquidateeUserAccount.positions,
				clock: SYSVAR_CLOCK_PUBKEY,
				fundingRateHistory: this.state.fundingRateHistory,
				tradeHistoryAccount: this.state.tradeHistoryAccount,
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
				marketsAccount: this.state.marketsAccount,
				oracle: oracle,
				clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
				clearingHouseInsuranceAccount: this.state.insuranceAccount,
				clearingHouseInsuranceAccountAuthority:
					this.state.insuranceAccountAuthority,
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
				marketsAccount: this.state.marketsAccount,
				userAccount,
				userPositionsAccount,
				fundingRateHistory: this.state.fundingRateHistory,
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
		const markTwapWithMantissa = market.amm.markTwap;

		const twapSpreadPct = markTwapWithMantissa
			.sub(oracleTwapWithMantissa)
			.div(oracleTwapWithMantissa.div(AMM_MANTISSA));
		// solana ts is seconds since 1970, js is milliseconds.

		// todo: need utc?
		// var now = new Date;
		// var nowUTC = Date.UTC(now.getUTCFullYear(),now.getUTCMonth(), now.getUTCDate() ,
		// now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds())/10000;

		// const nowSOL = new BN(
		//      await this.connection.getBlockTime(await this.connection.getSlot())
		// );

		// const timeSinceLastUpdate = new BN(nowUTC).sub(market.amm.fundingRateTs);

		const now = new BN((Date.now() / 1000).toFixed(0));
		const timeSinceLastUpdate = now.sub(market.amm.fundingRateTs);

		if (estimationMethod == 'lowerbound') {
			//assuming remaining funding period has no gap
			const estFundingRateLowerBound = twapSpreadPct
				.mul(payFreq)
				.mul(timeSinceLastUpdate)
				.mul(periodAdjustment)
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

		return quoteAssetAmount.mul(peg).div(baseAssetAmount);
	}

	public calculateBaseAssetPriceWithMantissa(marketIndex: BN): BN {
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		const baseAssetPriceWithMantissa = this.calculateCurvePriceWithMantissa(
			market.amm.baseAssetAmount,
			market.amm.quoteAssetAmount,
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
	) {
		this.assertIsSubscribed();

		if (amount.eq(new BN(0))) {
			return 0;
		}
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		const oldPrice = this.calculateBaseAssetPriceWithMantissa(marketIndex);

		const [newQuoteAssetAmount, newBaseAssetAmount] = this.findSwapOutput(
			market.amm.quoteAssetAmount,
			market.amm.baseAssetAmount,
			direction,
			amount.abs(),
			'quote',
			market.amm.k,
			market.amm.pegMultiplier
		);
		const entryPrice = this.calculateCurvePriceWithMantissa(
			market.amm.baseAssetAmount.sub(newBaseAssetAmount),
			market.amm.quoteAssetAmount.sub(newQuoteAssetAmount),
			market.amm.pegMultiplier
		).mul(new BN(-1));

		assert(entryPrice.gt(new BN(0)));

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
			const usdcScale = 10 ** -6;
			const minTickSize =
				usdcScale *
				(market.amm.pegMultiplier.toNumber() / AMM_MANTISSA.toNumber());

			console.log(
				'amount:',
				amount.toNumber() * usdcScale,
				'minTickSize:',
				minTickSize
			);

			assert(!oldPrice.eq(newPrice), 'insufficient `amount` passed:');
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
			market.amm.baseAssetAmount,
			market.amm.quoteAssetAmount,
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
	): [PositionDirection, BN, BN] {
		// simple function for funding rate arbitrage bot
		// return the trade direction/size in order to push price to a targetPrice
		// set a pct optional default is 100% gap filling, can set smaller.
		this.assertIsSubscribed();
		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		console.log(market.amm.baseAssetAmount, market.amm.quoteAssetAmount);
		assert(market.amm.baseAssetAmount.gt(ZERO));
		assert(targetPrice.gt(ZERO));
		assert(pct.lte(MAXPCT) && pct.gt(ZERO));

		const markPriceWithMantissa = this.calculateCurvePriceWithMantissa(
			market.amm.baseAssetAmount,
			market.amm.quoteAssetAmount,
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

		const x1 = market.amm.baseAssetAmount;
		const y1 = market.amm.quoteAssetAmount;
		const peg = market.amm.pegMultiplier;
		const k = market.amm.k.mul(AMM_MANTISSA); //todo: ensure targetPrice is MANTISSA-ifyed, use peg?

		let x2;
		let y2;
		const biasModifer = new BN(1);
		let targetPriceCalced;

		if (markPriceWithMantissa.gt(targetPrice)) {
			// overestimate y2, todo Math.sqrt
			x2 = new BN(
				Math.sqrt(
					//TODO - should use @ts-ignore when temporarily checking in things which cause an error .. it prevents the sdk from being built.
					// eslint-disable-next-line @typescript-eslint/ban-ts-comment
					//@ts-ignore
					k.div(targetPrice).mul(peg).div(AMM_MANTISSA).sub(biasModifer)
				) - 1
			);
			y2 = k.div(AMM_MANTISSA).div(x2);

			targetPriceCalced = this.calculateCurvePriceWithMantissa(x2, y2, peg);
			direction = PositionDirection.SHORT;
			tradeSize = y1.sub(y2).mul(peg).div(AMM_MANTISSA);
			baseSize = x1.sub(x2);
		} else if (markPriceWithMantissa.lt(targetPrice)) {
			// underestimate y2, todo Math.sqrt
			x2 = new BN(
				Math.sqrt(
					//TODO - should use @ts-ignore when temporarily checking in things which cause an error .. it prevents the sdk from being built.
					// eslint-disable-next-line @typescript-eslint/ban-ts-comment
					//@ts-ignore
					k.div(targetPrice).mul(peg).div(AMM_MANTISSA).add(biasModifer)
				) + 1
			);
			y2 = k.div(AMM_MANTISSA).div(x2);

			targetPriceCalced = this.calculateCurvePriceWithMantissa(x2, y2, peg);

			direction = PositionDirection.LONG;
			tradeSize = y2.sub(y1).mul(peg).div(AMM_MANTISSA);
			baseSize = x2.sub(x1);
		} else {
			// no trade, market is at target
			direction = PositionDirection.LONG;
			tradeSize = 0;
			baseSize = 0;
			return [direction, new BN(tradeSize), new BN(0)];
		}

		let tp1 = targetPrice;
		let tp2 = targetPriceCalced;
		let ogDiff = targetPrice.sub(markPriceWithMantissa);

		if (direction == PositionDirection.SHORT) {
			tp1 = targetPriceCalced;
			tp2 = targetPrice;
			ogDiff = markPriceWithMantissa.sub(targetPrice);
		}
		try {
			// console.log(
			// 	'targetPrice',
			// 	targetPrice.toNumber(),
			// 	'targetPriceCalced',
			// 	targetPriceCalced.toNumber(),
			// 	'AMM_MANTISSA',
			// 	AMM_MANTISSA.toNumber(),
			// 	'markPriceWithMantissa',
			// 	markPriceWithMantissa.toNumber()
			// );
			// console.log(
			// 	'tp1',
			// 	tp1.toNumber(),
			// 	'tp2',
			// 	tp2.toNumber(),
			// 	'ogDiff',
			// 	ogDiff.toNumber()
			// );
			// //note: high chance k is too big for .toNumber()
			// console.log('y2', y2.toNumber(), 'y1', y1.toNumber());
		} catch (err) {
			// # this code block same behavior as
			if (err instanceof TypeError) {
				// except ValueError as err:
				throw err; //     pass
			}
		}

		const entryPrice = this.calculateCurvePriceWithMantissa(
			baseSize.abs(),
			tradeSize,
			AMM_MANTISSA
		);

		assert(tp1.sub(tp2).lte(ogDiff), 'Target Price Calculation incorrect');
		// assert(tp1.sub(tp2).lt(AMM_MANTISSA), 'Target Price Calculation incorrect'); //  super OoB shorts do not
		assert(
			tp2.lte(tp1) || tp2.sub(tp1).abs() < 10,
			'Target Price Calculation incorrect' +
				tp2.toString() +
				'>=' +
				tp1.toString() +
				'err: ' +
				tp2.sub(tp1).abs().toString()
		); //todo

		return [direction, new BN(tradeSize), entryPrice];
	}

	public calculateBaseAssetPriceAfterSwapWithMantissa(
		marketIndex: BN,
		direction: PositionDirection,
		amount: BN,
		inputAsset?: string
	): BN {
		this.assertIsSubscribed();

		const market = this.getMarketsAccount().markets[marketIndex.toNumber()];
		const peg = market.amm.pegMultiplier;
		const invariant = market.amm.k;

		let inputAssetAmount;
		let outputAssetAmount;
		if (inputAsset == undefined) {
			inputAsset = 'quote';
		}
		assert(['quote', 'base'].includes(inputAsset));

		if (inputAsset == 'base') {
			inputAssetAmount = market.amm.baseAssetAmount;
			outputAssetAmount = market.amm.quoteAssetAmount;
		} else {
			inputAssetAmount = market.amm.quoteAssetAmount;
			outputAssetAmount = market.amm.baseAssetAmount;
		}

		const [newQuoteAssetAmount, newBaseAssetAmount] = this.findSwapOutput(
			inputAssetAmount,
			outputAssetAmount,
			direction,
			amount.abs(),
			inputAsset,
			invariant,
			market.amm.pegMultiplier
		);

		const newBaseAssetPriceWithMantissa = this.calculateCurvePriceWithMantissa(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			peg
		);

		return newBaseAssetPriceWithMantissa;
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

		const [, newQuoteAssetAmount] = this.findSwapOutput(
			market.amm.baseAssetAmount,
			market.amm.quoteAssetAmount,
			directionToClose,
			marketPosition.baseAssetAmount.abs(),
			'base',
			market.amm.k,
			market.amm.pegMultiplier
		);

		switch (directionToClose) {
			case PositionDirection.SHORT:
				return market.amm.quoteAssetAmount
					.sub(newQuoteAssetAmount)
					.mul(market.amm.pegMultiplier)
					.div(AMM_MANTISSA);

			case PositionDirection.LONG:
				return newQuoteAssetAmount
					.sub(market.amm.quoteAssetAmount)
					.mul(market.amm.pegMultiplier)
					.div(AMM_MANTISSA);
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

		const baseAssetValue = this.calculateBaseAssetValue(marketPosition);
		let pnlAssetAmount;

		switch (directionToClose) {
			case PositionDirection.SHORT:
				pnlAssetAmount = baseAssetValue.sub(
					marketPosition.quoteAssetNotionalAmount
				);
				break;

			case PositionDirection.LONG:
				pnlAssetAmount =
					marketPosition.quoteAssetNotionalAmount.sub(baseAssetValue);
				break;
		}

		if (withFunding) {
			const fundingRatePnL =
				this.calculatePositionFundingPNL(marketPosition).div(FUNDING_MANTISSA);

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

		const perPositionFundingRate = market.amm.cumFundingRate
			.sub(marketPosition.lastCumFunding)
			.mul(marketPosition.baseAssetAmount)
			.mul(market.amm.pegMultiplier)
			.div(AMM_MANTISSA)
			.div(AMM_MANTISSA)
			.mul(new BN(-1));

		return perPositionFundingRate;
	}
}
