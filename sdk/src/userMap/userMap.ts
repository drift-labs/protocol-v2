import {
	User,
	DriftClient,
	UserAccount,
	OrderRecord,
	UserSubscriptionConfig,
	WrappedEvent,
	DepositRecord,
	FundingPaymentRecord,
	LiquidationRecord,
	OrderActionRecord,
	SettlePnlRecord,
	NewUserRecord,
	LPRecord,
	StateAccount,
	DLOB,
} from '..';

import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';

export interface UserMapInterface {
	subscribe(): Promise<void>;
	unsubscribe(): Promise<void>;
	addPubkey(userAccountPublicKey: PublicKey): Promise<void>;
	has(key: string): boolean;
	get(key: string): User | undefined;
	mustGet(key: string): Promise<User>;
	getUserAuthority(key: string): PublicKey | undefined;
	updateWithOrderRecord(record: OrderRecord): Promise<void>;
	values(): IterableIterator<User>;
}

export class UserMap implements UserMapInterface {
	private userMap = new Map<string, User>();
	private driftClient: DriftClient;
	private accountSubscription: UserSubscriptionConfig;
	private includeIdle: boolean;
	private lastNumberOfSubAccounts;
	private syncCallback = async (state: StateAccount) => {
		if (state.numberOfSubAccounts !== this.lastNumberOfSubAccounts) {
			await this.sync();
			this.lastNumberOfSubAccounts = state.numberOfSubAccounts;
		}
	};

	constructor(
		driftClient: DriftClient,
		accountSubscription: UserSubscriptionConfig,
		includeIdle = true
	) {
		this.driftClient = driftClient;
		this.accountSubscription = accountSubscription;
		this.includeIdle = includeIdle;
	}

	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.driftClient.subscribe();
		this.lastNumberOfSubAccounts =
			this.driftClient.getStateAccount().numberOfSubAccounts;
		this.driftClient.eventEmitter.on('stateAccountUpdate', this.syncCallback);

		await this.sync();
	}

	public async addPubkey(
		userAccountPublicKey: PublicKey,
		userAccount?: UserAccount
	) {
		const user = new User({
			driftClient: this.driftClient,
			userAccountPublicKey,
			accountSubscription: this.accountSubscription,
		});
		await user.subscribe(userAccount);
		this.userMap.set(userAccountPublicKey.toString(), user);
	}

	public has(key: string): boolean {
		return this.userMap.has(key);
	}

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns user User | undefined
	 */
	public get(key: string): User | undefined {
		return this.userMap.get(key);
	}

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, new one is created
	 * @param key userAccountPublicKey to get User for
	 * @returns  User
	 */
	public async mustGet(key: string): Promise<User> {
		if (!this.has(key)) {
			await this.addPubkey(new PublicKey(key));
		}
		const user = this.userMap.get(key);
		return user;
	}

	/**
	 * gets the Authority for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns authority PublicKey | undefined
	 */
	public getUserAuthority(key: string): PublicKey | undefined {
		const chUser = this.userMap.get(key);
		if (!chUser) {
			return undefined;
		}
		return chUser.getUserAccount().authority;
	}

	/**
	 * implements the {@link DLOBSource} interface
	 * create a DLOB from all the subscribed users
	 * @param slot
	 */
	public async getDLOB(slot: number): Promise<DLOB> {
		const dlob = new DLOB();
		await dlob.initFromUserMap(this, slot);
		return dlob;
	}

	public async updateWithOrderRecord(record: OrderRecord) {
		if (!this.has(record.user.toString())) {
			await this.addPubkey(record.user);
		}
	}

	public async updateWithEventRecord(record: WrappedEvent<any>) {
		if (record.eventType === 'DepositRecord') {
			const depositRecord = record as DepositRecord;
			await this.mustGet(depositRecord.user.toString());
		} else if (record.eventType === 'FundingPaymentRecord') {
			const fundingPaymentRecord = record as FundingPaymentRecord;
			await this.mustGet(fundingPaymentRecord.user.toString());
		} else if (record.eventType === 'LiquidationRecord') {
			const liqRecord = record as LiquidationRecord;

			await this.mustGet(liqRecord.user.toString());
			await this.mustGet(liqRecord.liquidator.toString());
		} else if (record.eventType === 'OrderRecord') {
			const orderRecord = record as OrderRecord;
			await this.updateWithOrderRecord(orderRecord);
		} else if (record.eventType === 'OrderActionRecord') {
			const actionRecord = record as OrderActionRecord;

			if (actionRecord.taker) {
				await this.mustGet(actionRecord.taker.toString());
			}
			if (actionRecord.maker) {
				await this.mustGet(actionRecord.maker.toString());
			}
		} else if (record.eventType === 'SettlePnlRecord') {
			const settlePnlRecord = record as SettlePnlRecord;
			await this.mustGet(settlePnlRecord.user.toString());
		} else if (record.eventType === 'NewUserRecord') {
			const newUserRecord = record as NewUserRecord;
			await this.mustGet(newUserRecord.user.toString());
		} else if (record.eventType === 'LPRecord') {
			const lpRecord = record as LPRecord;
			await this.mustGet(lpRecord.user.toString());
		}
	}

	public values(): IterableIterator<User> {
		return this.userMap.values();
	}

	public size(): number {
		return this.userMap.size;
	}

	public async sync() {
		let filters = undefined;
		if (!this.includeIdle) {
			filters = [
				{
					memcmp: {
						offset: 4350,
						bytes: bs58.encode(Uint8Array.from([0])),
					},
				},
			];
		}

		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.connection.commitment,
				filters: [
					{
						memcmp: this.driftClient.program.coder.accounts.memcmp('User'),
					},
					...(Array.isArray(filters) ? filters : []),
				],
				encoding: 'base64',
				withContext: true,
			},
		];

		// @ts-ignore
		const rpcJSONResponse: any = await this.driftClient.connection._rpcRequest(
			'getProgramAccounts',
			rpcRequestArgs
		);

		const rpcResponseAndContext: RpcResponseAndContext<
			Array<{
				pubkey: PublicKey;
				account: {
					data: [string, string];
				};
			}>
		> = rpcJSONResponse.result;

		const slot = rpcResponseAndContext.context.slot;

		const programAccountBufferMap = new Map<string, Buffer>();
		for (const programAccount of rpcResponseAndContext.value) {
			programAccountBufferMap.set(
				programAccount.pubkey.toString(),
				// @ts-ignore
				Buffer.from(
					programAccount.account.data[0],
					programAccount.account.data[1]
				)
			);
		}

		for (const [key, buffer] of programAccountBufferMap.entries()) {
			if (!this.has(key)) {
				const userAccount =
					this.driftClient.program.account.user.coder.accounts.decode(
						'User',
						buffer
					);
				await this.addPubkey(new PublicKey(key), userAccount);
			}
		}

		for (const [key, user] of this.userMap.entries()) {
			if (!programAccountBufferMap.has(key)) {
				await user.unsubscribe();
				this.userMap.delete(key);
			} else {
				const userAccount =
					this.driftClient.program.account.user.coder.accounts.decode(
						'User',
						programAccountBufferMap.get(key)
					);
				user.accountSubscriber.updateData(userAccount, slot);
			}
		}
	}

	public async unsubscribe() {
		for (const [key, user] of this.userMap.entries()) {
			await user.unsubscribe();
			this.userMap.delete(key);
		}

		if (this.lastNumberOfSubAccounts) {
			this.driftClient.eventEmitter.removeListener(
				'stateAccountUpdate',
				this.syncCallback
			);
			this.lastNumberOfSubAccounts = undefined;
		}
	}
}
