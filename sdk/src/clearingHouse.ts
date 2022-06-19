import { AnchorProvider, BN, Idl, Program } from '@project-serum/anchor';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
	StateAccount,
	IWallet,
	PositionDirection,
	UserAccount,
	MarketAccount,
	OrderStateAccount,
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
	getOrderStateAccountPublicKey,
	getUserAccountPublicKey,
} from './addresses/pda';
import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	AccountAndSlot,
} from './accounts/types';
import { TxSender } from './tx/types';
import { wrapInTx } from './tx/utils';
import {
	getClearingHouse,
	getWebSocketClearingHouseConfig,
} from './factory/clearingHouse';
import { QUOTE_ASSET_BANK_INDEX, ZERO } from './constants/numericConstants';
import { positionIsAvailable } from './math/position';
import { getTokenAmount } from './math/bankBalance';
import { DEFAULT_USER_NAME, encodeName } from './userName';

/**
 * # ClearingHouse
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 *
 * The default way to construct a ClearingHouse instance is using the {@link from} method. This will create an instance using the static {@link WebSocketClearingHouseAccountSubscriber}, which will use a websocket for each state account subscription.
 * Alternatively, if you want to implement your own method of subscribing to the state accounts on the blockchain, you can implement a {@link ClearingHouseAccountSubscriber} and use it in the {@link ClearingHouse.constructor}
 */
export class ClearingHouse {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: AnchorProvider;
	opts?: ConfirmOptions;
	userId: number;
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

	/**
	 * @deprecated You should use the getClearingHouse factory method instead
	 * @param connection
	 * @param wallet
	 * @param clearingHouseProgramId
	 * @param opts
	 * @param userId
	 * @returns
	 */
	public static from(
		connection: Connection,
		wallet: IWallet,
		clearingHouseProgramId: PublicKey,
		opts: ConfirmOptions = AnchorProvider.defaultOptions(),
		userId = 0
	): ClearingHouse {
		const config = getWebSocketClearingHouseConfig(
			connection,
			wallet,
			clearingHouseProgramId,
			opts,
			undefined,
			userId
		);
		return getClearingHouse(config);
	}

