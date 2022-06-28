import { AnchorProvider, BN, Idl, Program } from '@project-serum/anchor';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
	StateAccount,
	IWallet,
	PositionDirection,
	UserAccount,
	MarketAccount,
	OrderParams,
	Order,
	BankAccount,
	UserBankBalance,
} from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';

import {
	Connection,
	PublicKey,
	TransactionSignature,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
	AccountMeta,
} from '@solana/web3.js';

import { MockUSDCFaucet } from './mockUSDCFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getClearingHouseStateAccountPublicKey,
	getMarketPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
} from './addresses/pda';
import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	DataAndSlot,
} from './accounts/types';
import { TxSender } from './tx/types';
import { wrapInTx } from './tx/utils';
import { QUOTE_ASSET_BANK_INDEX, ZERO } from './constants/numericConstants';
import { findDirectionToClose, positionIsAvailable } from './math/position';
import { getTokenAmount } from './math/bankBalance';
import { DEFAULT_USER_NAME, encodeName } from './userName';
import { OraclePriceData } from './oracles/types';
import { ClearingHouseConfig } from './clearingHouseConfig';
import { PollingClearingHouseAccountSubscriber } from './accounts/pollingClearingHouseAccountSubscriber';
import { WebSocketClearingHouseAccountSubscriber } from './accounts/webSocketClearingHouseAccountSubscriber';
import { RetryTxSender } from './tx/retryTxSender';
import { ClearingHouseUser } from './clearingHouseUser';
import { ClearingHouseUserAccountSubscriptionConfig } from './clearingHouseUserConfig';
import { getMarketOrderParams } from './orderParams';

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

		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingClearingHouseAccountSubscriber(
				this.program,
				config.accountSubscription.accountLoader,
				config.marketIndexes ?? [],
				config.bankIndexes ?? [],
				config.oracleInfos ?? []
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
					isWritable: false,
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
		bankIndex: BN,
		collateralAccountPublicKey: PublicKey,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			bankIndex,
			collateralAccountPublicKey,
			true,
			reduceOnly
		);

		const tx = new Transaction().add(depositCollateralIx);

		const { txSig } = await this.txSender.send(tx);
		return txSig;
	}

	async getDepositInstruction(
		amount: BN,
		bankIndex: BN,
		userTokenAccount: PublicKey,
		userInitialized = true,
		reduceOnly = false
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		let remainingAccounts = [];
		if (userInitialized) {
			remainingAccounts = this.getRemainingAccounts({
				writableBankIndex: bankIndex,
			});
		} else {
			remainingAccounts = [
				{
					pubkey: this.getQuoteAssetBankAccount().pubkey,
					isSigner: false,
					isWritable: true,
				},
			];
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

	/**
	 * Creates the Clearing House User account for a user, and deposits some initial collateral
	 * @param userId
	 * @param name
	 * @param amount
	 * @param userTokenAccount
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		bankIndex = new BN(0),
		userId = 0,
		name = DEFAULT_USER_NAME
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name);

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			bankIndex,
			userTokenAccount,
			false
		);

		const tx = new Transaction()
			.add(initializeUserAccountIx)
			.add(depositCollateralIx);

		const { txSig } = await this.txSender.send(tx, []);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		userId = 0,
		name = DEFAULT_USER_NAME,
		mockUSDCFaucet: MockUSDCFaucet,
		amount: BN
	): Promise<[TransactionSignature, PublicKey]> {
		const [associateTokenPublicKey, createAssociatedAccountIx, mintToIx] =
			await mockUSDCFaucet.createAssociatedTokenAccountAndMintToInstructions(
				this.wallet.publicKey,
				amount
			);

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name);

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			new BN(0),
			associateTokenPublicKey,
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
		bankIndex: BN,
		userTokenAccount: PublicKey,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getWithdrawIx(
					amount,
					bankIndex,
					userTokenAccount,
					reduceOnly
				)
			),
			[],
			this.opts
		);
		return txSig;
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
		limitPrice?: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.placeAndFillOrder(
			getMarketOrderParams(
				marketIndex,
				direction,
				amount,
				ZERO,
				false,
				limitPrice
			),
			discountToken,
			referrer
		);
	}

	public async placeOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getPlaceOrderIx(orderParams, discountToken, referrer)
			),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);
		return txSig;
	}

	public async getPlaceOrderIx(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const priceOracle = this.getMarketAccount(orderParams.marketIndex).amm
			.oracle;

		const remainingAccounts = this.getRemainingAccounts({
			writableMarketIndex: orderParams.marketIndex,
		});

		if (orderParams.optionalAccounts.discountToken) {
			if (!discountToken) {
				throw Error(
					'Optional accounts specified discount token but no discount token present'
				);
			}

			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}

		if (orderParams.optionalAccounts.referrer) {
			if (!referrer) {
				throw Error(
					'Optional accounts specified referrer but no referrer present'
				);
			}

			remainingAccounts.push({
				pubkey: referrer,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.placeOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				oracle: priceOracle,
			},
			remainingAccounts,
		});
	}

	public async expireOrders(
		userAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getExpireOrdersIx(userAccountPublicKey)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getExpireOrdersIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		return await this.program.instruction.expireOrders({
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
		});
	}

	public async cancelOrder(orderId: BN): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getCancelOrderIx(orderId)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderIx(orderId: BN): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const order = this.getOrder(orderId);
		const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;

		const remainingAccounts = this.getRemainingAccounts({});

		return await this.program.instruction.cancelOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				oracle,
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

	public async cancelAllOrders(
		bestEffort?: boolean
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getCancelAllOrdersIx(bestEffort)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelAllOrdersIx(
		bestEffort?: boolean
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({});

		for (const order of this.getUserAccount().orders) {
			const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;
			remainingAccounts.push({
				pubkey: oracle,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.cancelAllOrders(bestEffort, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async cancelOrdersByMarketAndSide(
		bestEffort?: boolean,
		marketIndexOnly?: BN,
		directionOnly?: PositionDirection
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getCancelOrdersByMarketAndSideIx(
					bestEffort,
					marketIndexOnly,
					directionOnly
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrdersByMarketAndSideIx(
		bestEffort?: boolean,
		marketIndexOnly?: BN,
		directionOnly?: PositionDirection
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({});

		for (const order of this.getUserAccount().orders) {
			const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;
			remainingAccounts.push({
				pubkey: oracle,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.cancelOrdersByMarketAndSide(
			bestEffort,
			marketIndexOnly,
			directionOnly,
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

	public async fillOrder(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getFillOrderIx(userAccountPublicKey, userAccount, order)
			),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(order.marketIndex.toNumber(), slot);
		return txSig;
	}

	public async getFillOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		const marketIndex = order.marketIndex;
		const marketAccount = this.getMarketAccount(marketIndex);
		const oracle = marketAccount.amm.oracle;

		const bankAccountInfos = [
			{
				pubkey: this.getQuoteAssetBankAccount().pubkey,
				isSigner: false,
				isWritable: true,
			},
		];
		const marketAccountInfos = [
			{
				pubkey: marketAccount.pubkey,
				isWritable: true,
				isSigner: false,
			},
		];
		const oracleAccountInfos = [
			{
				pubkey: marketAccount.amm.oracle,
				isWritable: false,
				isSigner: false,
			},
		];
		for (const position of userAccount.positions) {
			if (
				!positionIsAvailable(position) &&
				!position.marketIndex.eq(order.marketIndex)
			) {
				const market = this.getMarketAccount(position.marketIndex);
				const marketPublicKey = await getMarketPublicKey(
					this.program.programId,
					position.marketIndex
				);
				marketAccountInfos.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
				oracleAccountInfos.push({
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}
		const remainingAccounts = oracleAccountInfos.concat(
			bankAccountInfos.concat(marketAccountInfos)
		);

		if (!order.referrer.equals(PublicKey.default)) {
			remainingAccounts.push({
				pubkey: order.referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const orderId = order.orderId;
		return await this.program.instruction.fillOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				oracle: oracle,
			},
			remainingAccounts,
		});
	}

	public async placeAndFillOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getPlaceAndFillOrderIx(orderParams, discountToken, referrer)
			),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);
		return txSig;
	}

	public async getPlaceAndFillOrderIx(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const priceOracle = this.getMarketAccount(orderParams.marketIndex).amm
			.oracle;

		const remainingAccounts = this.getRemainingAccounts({
			writableMarketIndex: orderParams.marketIndex,
			writableBankIndex: QUOTE_ASSET_BANK_INDEX,
		});

		if (orderParams.optionalAccounts.discountToken) {
			if (!discountToken) {
				throw Error(
					'Optional accounts specified discount token but no discount token present'
				);
			}

			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}

		if (orderParams.optionalAccounts.referrer) {
			if (!referrer) {
				throw Error(
					'Optional accounts specified referrer but no referrer present'
				);
			}

			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		return await this.program.instruction.placeAndFillOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				oracle: priceOracle,
			},
			remainingAccounts,
		});
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
		const userPosition = this.getUser().getUserPosition(marketIndex);
		if (!userPosition) {
			throw Error(`No position in market ${marketIndex.toString()}`);
		}

		return await this.placeAndFillOrder(
			getMarketOrderParams(
				marketIndex,
				findDirectionToClose(userPosition),
				ZERO,
				userPosition.baseAssetAmount,
				true
			),
			discountToken,
			referrer
		);
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

		for (const userBankBalance of settleeUserAccount.bankBalances) {
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

	public async liquidate(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getLiquidateIx(liquidateeUserAccountPublicKey)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLiquidateIx(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const liquidateeUserAccount = (await this.program.account.user.fetch(
			liquidateeUserAccountPublicKey
		)) as UserAccount;

		const bankAccountInfos = [
			{
				pubkey: this.getQuoteAssetBankAccount().pubkey,
				isSigner: false,
				isWritable: true,
			},
		];
		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		for (const position of liquidateeUserAccount.positions) {
			if (!positionIsAvailable(position)) {
				const market = this.getMarketAccount(position.marketIndex);
				const marketPublicKey = await getMarketPublicKey(
					this.program.programId,
					position.marketIndex
				);
				marketAccountInfos.push({
					pubkey: marketPublicKey,
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
		const remainingAccounts = oracleAccountInfos.concat(
			bankAccountInfos.concat(marketAccountInfos)
		);

		const state = this.getStateAccount();
		const quoteAssetBankAccount = this.getQuoteAssetBankAccount();
		return await this.program.instruction.liquidate({
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: liquidateeUserAccountPublicKey,
				liquidator: userAccountPublicKey,
				bankVault: quoteAssetBankAccount.vault,
				bankVaultAuthority: quoteAssetBankAccount.vaultAuthority,
				insuranceVault: state.insuranceVault,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts: remainingAccounts,
		});
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
