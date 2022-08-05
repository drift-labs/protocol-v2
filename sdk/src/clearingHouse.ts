import * as anchor from '@project-serum/anchor';
import { AnchorProvider, BN, Idl, Program } from '@project-serum/anchor';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import clearingHouseIDL from './idl/clearing_house.json';
import {
	BankAccount,
	DefaultOrderParams,
	IWallet,
	MakerInfo,
	MarketAccount,
	OptionalOrderParams,
	Order,
	OrderParams,
	OrderType,
	PositionDirection,
	StateAccount,
	TakerInfo,
	UserAccount,
	UserBankBalance,
} from './types';

import {
	AccountMeta,
	ConfirmOptions,
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Signer,
	SystemProgram,
	Transaction,
	TransactionInstruction,
	TransactionSignature,
} from '@solana/web3.js';

import {
	closeAccount,
	initializeAccount,
	WRAPPED_SOL_MINT,
} from '@project-serum/serum/lib/token-instructions';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { PollingClearingHouseAccountSubscriber } from './accounts/pollingClearingHouseAccountSubscriber';
import {
	ClearingHouseAccountEvents,
	ClearingHouseAccountSubscriber,
	DataAndSlot,
} from './accounts/types';
import { WebSocketClearingHouseAccountSubscriber } from './accounts/webSocketClearingHouseAccountSubscriber';
import {
	getClearingHouseStateAccountPublicKey,
	getMarketPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
} from './addresses/pda';
import { ClearingHouseConfig } from './clearingHouseConfig';
import { ClearingHouseUser } from './clearingHouseUser';
import { ClearingHouseUserAccountSubscriptionConfig } from './clearingHouseUserConfig';
import { getMarketsBanksAndOraclesForSubscription } from './config';
import { BankConfig } from './constants/banks';
import { QUOTE_ASSET_BANK_INDEX, ZERO } from './constants/numericConstants';
import { getTokenAmount } from './math/bankBalance';
import { findDirectionToClose, positionIsAvailable } from './math/position';
import { OraclePriceData } from './oracles/types';
import { TokenFaucet } from './tokenFaucet';
import { RetryTxSender } from './tx/retryTxSender';
import { TxSender } from './tx/types';
import { wrapInTx } from './tx/utils';
import { DEFAULT_USER_NAME, encodeName } from './userName';
import { getTokenAddress } from './util/getTokenAddress';