	public constructor(
		connection: Connection,
		wallet: IWallet,
		program: Program,
		accountSubscriber: ClearingHouseAccountSubscriber,
		txSender: TxSender,
		opts: ConfirmOptions,
		userId = 0
	) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.program = program;
		this.accountSubscriber = accountSubscriber;
		this.eventEmitter = this.accountSubscriber.eventEmitter;
		this.txSender = txSender;
		this.userId = userId;
	}

	/**
	 *
	 * @returns Promise<boolean> : SubscriptionSuccess
	 */
	public async subscribe(): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe();
		return this.isSubscribed;
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
		return this.accountSubscriber.getStateAccountAndSlot().account;
	}

	public getMarketAccount(marketIndex: BN | number): MarketAccount {
		marketIndex = marketIndex instanceof BN ? marketIndex : new BN(marketIndex);
		return this.accountSubscriber.getMarketAccountAndSlot(marketIndex).account;
	}

	public getBankAccount(bankIndex: BN | number): BankAccount | undefined {
		bankIndex = bankIndex instanceof BN ? bankIndex : new BN(bankIndex);
		return this.accountSubscriber.getBankAccountAndSlot(bankIndex).account;
	}

	public getQuoteAssetBankAccount(): BankAccount {
		return this.accountSubscriber.getBankAccountAndSlot(QUOTE_ASSET_BANK_INDEX)
			.account;
	}

	orderStatePublicKey?: PublicKey;
	public async getOrderStatePublicKey(): Promise<PublicKey> {
		if (this.orderStatePublicKey) {
			return this.orderStatePublicKey;
		}
		this.orderStatePublicKey = await getOrderStateAccountPublicKey(
			this.program.programId
		);
		return this.orderStatePublicKey;
	}

	public getOrderStateAccount(): OrderStateAccount {
		return this.accountSubscriber.getOrderStateAccountAndSlot().account;
	}

	/**
	 * Update the wallet to use for clearing house transactions and linked user account
	 * @param newWallet
	 */
	public async updateWallet(newWallet: IWallet, userId = 0): Promise<void> {
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
		this.userAccountPublicKey = undefined;
		this.userId = userId;
		await this.accountSubscriber.updateAuthority(newWallet.publicKey);
	}

	public async updateUserId(userId: number): Promise<void> {
		this.userAccountPublicKey = undefined;
		this.userId = userId;
		await this.accountSubscriber.updateUserId(userId);
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
			this.wallet.publicKey,
			this.userId
		);
		return this.userAccountPublicKey;
	}

	public getUserAccount(): UserAccount | undefined {
		return this.accountSubscriber.getUserAccountAndSlot().account;
	}

	public getUserAccountAndSlot(): AccountAndSlot<UserAccount> | undefined {
		return this.accountSubscriber.getUserAccountAndSlot();
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
		const { account: userAccount, slot: lastUserPositionsSlot } =
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
		userId = 0,
		name = DEFAULT_USER_NAME
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name);

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			new BN(0),
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
		toUserId: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getTransferDepositIx(amount, bankIndex, toUserId)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTransferDepositIx(
		amount: BN,
		bankIndex: BN,
		toUserId: number
	): Promise<TransactionInstruction> {
		const fromUser = await this.getUserAccountPublicKey();
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
		const { txSig, slot } = await this.txSender.send(
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
		this.marketLastSlotCache.set(marketIndex.toNumber(), slot);
		return txSig;
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

		if (limitPrice == undefined) {
			limitPrice = new BN(0); // no limit
		}

		const remainingAccounts = this.getRemainingAccounts({
			writableBankIndex: QUOTE_ASSET_BANK_INDEX,
			writableMarketIndex: marketIndex,
		});

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};
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

		const priceOracle = this.getMarketAccount(marketIndex).amm.oracle;
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
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
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
				orderState: await this.getOrderStatePublicKey(),
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
				orderState: await this.getOrderStatePublicKey(),
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
				orderState: await this.getOrderStatePublicKey(),
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
				orderState: await this.getOrderStatePublicKey(),
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
				orderState: await this.getOrderStatePublicKey(),
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
					orderState: await this.getOrderStatePublicKey(),
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
				orderState: await this.getOrderStatePublicKey(),
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
				orderState: await this.getOrderStatePublicKey(),
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
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getClosePositionIx(marketIndex, discountToken, referrer)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getClosePositionIx(
		marketIndex: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const priceOracle = this.getMarketAccount(marketIndex).amm.oracle;

		const remainingAccounts = this.getRemainingAccounts({
			writableMarketIndex: marketIndex,
			writableBankIndex: QUOTE_ASSET_BANK_INDEX,
		});

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};

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

		return await this.program.instruction.closePosition(
			marketIndex,
			optionalAccounts,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async closeAllPositions(
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const ixs: TransactionInstruction[] = [];
		for (const userPosition of this.getUserAccount().positions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			ixs.push(
				await this.getClosePositionIx(
					userPosition.marketIndex,
					discountToken,
					referrer
				)
			);
		}

		const tx = new Transaction().add(...ixs);

		const { txSig } = await this.txSender.send(tx, [], this.opts);
		return txSig;
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
		userAccount: PublicKey,
		userPositionsAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getSettleFundingPaymentIx(
					userAccount,
					userPositionsAccountPublicKey
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleFundingPaymentIx(
		userAccount: PublicKey,
		userPositionsAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const liquidateePositions: any =
			await this.program.account.userPositions.fetch(
				userPositionsAccountPublicKey
			);

		const remainingAccounts = [];
		for (const position of liquidateePositions.positions) {
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
				userPositions: userPositionsAccountPublicKey,
			},
			remainingAccounts,
		});
	}

	public triggerEvent(eventName: keyof ClearingHouseAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}
}
