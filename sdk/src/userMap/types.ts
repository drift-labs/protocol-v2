import { IDriftClient } from '../driftClient/types';
import { UserAccount, OrderRecord } from '../types';
import { WrappedEvent } from '../events/types';
import { DataAndSlot } from '../accounts/types';
import { IDLOB, ProtectMakerParamsMap } from '../dlob/types';
import { PublicKey } from '@solana/web3.js';
import { UserAccountFilterCriteria as UserFilterCriteria } from './userMapConfig';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserEvents } from './events';
import { IUser, UserSubscriptionConfig } from '../user/types';

export interface IUserMap {
	driftClient: IDriftClient;
	eventEmitter: StrictEventEmitter<EventEmitter, UserEvents>;

	subscribe(): Promise<void>;

	addPubkey(
		userAccountPublicKey: PublicKey,
		userAccount?: UserAccount,
		slot?: number,
		accountSubscription?: UserSubscriptionConfig
	): Promise<void>;

	has(key: string): boolean;

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns user User | undefined
	 */
	get(key: string): IUser | undefined;

	getWithSlot(key: string): DataAndSlot<IUser> | undefined;

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, new one is created
	 * @param key userAccountPublicKey to get User for
	 * @returns  User
	 */
	mustGet(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<IUser>;

	mustGetWithSlot(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<DataAndSlot<IUser>>;

	mustGetUserAccount(key: string): Promise<UserAccount>;

	/**
	 * gets the Authority for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns authority PublicKey | undefined
	 */
	getUserAuthority(key: string): PublicKey | undefined;

	/**
	 * implements the {@link DLOBSource} interface
	 * create a DLOB from all the subscribed users
	 * @param slot
	 */
	getDLOB(
		slot: number,
		protectedMakerParamsMap?: ProtectMakerParamsMap
	): Promise<IDLOB>;

	updateWithOrderRecord(record: OrderRecord): Promise<void>;

	updateWithEventRecord(record: WrappedEvent<any>): Promise<void>;

	values(): IterableIterator<IUser>;

	valuesWithSlot(): IterableIterator<DataAndSlot<IUser>>;

	entries(): IterableIterator<[string, IUser]>;

	entriesWithSlot(): IterableIterator<[string, DataAndSlot<IUser>]>;

	size(): number;

	/**
	 * Returns a unique list of authorities for all users in the UserMap that meet the filter criteria
	 * @param filterCriteria: Users must meet these criteria to be included
	 * @returns
	 */
	getUniqueAuthorities(filterCriteria?: UserFilterCriteria): PublicKey[];

	sync(): Promise<void>;

	unsubscribe(): Promise<void>;

	updateUserAccount(
		key: string,
		userAccount: UserAccount,
		slot: number
	): Promise<void>;

	updateLatestSlot(slot: number): void;

	getSlot(): number;
}
