import { BN, Idl, Program, Provider } from '@project-serum/anchor';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	ClearingHouseMarketsAccountData,
	ClearingHouseState,
	CurveHistory,
	DepositHistory,
	FeeStructure,
	FundingPaymentHistory,
	FundingRateHistory,
	IWallet,
	LiquidationHistory, OracleGuardRails, OracleSource,
	PositionDirection,
	TradeHistoryAccount,
	UserAccountData,
	UserPosition,
	UserPositionData,
} from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';
import { PythClient } from './pythClient';
import { squareRootBN } from './utils';

import {
	Connection,
	PublicKey,
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
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';

interface ClearingHouseEvents {
	programStateUpdate: (payload: ClearingHouseState) => void;
	marketsAccountUpdate: (payload: ClearingHouseMarketsAccountData) => void;
	fundingPaymentHistoryUpdate: (payload: FundingPaymentHistory) => void;
	fundingRateHistoryUpdate: (payload: FundingRateHistory) => void;
	tradeHistoryAccountUpdate: (payload: TradeHistoryAccount) => void;
	liquidationHistoryUpdate: (payload: LiquidationHistory) => void;
	depositHistoryUpdate: (payload: DepositHistory) => void;
	curveHistoryUpdate: (payload: CurveHistory) => void;
	update: void;
}

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
	private fundingPaymentHistory?: FundingPaymentHistory;
	private fundingRateHistory?: FundingRateHistory;
	private tradeHistoryAccount?: TradeHistoryAccount;
	private liquidationHistory?: LiquidationHistory;
	private depositHistory?: DepositHistory;
	private curveHistory?: CurveHistory;
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

	public async getClearingHouseStatePublicKeyAndNonce(): Promise<
		[PublicKey, number]
	> {
		return anchor.web3.PublicKey.findProgramAddress(
			[Buffer.from(anchor.utils.bytes.utf8.encode('clearing_house'))],
			this.program.programId
		);
	}

	statePublicKey?: PublicKey;
	public async getStatePublicKey(): Promise<PublicKey> {
		if (this.statePublicKey) {
			return this.statePublicKey;
		}
		this.statePublicKey = (
			await this.getClearingHouseStatePublicKeyAndNonce()
		)[0];
		return this.statePublicKey;
	}

	// Initialise Clearinghouse
	public async initialize(
		usdcMint: PublicKey,
		adminControlsPrices: boolean
	): Promise<[TransactionSignature, TransactionSignature]> {
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			await this.getStatePublicKey()
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Clearing house already initialized');
		}

		const [collateralVaultPublicKey, collateralVaultNonce] =
			await PublicKey.findProgramAddress(
				[Buffer.from(anchor.utils.bytes.utf8.encode('collateral_vault'))],
				this.program.programId
			);

		const [collateralVaultAuthority, _collateralVaultAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[collateralVaultPublicKey.toBuffer()],
				this.program.programId
			);

		const [insuranceVaultPublicKey, insuranceVaultNonce] =
			await PublicKey.findProgramAddress(
				[Buffer.from(anchor.utils.bytes.utf8.encode('insurance_vault'))],
				this.program.programId
			);

		const [insuranceVaultAuthority, _insuranceVaultAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[insuranceVaultPublicKey.toBuffer()],
				this.program.programId
			);

		const markets = anchor.web3.Keypair.generate();
		const depositHistory = anchor.web3.Keypair.generate();
		const fundingRateHistory = anchor.web3.Keypair.generate();
		const fundingPaymentHistory = anchor.web3.Keypair.generate();
		const tradeHistory = anchor.web3.Keypair.generate();
		const liquidationHistory = anchor.web3.Keypair.generate();
		const curveHistory = anchor.web3.Keypair.generate();

		const [clearingHouseStatePublicKey, clearingHouseNonce] =
			await this.getClearingHouseStatePublicKeyAndNonce();
		const initializeTx = await this.program.rpc.initialize(
			clearingHouseNonce,
			collateralVaultNonce,
			insuranceVaultNonce,
			adminControlsPrices,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: clearingHouseStatePublicKey,
					collateralMint: usdcMint,
					collateralVault: collateralVaultPublicKey,
					collateralVaultAuthority: collateralVaultAuthority,
					insuranceVault: insuranceVaultPublicKey,
					insuranceVaultAuthority: insuranceVaultAuthority,
					markets: markets.publicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				instructions: [
					await this.program.account.markets.createInstruction(markets),
				],
				signers: [markets],
			}
		);

		const initializeHistoryTx = await this.program.rpc.initializeHistory({
			accounts: {
				admin: this.wallet.publicKey,
				state: clearingHouseStatePublicKey,
				depositHistory: depositHistory.publicKey,
				fundingRateHistory: fundingRateHistory.publicKey,
				fundingPaymentHistory: fundingPaymentHistory.publicKey,
				tradeHistory: tradeHistory.publicKey,
				liquidationHistory: liquidationHistory.publicKey,
				curveHistory: curveHistory.publicKey,
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
			},
			instructions: [
				await this.program.account.fundingRateHistory.createInstruction(
					fundingRateHistory
				),
				await this.program.account.fundingPaymentHistory.createInstruction(
					fundingPaymentHistory
				),
				await this.program.account.tradeHistory.createInstruction(tradeHistory),
				await this.program.account.liquidationHistory.createInstruction(
					liquidationHistory
				),
				await this.program.account.depositHistory.createInstruction(
					depositHistory
				),
				await this.program.account.curveHistory.createInstruction(curveHistory),
			],
			signers: [
				depositHistory,
				fundingPaymentHistory,
				tradeHistory,
				liquidationHistory,
				fundingRateHistory,
				curveHistory,
			],
		});

		return [initializeTx, initializeHistoryTx];
	}

	public async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return;
		}

		//return and set up subscriber for state data
		const [clearingHouseStatePublicKey, _] =
			await this.getClearingHouseStatePublicKeyAndNonce();
		const latestState = (await this.program.account.state.fetch(
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
		const latestMarketsAccount = (await this.program.account.markets.fetch(
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
			)) as FundingPaymentHistory;
		this.fundingPaymentHistory = latestFundingPaymentHistory;

		this.eventEmitter.emit(
			'fundingPaymentHistoryUpdate',
			latestFundingPaymentHistory
		);

		this.program.account.fundingPaymentHistory
			.subscribe(this.state.fundingPaymentHistory, this.opts.commitment)
			.on('change', async (updateData) => {
				this.fundingPaymentHistory = updateData;

				this.eventEmitter.emit('fundingPaymentHistoryUpdate', updateData);
			});

		const latestFundingRateHistory =
			(await this.program.account.fundingRateHistory.fetch(
				this.state.fundingRateHistory
			)) as FundingRateHistory;
		this.fundingRateHistory = latestFundingRateHistory;

		this.eventEmitter.emit(
			'fundingRateHistoryUpdate',
			latestFundingRateHistory
		);

		this.program.account.fundingRateHistory
			.subscribe(this.state.fundingRateHistory, this.opts.commitment)
			.on('change', async (updateData) => {
				this.fundingRateHistory = updateData;

				this.eventEmitter.emit('fundingRateHistoryUpdate', updateData);
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

		const lastLiquidationHistory =
			(await this.program.account.liquidationHistory.fetch(
				this.state.liquidationHistory
			)) as LiquidationHistory;
		this.liquidationHistory = lastLiquidationHistory;

		this.eventEmitter.emit('liquidationHistoryUpdate', lastLiquidationHistory);

		this.program.account.liquidationHistory
			.subscribe(this.state.liquidationHistory, this.opts.commitment)
			.on('change', async (updateData) => {
				this.liquidationHistory = updateData;
				this.eventEmitter.emit('liquidationHistoryUpdate', updateData);
			});

		const lastDepositHistory = (await this.program.account.depositHistory.fetch(
			this.state.depositHistory
		)) as DepositHistory;
		this.depositHistory = lastDepositHistory;

		this.eventEmitter.emit('depositHistoryUpdate', lastDepositHistory);

		this.program.account.depositHistory
			.subscribe(this.state.depositHistory, this.opts.commitment)
			.on('change', async (updateData) => {
				this.depositHistory = updateData;
				this.eventEmitter.emit('depositHistoryUpdate', updateData);
			});

		const lastCurveHistory = (await this.program.account.curveHistory.fetch(
			this.state.curveHistory
		)) as CurveHistory;
		this.curveHistory = lastCurveHistory;

		this.eventEmitter.emit('curveHistoryUpdate', lastCurveHistory);

		this.program.account.curveHistory
			.subscribe(this.state.curveHistory, this.opts.commitment)
			.on('change', async (updateData) => {
				this.curveHistory = updateData;
				this.eventEmitter.emit('curveHistoryUpdate', updateData);
			});

		this.isSubscribed = true;

		this.eventEmitter.emit('update');

		return true;
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await this.program.account.state.unsubscribe(
			await this.getStatePublicKey()
		);
		await this.program.account.markets.unsubscribe(this.state.markets);
		await this.program.account.fundingPaymentHistory.unsubscribe(
			this.state.fundingPaymentHistory
		);
		await this.program.account.fundingRateHistory.unsubscribe(
			this.state.fundingRateHistory
		);
		await this.program.account.tradeHistory.unsubscribe(
			this.state.tradeHistory
		);
		await this.program.account.liquidationHistory.unsubscribe(
			this.state.liquidationHistory
		);
		await this.program.account.depositHistory.unsubscribe(
			this.state.depositHistory
		);
		await this.program.account.curveHistory.unsubscribe(
			this.state.curveHistory
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

	public getFundingPaymentHistory(): FundingPaymentHistory {
		this.assertIsSubscribed();
		return this.fundingPaymentHistory;
	}

	public getFundingRateHistory(): FundingRateHistory {
		this.assertIsSubscribed();
		return this.fundingRateHistory;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		return this.tradeHistoryAccount;
	}

	public getLiquidationHistory(): LiquidationHistory {
		this.assertIsSubscribed();
		return this.liquidationHistory;
	}

	public getDepositHistory(): DepositHistory {
		this.assertIsSubscribed();
		return this.depositHistory;
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

		const tx = new Transaction().add(initializeUserAccountIx);
		const txSig = await this.program.provider.send(tx, [userPositionsAccount]);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(): Promise<
		[Keypair, PublicKey, TransactionInstruction]
	> {
		const [userPublicKey, userAccountNonce] =
			await this.getUserAccountPublicKey();

		const remainingAccounts = [];
		const optionalAccounts = {
			whitelistToken: false,
		};

		const state = this.getState();
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
						clock: SYSVAR_CLOCK_PUBKEY,
						state: await this.getStatePublicKey(),
					},
					remainingAccounts: remainingAccounts,
				}
			);
		return [userPositions, userPublicKey, initializeUserAccountIx];
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
			const user: any = await this.program.account.user.fetch(userPublicKey);
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
				depositHistory: this.state.depositHistory,
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

	public async deleteUser() : Promise<TransactionSignature> {
		const userAccountPublicKey = (await this.getUserAccountPublicKey())[0];
		const user = await this.program.account.user.fetch(userAccountPublicKey);
		return await this.program.rpc.deleteUser({
			accounts: {
				user: userAccountPublicKey,
				userPositions: user.positions,
				authority: this.wallet.publicKey,
			}
		});
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
				collateralVaultAuthority: this.state.collateralVaultAuthority,
				insuranceVault: this.state.insuranceVault,
				insuranceVaultAuthority: this.state.insuranceVaultAuthority,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: this.state.markets,
				userPositions: user.positions,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
				depositHistory: this.state.depositHistory,
			},
		});
	}

	public async openPosition(
		userAccountPublicKey: PublicKey,
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN,
		driftToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const user: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		if (limitPrice == undefined) {
			limitPrice = new BN(0); // no limit
		}

		const optionalAccounts = {
			driftToken: false,
			referrer: false,
		};
		const remainingAccounts = [];
		if (driftToken) {
			optionalAccounts.driftToken = true;
			remainingAccounts.push({
				pubkey: driftToken,
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

		return await this.program.rpc.openPosition(
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
					markets: this.state.markets,
					userPositions: user.positions,
					tradeHistory: this.state.tradeHistory,
					fundingPaymentHistory: this.state.fundingPaymentHistory,
					fundingRateHistory: this.state.fundingRateHistory,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async closePosition(
		userAccountPublicKey: PublicKey,
		marketIndex: BN,
		driftToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const user: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		const priceOracle =
			this.getMarketsAccount().markets[marketIndex.toNumber()].amm.oracle;

		const optionalAccounts = {
			driftToken: false,
			referrer: false,
		};
		const remainingAccounts = [];
		if (driftToken) {
			optionalAccounts.driftToken = true;
			remainingAccounts.push({
				pubkey: driftToken,
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

		return await this.program.rpc.closePosition(marketIndex, optionalAccounts, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				markets: this.state.markets,
				userPositions: user.positions,
				tradeHistory: this.state.tradeHistory,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
				fundingRateHistory: this.state.fundingRateHistory,
				oracle: priceOracle,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async moveAmmPrice(
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		return await this.program.rpc.moveAmmPrice(
			baseAssetReserve,
			quoteAssetReserve,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					markets: this.state.markets,
				},
			}
		);
	}

	public async updateK(
		sqrtK: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		return await this.program.rpc.updateK(sqrtK, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				markets: this.state.markets,
				curveHistory: this.state.curveHistory,
			},
		});
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
				curveHistory: this.state.curveHistory,
			},
		});
	}

	public async liquidate(
		liquidatorUSDCTokenPublicKey: PublicKey,
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const liquidateeUserAccount: any = await this.program.account.user.fetch(
			liquidateeUserAccountPublicKey
		);
		const liquidateePositions: UserPositionData = await this.program.account.userPositions.fetch(
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

		return await this.program.rpc.liquidate({
			accounts: {
				state: await this.getStatePublicKey(),
				liquidator: this.wallet.publicKey,
				user: liquidateeUserAccountPublicKey,
				collateralVault: this.state.collateralVault,
				collateralVaultAuthority: this.state.collateralVaultAuthority,
				insuranceVault: this.state.insuranceVault,
				insuranceVaultAuthority: this.state.insuranceVaultAuthority,
				liquidatorAccount: liquidatorUSDCTokenPublicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: this.state.markets,
				userPositions: liquidateeUserAccount.positions,
				tradeHistory: this.state.tradeHistory,
				liquidationHistory: this.state.liquidationHistory,
				fundingPaymentHistory: this.state.fundingPaymentHistory,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async updateFundingRate(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const tx = await this.program.rpc.updateFundingRate(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				markets: this.state.markets,
				oracle: oracle,
				fundingRateHistory: this.state.fundingRateHistory,
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
				state: await this.getStatePublicKey(),
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
		const secondsInHour = new BN(3600);
		const hoursInDay = new BN(24);

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

		const now = new BN((Date.now() / 1000).toFixed(0));
		const timeSinceLastUpdate = now.sub(market.amm.lastFundingRateTs);

		const lastMarkTwapWithMantissa = market.amm.lastMarkPriceTwap;
		const lastMarkPriceTwapTs = market.amm.lastMarkPriceTwapTs;

		const timeSinceLastMarkChange = now.sub(lastMarkPriceTwapTs);
		const markTwapTimeSinceLastUpdate = lastMarkPriceTwapTs.sub(
			market.amm.lastFundingRateTs
		);

		const baseAssetPriceWithMantissa =
			this.calculateBaseAssetPriceWithMantissa(marketIndex);

		const markTwapWithMantissa = markTwapTimeSinceLastUpdate
			.mul(lastMarkTwapWithMantissa)
			.add(timeSinceLastMarkChange.mul(baseAssetPriceWithMantissa))
			.div(timeSinceLastMarkChange.add(markTwapTimeSinceLastUpdate));

		const twapSpread = markTwapWithMantissa.sub(oracleTwapWithMantissa);

		const twapSpreadPct = twapSpread
			.mul(AMM_MANTISSA)
			.mul(new BN(100))
			.div(oracleTwapWithMantissa);

		if (estimationMethod == 'lowerbound') {
			//assuming remaining funding period has no gap
			const estFundingRateLowerBound = twapSpreadPct
				.mul(payFreq)
				.mul(BN.min(secondsInHour, timeSinceLastUpdate))
				.mul(periodAdjustment)
				.div(secondsInHour)
				.div(secondsInHour)
				.div(hoursInDay);
			return estFundingRateLowerBound;
		} else {
			const estFundingRate = twapSpreadPct
				.mul(periodAdjustment)
				.div(hoursInDay);

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

		const baseAssetValue =
			this.calculateBaseAssetValue(marketPosition).div(AMM_MANTISSA);
		let pnlAssetAmount;

		switch (directionToClose) {
			case PositionDirection.SHORT:
				pnlAssetAmount = baseAssetValue.sub(marketPosition.quoteAssetAmount);
				break;

			case PositionDirection.LONG:
				pnlAssetAmount = marketPosition.quoteAssetAmount.sub(baseAssetValue);
				break;
		}

		if (withFunding) {
			const fundingRatePnL = this.calculatePositionFundingPNL(
				marketPosition
			).div(PRICE_TO_USDC_PRECISION);

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

	public async withdrawFees(
		amount: BN,
		recipient: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const state = await this.getState();
		return await this.program.rpc.withdrawFees(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
				recipient: recipient,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async withdrawFromInsuranceVault(
		amount: BN,
		recipient: PublicKey
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const state = await this.getState();
		return await this.program.rpc.withdrawFromInsuranceVault(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				recipient: recipient,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async withdrawFromInsuranceVaultToMarket(
		marketIndex: BN,
		amount: BN,
	): Promise<TransactionSignature> {
		this.assertIsSubscribed();

		const state = await this.getState();
		return await this.program.rpc.withdrawFromInsuranceVaultToMarket(marketIndex, amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				markets: state.markets,
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				collateralVault: state.collateralVault,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async updateAdmin(admin: PublicKey): Promise<TransactionSignature> {
		return await this.program.rpc.updateAdmin(admin, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateMarginRatio(
		marginRatioInitial: BN,
		marginRatioPartial: BN,
		marginRatioMaintenance: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarginRatio(
			marginRatioInitial,
			marginRatioPartial,
			marginRatioMaintenance,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePartialLiquidationClosePercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationClosePercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePartialLiquidationPenaltyPercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationPenaltyPercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFullLiquidationPenaltyPercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFullLiquidationPenaltyPercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePartialLiquidationShareDenominator(
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationLiquidatorShareDenominator(
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFullLiquidationShareDenominator(
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFullLiquidationLiquidatorShareDenominator(
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFee(fees: FeeStructure): Promise<TransactionSignature> {
		return await this.program.rpc.updateFee(fees, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateOracleGuardRails(oracleGuardRails: OracleGuardRails): Promise<TransactionSignature> {
		return await this.program.rpc.updateOracleGuardRails(oracleGuardRails, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateMarketOracle(marketIndex: BN, oracle: PublicKey, oracleSource: OracleSource): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketOracle(marketIndex, oracle, oracleSource, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				markets: this.state.markets
			},
		});
	}

	public async updateMarketMinimumTradeSize(marketIndex: BN, minimumTradeSize: BN): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketMinimumTradeSize(marketIndex, minimumTradeSize, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				markets: this.state.markets
			},
		});
	}

	public async updateWhitelistMint(
		whitelistMint?: PublicKey
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateWhitelistMint(whitelistMint, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateDriftMint(
		driftMint: PublicKey
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateDriftMint(driftMint, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateMaxDeposit(maxDeposit: BN): Promise<TransactionSignature> {
		return await this.program.rpc.updateMaxDeposit(maxDeposit, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateFundingPaused(
		fundingPaused: boolean
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFundingPaused(fundingPaused, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateExchangePaused(
		exchangePaused: boolean
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateExchangePaused(exchangePaused, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async disableAdminControlsPrices(): Promise<TransactionSignature> {
		return await this.program.rpc.disableAdminControlsPrices({
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public triggerEvent(eventName: keyof ClearingHouseEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}
}