/**
 * # ClearingHouse
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 */
export class ClearingHouse {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: AnchorProvider;
	opts?: ConfirmOptions;
	users = new Map<number, ClearingHouseUser>();
	activeUserId: number;
	userAccountSubscriptionConfig: ClearingHouseUserAccountSubscriptionConfig;
	accountSubscriber: ClearingHouseAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	_isSubscribed = false;
	txSender: TxSender;
	marketLastSlotCache = new Map<number, number>();

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	public constructor(config: ClearingHouseConfig) {
		this.connection = config.connection;
		this.wallet = config.wallet;
		this.opts = config.opts || AnchorProvider.defaultOptions();
		this.provider = new AnchorProvider(
			config.connection,
			config.wallet,
			this.opts
		);
		this.program = new Program(
			clearingHouseIDL as Idl,
			config.programID,
			this.provider
		);

		const userIds = config.userIds ?? [0];
		this.activeUserId = config.activeUserId ?? userIds[0];
		this.userAccountSubscriptionConfig =
			config.accountSubscription?.type === 'polling'
				? {
						type: 'polling',
						accountLoader: config.accountSubscription.accountLoader,
				  }
				: {
						type: 'websocket',
				  };
		this.createUsers(userIds, this.userAccountSubscriptionConfig);

		let marketIndexes = config.marketIndexes;
		let bankIndexes = config.bankIndexes;
		let oracleInfos = config.oracleInfos;
		if (config.env) {
			const {
				marketIndexes: envMarketIndexes,
				bankIndexes: envBankIndexes,
				oracleInfos: envOralceInfos,
			} = getMarketsBanksAndOraclesForSubscription(config.env);
			marketIndexes = marketIndexes ? marketIndexes : envMarketIndexes;
			bankIndexes = bankIndexes ? bankIndexes : envBankIndexes;
			oracleInfos = oracleInfos ? oracleInfos : envOralceInfos;
		}

		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingClearingHouseAccountSubscriber(
				this.program,
				config.accountSubscription.accountLoader,
				marketIndexes ?? [],
				bankIndexes ?? [],
				oracleInfos ?? []
			);
		} else {
			this.accountSubscriber = new WebSocketClearingHouseAccountSubscriber(
				this.program,
				config.marketIndexes ?? [],
				config.bankIndexes ?? [],
				config.oracleInfos ?? []
			);
		}
		this.eventEmitter = this.accountSubscriber.eventEmitter;
		this.txSender = new RetryTxSender(
			this.provider,
			config.txSenderConfig?.timeout,
			config.txSenderConfig?.retrySleep,
			config.txSenderConfig?.additionalConnections
		);
	}

	createUsers(
		userIds: number[],
		accountSubscriptionConfig: ClearingHouseUserAccountSubscriptionConfig
	): void {
		for (const userId of userIds) {
			const user = this.createUser(userId, accountSubscriptionConfig);
			this.users.set(userId, user);
		}
	}

	createUser(
		userId: number,
		accountSubscriptionConfig: ClearingHouseUserAccountSubscriptionConfig
	): ClearingHouseUser {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			userId
		);

		return new ClearingHouseUser({
			clearingHouse: this,
			userAccountPublicKey,
			accountSubscription: accountSubscriptionConfig,
		});
	}

	public async subscribe(): Promise<boolean> {
		const subscribePromises = this.subscribeUsers().concat(
			this.accountSubscriber.subscribe()
		);
		this.isSubscribed = (await Promise.all(subscribePromises)).reduce(
			(success, prevSuccess) => success && prevSuccess
		);
		return this.isSubscribed;
	}

	subscribeUsers(): Promise<boolean>[] {
		return [...this.users.values()].map((user) => user.subscribe());
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		await Promise.all(
			[...this.users.values()]
				.map((user) => user.fetchAccounts())
				.concat(this.accountSubscriber.fetch())
		);
	}

	public async unsubscribe(): Promise<void> {
		const unsubscribePromises = this.unsubscribeUsers().concat(
			this.accountSubscriber.unsubscribe()
		);
		await Promise.all(unsubscribePromises);
		this.isSubscribed = false;
	}

	unsubscribeUsers(): Promise<void>[] {
		return [...this.users.values()].map((user) => user.unsubscribe());
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
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	public getMarketAccount(marketIndex: BN | number): MarketAccount | undefined {
		marketIndex = marketIndex instanceof BN ? marketIndex : new BN(marketIndex);
		return this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
	}

	public getMarketAccounts(): MarketAccount[] {
		return this.accountSubscriber
			.getMarketAccountsAndSlots()
			.map((value) => value.data);
	}

	public getBankAccount(bankIndex: BN | number): BankAccount | undefined {
		bankIndex = bankIndex instanceof BN ? bankIndex : new BN(bankIndex);
		return this.accountSubscriber.getBankAccountAndSlot(bankIndex).data;
	}

	public getQuoteAssetBankAccount(): BankAccount {
		return this.accountSubscriber.getBankAccountAndSlot(QUOTE_ASSET_BANK_INDEX)
			.data;
	}

	public getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey
	): DataAndSlot<OraclePriceData> | undefined {
		return this.accountSubscriber.getOraclePriceDataAndSlot(oraclePublicKey);
	}

	/**
	 * Update the wallet to use for clearing house transactions and linked user account
	 * @param newWallet
	 * @param userIds
	 * @param activeUserId
	 */
	public async updateWallet(
		newWallet: IWallet,
		userIds = [0],
		activeUserId = 0
	): Promise<void> {
		const newProvider = new AnchorProvider(
			this.connection,
			newWallet,
			this.opts
		);
		const newProgram = new Program(
			clearingHouseIDL as Idl,
			this.program.programId,
			newProvider
		);

		// Update provider for txSender with new wallet details
		this.txSender.provider = newProvider;

		this.wallet = newWallet;
		this.provider = newProvider;
		this.program = newProgram;

		if (this.isSubscribed) {
			await Promise.all(this.unsubscribeUsers());
		}
		this.users.clear();
		this.createUsers(userIds, this.userAccountSubscriptionConfig);
		if (this.isSubscribed) {
			await Promise.all(this.subscribeUsers());
		}

		this.activeUserId = activeUserId;
	}

	public async switchActiveUser(userId: number): Promise<void> {
		this.activeUserId = userId;
	}

	public async addUser(userId: number): Promise<void> {
		if (this.users.has(userId)) {
			return;
		}

		const user = this.createUser(userId, this.userAccountSubscriptionConfig);
		await user.subscribe();
		this.users.set(userId, user);
	}

	public async initializeUserAccount(
		userId = 0,
		name = DEFAULT_USER_NAME
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name);

		const tx = new Transaction().add(initializeUserAccountIx);
		const { txSig } = await this.txSender.send(tx, [], this.opts);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(
		userId = 0,
		name = DEFAULT_USER_NAME
	): Promise<[PublicKey, TransactionInstruction]> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			userId
		);

		const nameBuffer = encodeName(name);
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(userId, nameBuffer, {
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					payer: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					state: await this.getStatePublicKey(),
				},
			});

		return [userAccountPublicKey, initializeUserAccountIx];
	}

	public getUser(userId?: number): ClearingHouseUser {
		userId = userId ?? this.activeUserId;
		if (!this.users.has(userId)) {
			throw new Error(`Clearing House has no user for user id ${userId}`);
		}
		return this.users.get(userId);
	}

	public getUsers(): ClearingHouseUser[] {
		return [...this.users.values()];
	}

	public async getUserAccountPublicKey(): Promise<PublicKey> {
		return this.getUser().userAccountPublicKey;
	}

	public getUserAccount(userId?: number): UserAccount | undefined {
		return this.getUser(userId).getUserAccount();
	}

	public getUserAccountAndSlot(
		userId?: number
	): DataAndSlot<UserAccount> | undefined {
		return this.getUser(userId).getUserAccountAndSlot();
	}

	public getUserBankBalance(
		bankIndex: number | BN
	): UserBankBalance | undefined {
		const bankIndexBN = bankIndex instanceof BN ? bankIndex : new BN(bankIndex);
		return this.getUserAccount().bankBalances.find((bankBalance) =>
			bankBalance.bankIndex.eq(bankIndexBN)
		);
	}

	public getQuoteAssetTokenAmount(): BN {
		const bank = this.getBankAccount(QUOTE_ASSET_BANK_INDEX);
		const userBankBalance = this.getUserBankBalance(QUOTE_ASSET_BANK_INDEX);
		return getTokenAmount(
			userBankBalance.balance,
			bank,
			userBankBalance.balanceType
		);
	}

	getRemainingAccounts(params: {
		writableMarketIndex?: BN;
		writableBankIndex?: BN;
	}): AccountMeta[] {
		const userAccountAndSlot = this.getUserAccountAndSlot();
		if (!userAccountAndSlot) {
			throw Error(
				'No user account found. Most likely user account does not exist or failed to fetch account'
			);
		}
		const { data: userAccount, slot: lastUserPositionsSlot } =
			userAccountAndSlot;

		const oracleAccountMap = new Map<string, AccountMeta>();
		const bankAccountMap = new Map<number, AccountMeta>();
		const marketAccountMap = new Map<number, AccountMeta>();
		for (const [marketIndexNum, slot] of this.marketLastSlotCache.entries()) {
			// if cache has more recent slot than user positions account slot, add market to remaining accounts
			// otherwise remove from slot
			if (slot > lastUserPositionsSlot) {
				const marketAccount = this.getMarketAccount(marketIndexNum);
				marketAccountMap.set(marketIndexNum, {
					pubkey: marketAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
					pubkey: marketAccount.amm.oracle,
					isSigner: false,
					isWritable: false,
				});
			} else {
				this.marketLastSlotCache.delete(marketIndexNum);
			}
		}

		for (const position of userAccount.positions) {
			if (!positionIsAvailable(position)) {
				const marketIndexNum = position.marketIndex.toNumber();
				const marketAccount = this.getMarketAccount(marketIndexNum);
				marketAccountMap.set(marketIndexNum, {
					pubkey: marketAccount.pubkey,
					isSigner: false,
					// isWritable: false, // TODO
					isWritable: true,
				});
				oracleAccountMap.set(marketAccount.pubkey.toString(), {
					pubkey: marketAccount.amm.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
		}

		if (params.writableMarketIndex) {
			const marketAccount = this.getMarketAccount(
				params.writableMarketIndex.toNumber()
			);
			marketAccountMap.set(params.writableMarketIndex.toNumber(), {
				pubkey: marketAccount.pubkey,
				isSigner: false,
				isWritable: true,
			});
			oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
				pubkey: marketAccount.amm.oracle,
				isSigner: false,
				isWritable: false,
			});
		}

		for (const userBankBalance of userAccount.bankBalances) {
			if (!userBankBalance.balance.eq(ZERO)) {
				const bankAccount = this.getBankAccount(userBankBalance.bankIndex);
				bankAccountMap.set(userBankBalance.bankIndex.toNumber(), {
					pubkey: bankAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				if (!bankAccount.bankIndex.eq(ZERO)) {
					oracleAccountMap.set(bankAccount.oracle.toString(), {
						pubkey: bankAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		if (params.writableBankIndex) {
			const bankAccount = this.getBankAccount(params.writableBankIndex);
			bankAccountMap.set(params.writableBankIndex.toNumber(), {
				pubkey: bankAccount.pubkey,
				isSigner: false,
				isWritable: true,
			});
			if (!bankAccount.bankIndex.eq(ZERO)) {
				oracleAccountMap.set(bankAccount.oracle.toString(), {
					pubkey: bankAccount.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
		}

		return [
			...oracleAccountMap.values(),
			...bankAccountMap.values(),
			...marketAccountMap.values(),
		];
	}

	public getOrder(orderId: BN | number): Order | undefined {
		const orderIdBN = orderId instanceof BN ? orderId : new BN(orderId);
		return this.getUserAccount()?.orders.find((order) =>
			order.orderId.eq(orderIdBN)
		);
	}

	public getOrderByUserId(userOrderId: number): Order | undefined {
		return this.getUserAccount()?.orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	public async deposit(
		amount: BN,
		authority: PublicKey,
		bank: BankConfig,
		userId?: number,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const tx = new Transaction();
		const additionalSigners: Array<Signer> = [];

		const bankIndex = bank.bankIndex;

		let collateralAccountPublicKey: PublicKey;

		const isSolBank = bank.mint.equals(WRAPPED_SOL_MINT);

		if (isSolBank) {
			const { startIxs, tokenAccount, signers } = await this.handleSolDeposit(
				authority,
				bank,
				amount
			);

			startIxs.forEach((ix) => {
				tx.add(ix);
			});

			signers.forEach((signer) => additionalSigners.push(signer));

			collateralAccountPublicKey = tokenAccount;
		} else {
			collateralAccountPublicKey = await getTokenAddress(
				bank.mint.toString(),
				authority.toString()
			);
		}

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			bankIndex,
			collateralAccountPublicKey,
			userId,
			reduceOnly,
			true
		);

		tx.add(depositCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (isSolBank) {
			tx.add(
				closeAccount({
					source: collateralAccountPublicKey,
					destination: authority,
					owner: authority,
				})
			);
		}

		const { txSig } = await this.txSender.send(
			tx,
			additionalSigners,
			this.opts
		);
		return txSig;
	}

	async getDepositInstruction(
		amount: BN,
		bankIndex: BN,
		userTokenAccount: PublicKey,
		userId?: number,
		reduceOnly = false,
		userInitialized = true
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = userId
			? await getUserAccountPublicKey(
					this.program.programId,
					this.wallet.publicKey,
					userId
			  )
			: await this.getUserAccountPublicKey();

		let remainingAccounts = [];
		if (userInitialized) {
			remainingAccounts = this.getRemainingAccounts({
				writableBankIndex: bankIndex,
			});
		} else {
			const bankAccount = this.getBankAccount(bankIndex);
			if (!bankAccount.oracle.equals(PublicKey.default)) {
				remainingAccounts.push({
					pubkey: bankAccount.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
			remainingAccounts.push({
				pubkey: bankAccount.pubkey,
				isSigner: false,
				isWritable: true,
			});
		}

		const bank = this.getBankAccount(bankIndex);

		return await this.program.instruction.deposit(
			bankIndex,
			amount,
			reduceOnly,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					bank: bank.pubkey,
					bankVault: bank.vault,
					user: userAccountPublicKey,
					userTokenAccount: userTokenAccount,
					authority: this.wallet.publicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	private async getSolWithdrawalIxs(
		authority: PublicKey,
		bank: BankConfig,
		amount: BN
	) {
		const result = {
			ixs: [],
			signers: [],
		};

		const bankAccount = this.getBankAccount(bank.bankIndex);

		// Create a temporary wrapped SOL account to store the SOL that we're depositing
		const wrappedSolAccount = new Keypair();

		const lamportsPrecisionExp = new BN(Math.log10(LAMPORTS_PER_SOL));

		const amountInLamports = amount.mul(
			new BN(10).pow(lamportsPrecisionExp.sub(new BN(bankAccount.decimals)))
		);

		result.ixs.push(
			SystemProgram.createAccount({
				fromPubkey: authority,
				newAccountPubkey: wrappedSolAccount.publicKey,
				lamports: LAMPORTS_PER_SOL / 100,
				space: 165,
				programId: TOKEN_PROGRAM_ID,
			})
		);

		result.ixs.push(
			initializeAccount({
				account: wrappedSolAccount.publicKey,
				mint: WRAPPED_SOL_MINT,
				owner: authority,
			})
		);

		result.signers.push(wrappedSolAccount);

		const withdrawIx = await this.getWithdrawIx(
			amountInLamports,
			bank.bankIndex,
			wrappedSolAccount.publicKey,
			true
		);

		result.ixs.push(withdrawIx);

		result.ixs.push(
			closeAccount({
				source: wrappedSolAccount.publicKey,
				destination: authority,
				owner: authority,
			})
		);

		return result;
	}

	private async handleSolDeposit(
		authority: PublicKey,
		bank: BankConfig,
		amount: BN
	): Promise<{
		startIxs: anchor.web3.TransactionInstruction[];
		tokenAccount: PublicKey;
		signers: Signer[];
	}> {
		const result = {
			startIxs: [],
			tokenAccount: PublicKey.default,
			signers: [],
		};

		const bankAccount = this.getBankAccount(bank.bankIndex);

		// Create a temporary wrapped SOL account to store the SOL that we're depositing
		const wrappedSolAccount = new Keypair();

		const lamportsPrecisionExp = new BN(Math.log10(LAMPORTS_PER_SOL));
		const lamportsPerSol = new BN(LAMPORTS_PER_SOL);

		const amountInLamports = amount.mul(
			new BN(10).pow(lamportsPrecisionExp.sub(new BN(bankAccount.decimals)))
		);

		const rentSpaceLamports = lamportsPerSol.div(new BN(100));

		const depositAmountLamports = amountInLamports.add(rentSpaceLamports);

		result.startIxs.push(
			SystemProgram.createAccount({
				fromPubkey: authority,
				newAccountPubkey: wrappedSolAccount.publicKey,
				lamports: depositAmountLamports.toNumber(),
				space: 165,
				programId: TOKEN_PROGRAM_ID,
			})
		);

		result.startIxs.push(
			initializeAccount({
				account: wrappedSolAccount.publicKey,
				mint: WRAPPED_SOL_MINT,
				owner: authority,
			})
		);

		result.signers.push(wrappedSolAccount);

		result.tokenAccount = wrappedSolAccount.publicKey;

		return result;
	}

	/**
	 * Creates the Clearing House User account for a user, and deposits some initial collateral
	 * @param userId
	 * @param name
	 * @param amount
	 * @param userTokenAccount
	 * @param fromUserId
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		authority: PublicKey,
		bank: BankConfig,
		userId = 0,
		name = DEFAULT_USER_NAME,
		fromUserId?: number
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name);

		const additionalSigners: Array<Signer> = [];

		const bankIndex = bank.bankIndex;

		let userTokenAccount: PublicKey;

		const isSolBank = bank.mint.equals(WRAPPED_SOL_MINT);

		const tx = new Transaction();

		if (isSolBank) {
			const { startIxs, tokenAccount, signers } = await this.handleSolDeposit(
				authority,
				bank,
				amount
			);

			startIxs.forEach((ix) => {
				tx.add(ix);
			});

			signers.forEach((signer) => additionalSigners.push(signer));

			userTokenAccount = tokenAccount;
		} else {
			userTokenAccount = await getTokenAddress(
				bank.mint.toString(),
				authority.toString()
			);
		}

		const depositCollateralIx =
			fromUserId != null
				? await this.getTransferDepositIx(amount, bankIndex, fromUserId, userId)
				: await this.getDepositInstruction(
						amount,
						bankIndex,
						userTokenAccount,
						userId,
						false,
						false
				  );

		tx.add(initializeUserAccountIx).add(depositCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (isSolBank) {
			tx.add(
				closeAccount({
					source: userTokenAccount,
					destination: authority,
					owner: authority,
				})
			);
		}

		const { txSig } = await this.txSender.send(
			tx,
			additionalSigners,
			this.opts
		);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		userId = 0,
		name = DEFAULT_USER_NAME,
		bankIndex: BN,
		tokenFaucet: TokenFaucet,
		amount: BN
	): Promise<[TransactionSignature, PublicKey]> {
		const [associateTokenPublicKey, createAssociatedAccountIx, mintToIx] =
			await tokenFaucet.createAssociatedTokenAccountAndMintToInstructions(
				this.wallet.publicKey,
				amount
			);

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name);

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			bankIndex,
			associateTokenPublicKey,
			userId,
			false,
			false
		);

		const tx = new Transaction()
			.add(createAssociatedAccountIx)
			.add(mintToIx)
			.add(initializeUserAccountIx)
			.add(depositCollateralIx);

		const txSig = await this.program.provider.sendAndConfirm(tx, []);

		return [txSig, userAccountPublicKey];
	}

	public async withdraw(
		amount: BN,
		bank: BankConfig,
		authority: PublicKey,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const isSolBank = bank.mint.equals(WRAPPED_SOL_MINT);

		if (isSolBank) {
			const tx = new Transaction();

			const solWithdrawalIxs = await this.getSolWithdrawalIxs(
				authority,
				bank,
				amount
			);

			solWithdrawalIxs.ixs.forEach((ix) => tx.add(ix));

			const { txSig } = await this.txSender.send(
				tx,
				solWithdrawalIxs.signers,
				this.opts
			);

			return txSig;
		} else {
			const userTokenAccount = await getTokenAddress(
				bank.mint.toString(),
				authority.toString()
			);

			const { txSig } = await this.txSender.send(
				wrapInTx(
					await this.getWithdrawIx(
						amount,
						bank.bankIndex,
						userTokenAccount,
						reduceOnly
					)
				),
				[],
				this.opts
			);
			return txSig;
		}
	}

	public async getWithdrawIx(
		amount: BN,
		bankIndex: BN,
		userTokenAccount: PublicKey,
		reduceOnly = false
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			writableBankIndex: bankIndex,
		});

		const bank = this.getBankAccount(bankIndex);

		return await this.program.instruction.withdraw(
			bankIndex,
			amount,
			reduceOnly,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					bank: bank.pubkey,
					bankVault: bank.vault,
					bankVaultAuthority: bank.vaultAuthority,
					user: userAccountPublicKey,
					userTokenAccount: userTokenAccount,
					authority: this.wallet.publicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	public async transferDeposit(
		amount: BN,
		bankIndex: BN,
		fromUserId: number,
		toUserId: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getTransferDepositIx(amount, bankIndex, fromUserId, toUserId)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTransferDepositIx(
		amount: BN,
		bankIndex: BN,
		fromUserId: number,
		toUserId: number
	): Promise<TransactionInstruction> {
		const fromUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			fromUserId
		);
		const toUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			toUserId
		);

		const remainingAccounts = this.getRemainingAccounts({
			writableBankIndex: bankIndex,
		});

		return await this.program.instruction.transferDeposit(bankIndex, amount, {
			accounts: {
				authority: this.wallet.publicKey,
				fromUser,
				toUser,
				state: await this.getStatePublicKey(),
			},
			remainingAccounts,
		});
	}

	public async updateBankCumulativeInterest(
		bankIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.updateBankCumulativeInterestIx(bankIndex)),
			[],
			this.opts
		);
		return txSig;
	}

	public async updateBankCumulativeInterestIx(
		bankIndex: BN
	): Promise<TransactionInstruction> {
		const bank = this.getBankAccount(bankIndex);
		return await this.program.instruction.updateBankCumulativeInterest({
			accounts: {
				bank: bank.pubkey,
			},
		});
	}

	public async openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN
	): Promise<TransactionSignature> {
		return await this.placeAndTake({
			orderType: OrderType.MARKET,
			marketIndex,
			direction,
			baseAssetAmount: amount,
			price: limitPrice,
		});
	}

	public async placeOrder(
		orderParams: OptionalOrderParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(await this.getPlaceOrderIx(orderParams)),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);
		return txSig;
	}

	getOrderParams(optionalOrderParams: OptionalOrderParams): OrderParams {
		return Object.assign({}, DefaultOrderParams, optionalOrderParams);
	}

	public async getPlaceOrderIx(
		orderParams: OptionalOrderParams
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams);
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			writableMarketIndex: orderParams.marketIndex,
		});

		return await this.program.instruction.placeOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateAMMs(marketIndexes: BN[]): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getUpdateAMMsIx(marketIndexes)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateAMMsIx(
		marketIndexes: BN[]
	): Promise<TransactionInstruction> {
		for (let i = marketIndexes.length; i < 5; i++) {
			marketIndexes.push(new BN(100));
		}
		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		for (const marketIndex of marketIndexes) {
			if (!marketIndex.eq(new BN(100))) {
				const market = this.getMarketAccount(marketIndex);
				marketAccountInfos.push({
					pubkey: market.pubkey,
					isWritable: true,
					isSigner: false,
				});
				oracleAccountInfos.push({
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}
		const remainingAccounts = oracleAccountInfos.concat(marketAccountInfos);

		return await this.program.instruction.updateAmms(marketIndexes, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async cancelOrder(orderId?: BN): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getCancelOrderIx(orderId)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderIx(orderId?: BN): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({});

		return await this.program.instruction.cancelOrder(orderId ?? null, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async cancelOrderByUserId(
		userOrderId: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getCancelOrderByUserIdIx(userOrderId)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderByUserIdIx(
		userOrderId: number
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const order = this.getOrderByUserId(userOrderId);
		const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;

		const remainingAccounts = this.getRemainingAccounts({});

		return await this.program.instruction.cancelOrderByUserId(userOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				oracle,
			},
			remainingAccounts,
		});
	}

	public async fillOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Order,
		makerInfo?: MakerInfo
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getFillOrderIx(userAccountPublicKey, user, order, makerInfo)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order,
		makerInfo?: MakerInfo
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		const marketIndex = order.marketIndex;
		const marketAccount = this.getMarketAccount(marketIndex);

		const oracleAccountMap = new Map<string, AccountMeta>();
		const bankAccountMap = new Map<number, AccountMeta>();
		const marketAccountMap = new Map<number, AccountMeta>();

		marketAccountMap.set(marketIndex.toNumber(), {
			pubkey: marketAccount.pubkey,
			isWritable: true,
			isSigner: false,
		});
		oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
			pubkey: marketAccount.amm.oracle,
			isWritable: false,
			isSigner: false,
		});

		for (const bankBalance of userAccount.bankBalances) {
			if (!bankBalance.balance.eq(ZERO)) {
				const bankAccount = this.getBankAccount(bankBalance.bankIndex);
				bankAccountMap.set(bankBalance.bankIndex.toNumber(), {
					pubkey: bankAccount.pubkey,
					isSigner: false,
					isWritable: true,
				});

				if (!bankAccount.oracle.equals(PublicKey.default)) {
					oracleAccountMap.set(bankAccount.oracle.toString(), {
						pubkey: bankAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		for (const position of userAccount.positions) {
			if (
				!positionIsAvailable(position) &&
				!position.marketIndex.eq(order.marketIndex)
			) {
				const market = this.getMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
					pubkey: market.pubkey,
					isWritable: true,
					isSigner: false,
				});
				oracleAccountMap.set(market.amm.oracle.toString(), {
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...bankAccountMap.values(),
			...marketAccountMap.values(),
		];

		if (makerInfo) {
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isWritable: true,
				isSigner: false,
			});
		}

		const orderId = order.orderId;
		const makerOrderId = makerInfo ? makerInfo.order.orderId : null;

		return await this.program.instruction.fillOrder(orderId, makerOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async triggerOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order: Order
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getTriggerOrderIx(userAccountPublicKey, user, order)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTriggerOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		const marketIndex = order.marketIndex;
		const marketAccount = this.getMarketAccount(marketIndex);

		const oracleAccountMap = new Map<string, AccountMeta>();
		const bankAccountMap = new Map<number, AccountMeta>();
		const marketAccountMap = new Map<number, AccountMeta>();

		marketAccountMap.set(marketIndex.toNumber(), {
			pubkey: marketAccount.pubkey,
			isWritable: true,
			isSigner: false,
		});
		oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
			pubkey: marketAccount.amm.oracle,
			isWritable: false,
			isSigner: false,
		});

		for (const bankBalance of userAccount.bankBalances) {
			if (!bankBalance.balance.eq(ZERO)) {
				const bankAccount = this.getBankAccount(bankBalance.bankIndex);
				bankAccountMap.set(bankBalance.bankIndex.toNumber(), {
					pubkey: bankAccount.pubkey,
					isSigner: false,
					isWritable: true,
				});

				if (!bankAccount.oracle.equals(PublicKey.default)) {
					oracleAccountMap.set(bankAccount.oracle.toString(), {
						pubkey: bankAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		for (const position of userAccount.positions) {
			if (
				!positionIsAvailable(position) &&
				!position.marketIndex.eq(order.marketIndex)
			) {
				const market = this.getMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
					pubkey: market.pubkey,
					isWritable: true,
					isSigner: false,
				});
				oracleAccountMap.set(market.amm.oracle.toString(), {
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...bankAccountMap.values(),
			...marketAccountMap.values(),
		];

		const orderId = order.orderId;
		return await this.program.instruction.triggerOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async placeAndTake(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(await this.getPlaceAndTakeIx(orderParams, makerInfo)),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);
		return txSig;
	}

	public async getPlaceAndTakeIx(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams);
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			writableMarketIndex: orderParams.marketIndex,
			writableBankIndex: QUOTE_ASSET_BANK_INDEX,
		});

		let makerOrderId = null;
		if (makerInfo) {
			makerOrderId = makerInfo.order.orderId;
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isSigner: false,
				isWritable: true,
			});
		}

		return await this.program.instruction.placeAndTake(
			orderParams,
			makerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async placeAndMake(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(await this.getPlaceAndMakeIx(orderParams, takerInfo)),
			[],
			this.opts
		);

		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);

		return txSig;
	}

	public async getPlaceAndMakeIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams);
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			writableMarketIndex: orderParams.marketIndex,
			writableBankIndex: QUOTE_ASSET_BANK_INDEX,
		});

		const takerOrderId = takerInfo!.order!.orderId;
		remainingAccounts.push({
			pubkey: takerInfo.taker,
			isSigner: false,
			isWritable: true,
		});

		return await this.program.instruction.placeAndMake(
			orderParams,
			takerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					taker: takerInfo.taker,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	/**
	 * Close an entire position. If you want to reduce a position, use the {@link openPosition} method in the opposite direction of the current position.
	 * @param marketIndex
	 * @returns
	 */
	public async closePosition(marketIndex: BN): Promise<TransactionSignature> {
		const userPosition = this.getUser().getUserPosition(marketIndex);
		if (!userPosition) {
			throw Error(`No position in market ${marketIndex.toString()}`);
		}

		return await this.placeAndTake({
			orderType: OrderType.MARKET,
			marketIndex,
			direction: findDirectionToClose(userPosition),
			baseAssetAmount: userPosition.baseAssetAmount,
			reduceOnly: true,
		});
	}

	public async settlePNLs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndex: BN
	): Promise<TransactionSignature> {
		const ixs = [];
		for (const { settleeUserAccountPublicKey, settleeUserAccount } of users) {
			ixs.push(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
				)
			);
		}

		const tx = new Transaction().add(...ixs);

		const { txSig } = await this.txSender.send(tx, [], this.opts);
		return txSig;
	}

	public async settlePNL(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settlePNLIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const marketAccountMap = new Map<number, AccountMeta>();
		const oracleAccountMap = new Map<string, AccountMeta>();
		const bankAccountMap = new Map<number, AccountMeta>();
		for (const position of settleeUserAccount.positions) {
			if (!positionIsAvailable(position)) {
				const market = this.getMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
					pubkey: market.pubkey,
					isWritable: true, // TODO
					isSigner: false,
				});
				oracleAccountMap.set(market.amm.oracle.toString(), {
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		for (const userBankBalance of settleeUserAccount.bankBalances) {
			if (!userBankBalance.balance.eq(QUOTE_ASSET_BANK_INDEX)) {
				const bankAccount = this.getBankAccount(userBankBalance.bankIndex);
				bankAccountMap.set(userBankBalance.bankIndex.toNumber(), {
					pubkey: bankAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				if (!bankAccount.bankIndex.eq(ZERO)) {
					oracleAccountMap.set(bankAccount.oracle.toString(), {
						pubkey: bankAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		const marketAccount = this.getMarketAccount(marketIndex.toNumber());
		marketAccountMap.set(marketIndex.toNumber(), {
			pubkey: marketAccount.pubkey,
			isSigner: false,
			isWritable: true,
		});
		oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
			pubkey: marketAccount.amm.oracle,
			isSigner: false,
			isWritable: false,
		});

		bankAccountMap.set(QUOTE_ASSET_BANK_INDEX.toNumber(), {
			pubkey: this.getBankAccount(QUOTE_ASSET_BANK_INDEX).pubkey,
			isSigner: false,
			isWritable: true,
		});

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...bankAccountMap.values(),
			...marketAccountMap.values(),
		];

		return await this.program.instruction.settlePnl(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: settleeUserAccountPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async liquidatePerp(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN,
		maxBaseAssetAmount: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidatePerpIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					maxBaseAssetAmount
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLiquidatePerpIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN,
		maxBaseAssetAmount: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsForLiquidation({
			writableMarketIndex: marketIndex,
			userAccount,
		});

		return await this.program.instruction.liquidatePerp(
			marketIndex,
			maxBaseAssetAmount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					liquidator: liquidatorPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidateBorrow(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetBankIndex: BN,
		liabilityBankIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidateBorrowIx(
					userAccountPublicKey,
					userAccount,
					assetBankIndex,
					liabilityBankIndex,
					maxLiabilityTransfer
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLiquidateBorrowIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetBankIndex: BN,
		liabilityBankIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsForLiquidation({
			userAccount,
			writableBankIndexes: [liabilityBankIndex, assetBankIndex],
		});

		return await this.program.instruction.liquidateBorrow(
			assetBankIndex,
			liabilityBankIndex,
			maxLiabilityTransfer,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					liquidator: liquidatorPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidateBorrowForPerpPnl(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		liabilityBankIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidateBorrowForPerpPnlIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					liabilityBankIndex,
					maxLiabilityTransfer
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLiquidateBorrowForPerpPnlIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		liabilityBankIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsForLiquidation({
			userAccount,
			writableMarketIndex: perpMarketIndex,
			writableBankIndexes: [liabilityBankIndex],
		});

		return await this.program.instruction.liquidateBorrowForPerpPnl(
			perpMarketIndex,
			liabilityBankIndex,
			maxLiabilityTransfer,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					liquidator: liquidatorPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidatePerpPnlForDeposit(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		assetBankIndex: BN,
		maxPnlTransfer: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidatePerpPnlForDepositIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					assetBankIndex,
					maxPnlTransfer
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLiquidatePerpPnlForDepositIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		assetBankIndex: BN,
		maxPnlTransfer: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsForLiquidation({
			userAccount,
			writableMarketIndex: perpMarketIndex,
			writableBankIndexes: [assetBankIndex],
		});

		return await this.program.instruction.liquidatePerpPnlForDeposit(
			perpMarketIndex,
			assetBankIndex,
			maxPnlTransfer,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					liquidator: liquidatorPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	getRemainingAccountsForLiquidation(params: {
		userAccount: UserAccount;
		writableMarketIndex?: BN;
		writableBankIndexes?: BN[];
	}): AccountMeta[] {
		const liquidateeUserAccount = params.userAccount;

		const oracleAccountMap = new Map<string, AccountMeta>();
		const bankAccountMap = new Map<number, AccountMeta>();
		const marketAccountMap = new Map<number, AccountMeta>();
		for (const bankBalance of liquidateeUserAccount.bankBalances) {
			if (!bankBalance.balance.eq(ZERO)) {
				const bankAccount = this.getBankAccount(bankBalance.bankIndex);
				bankAccountMap.set(bankBalance.bankIndex.toNumber(), {
					pubkey: bankAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});

				if (!bankAccount.oracle.equals(PublicKey.default)) {
					oracleAccountMap.set(bankAccount.oracle.toString(), {
						pubkey: bankAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}
		for (const position of liquidateeUserAccount.positions) {
			if (!positionIsAvailable(position)) {
				const market = this.getMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
					pubkey: market.pubkey,
					isWritable: false,
					isSigner: false,
				});
				oracleAccountMap.set(market.amm.oracle.toString(), {
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		const userAccountAndSlot = this.getUserAccountAndSlot();
		if (!userAccountAndSlot) {
			throw Error(
				'No user account found. Most likely user account does not exist or failed to fetch account'
			);
		}
		const { data: userAccount, slot: lastUserPositionsSlot } =
			userAccountAndSlot;

		for (const [marketIndexNum, slot] of this.marketLastSlotCache.entries()) {
			// if cache has more recent slot than user positions account slot, add market to remaining accounts
			// otherwise remove from slot
			if (slot > lastUserPositionsSlot) {
				const marketAccount = this.getMarketAccount(marketIndexNum);
				marketAccountMap.set(marketIndexNum, {
					pubkey: marketAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
					pubkey: marketAccount.amm.oracle,
					isSigner: false,
					isWritable: false,
				});
			} else {
				this.marketLastSlotCache.delete(marketIndexNum);
			}
		}
		for (const bankBalance of userAccount.bankBalances) {
			if (!bankBalance.balance.eq(ZERO)) {
				const bankAccount = this.getBankAccount(bankBalance.bankIndex);
				bankAccountMap.set(bankBalance.bankIndex.toNumber(), {
					pubkey: bankAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});

				if (!bankAccount.oracle.equals(PublicKey.default)) {
					oracleAccountMap.set(bankAccount.oracle.toString(), {
						pubkey: bankAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}
		for (const position of userAccount.positions) {
			if (!positionIsAvailable(position)) {
				const market = this.getMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
					pubkey: market.pubkey,
					isWritable: false,
					isSigner: false,
				});
				oracleAccountMap.set(market.amm.oracle.toString(), {
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		if (params.writableMarketIndex) {
			const market = this.getMarketAccount(params.writableMarketIndex);
			marketAccountMap.set(market.marketIndex.toNumber(), {
				pubkey: market.pubkey,
				isSigner: false,
				isWritable: true,
			});
			oracleAccountMap.set(market.amm.oracle.toString(), {
				pubkey: market.amm.oracle,
				isSigner: false,
				isWritable: false,
			});
		}

		if (params.writableBankIndexes) {
			for (const writableBankIndex of params.writableBankIndexes) {
				const bank = this.getBankAccount(writableBankIndex);
				bankAccountMap.set(bank.bankIndex.toNumber(), {
					pubkey: bank.pubkey,
					isSigner: false,
					isWritable: true,
				});
				if (!bank.oracle.equals(PublicKey.default)) {
					oracleAccountMap.set(bank.oracle.toString(), {
						pubkey: bank.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		return [
			...oracleAccountMap.values(),
			...bankAccountMap.values(),
			...marketAccountMap.values(),
		];
	}

	public async updateFundingRate(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getUpdateFundingRateIx(oracle, marketIndex)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateFundingRateIx(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFundingRate(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
				oracle: oracle,
			},
		});
	}

	public async settleFundingPayment(
		userAccount: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getSettleFundingPaymentIx(userAccount)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleFundingPaymentIx(
		userAccount: PublicKey
	): Promise<TransactionInstruction> {
		const user = (await this.program.account.user.fetch(
			userAccount
		)) as UserAccount;

		const userPositions = user.positions;

		const remainingAccounts = [];
		for (const position of userPositions) {
			if (!positionIsAvailable(position)) {
				const marketPublicKey = await getMarketPublicKey(
					this.program.programId,
					position.marketIndex
				);
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		return await this.program.instruction.settleFundingPayment({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccount,
			},
			remainingAccounts,
		});
	}

	public triggerEvent(eventName: keyof ClearingHouseAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}

	public getOracleDataForMarket(marketIndex: BN): OraclePriceData {
		const oracleKey = this.getMarketAccount(marketIndex).amm.oracle;
		const oracleData = this.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
}
