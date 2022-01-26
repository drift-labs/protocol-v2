import { BN, Idl, Program, Provider } from '@project-serum/anchor';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	MarketsAccount,
	StateAccount,
	DepositHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	IWallet,
	LiquidationHistoryAccount,
	PositionDirection,
	TradeHistoryAccount,
	UserAccount,
	Market,
	ExtendedCurveHistoryAccount,
} from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';

import {
	Connection,
	PublicKey,
	TransactionSignature,
	Keypair,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';

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
	ClearingHouseAccountTypes,
} from './accounts/types';
import { DefaultClearingHouseAccountSubscriber } from './accounts/defaultClearingHouseAccountSubscriber';
import { TxSender } from './tx/types';
import { DefaultTxSender } from './tx/defaultTxSender';
import { wrapInTx } from './tx/utils';

/**
 * # ClearingHouse
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 *
 * The default way to construct a ClearingHouse instance is using the {@link from} method. This will create an instance using the static {@link DefaultClearingHouseAccountSubscriber}, which will use a websocket for each state account subscription.
 * Alternatively, if you want to implement your own method of subscribing to the state accounts on the blockchain, you can implement a {@link ClearingHouseAccountSubscriber} and use it in the {@link ClearingHouse.constructor}
 */
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

	/**
	 *
	 * @param optionalSubscriptions - Optional extra accounts to subcribe to. Always subscribes to base clearing house state and market account state by default. You should only subscribe to optional extra accounts if required, to avoid overloading your RPC.
	 * @returns Promise<boolean> : SubscriptionSuccess
	 */
	public async subscribe(
		optionalSubscriptions?: ClearingHouseAccountTypes[]
	): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe(
			optionalSubscriptions
		);
		return this.isSubscribed;
	}

	/**
	 * Shorthand function to subscribe to all available Clearing House State Accounts
	 * @returns Promise<boolean> : SubscriptionSuccess
	 */
	public async subscribeToAll(): Promise<boolean> {
		return this.subscribe([
			'curveHistoryAccount',
			'depositHistoryAccount',
			'fundingPaymentHistoryAccount',
			'fundingRateHistoryAccount',
			'liquidationHistoryAccount',
			'tradeHistoryAccount',
		]);
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	/**
	 * Unsubscribe from all currently subscribed state accounts
	 */
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

	public getCurveHistoryAccount(): ExtendedCurveHistoryAccount {
		return this.accountSubscriber.getCurveHistoryAccount();
	}

	/**
	 * Update the wallet to use for clearing house transactions and linked user account
	 * @param newWallet
	 */
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
	/**
	 * Get the address for the Clearing House User's account. NOT the user's wallet address.
	 * @returns
	 */
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

	/**
	 * Creates the Clearing House User account for a user, and deposits some initial collateral
	 * @param amount
	 * @param collateralAccountPublicKey
	 * @returns
	 */
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
		const user: any = await this.program.account.user.fetch(
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

	/**
	 * Close an entire position. If you want to reduce a position, use the {@link openPosition} method in the opposite direction of the current position.
	 * @param marketIndex
	 * @param discountToken
	 * @param referrer
	 * @returns
	 */
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
		const liquidateePositions: any =
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

	public triggerEvent(eventName: keyof ClearingHouseAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}
}
