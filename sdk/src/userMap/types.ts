import { User } from '../user';
import { DriftClient } from '../driftClient';
import { UserAccount, OrderRecord } from '../types';
import { WrappedEvent } from '../events/types';
import { UserSubscriptionConfig } from '../userConfig';
import { DataAndSlot } from '../accounts/types';
import { IDLOB, ProtectMakerParamsMap } from '../dlob/types';
import { PublicKey } from '@solana/web3.js';
import { UserAccountFilterCriteria as UserFilterCriteria } from './userMapConfig';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserEvents } from './events';

export interface IUserMap {
	driftClient: DriftClient;
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
	get(key: string): User | undefined;

	getWithSlot(key: string): DataAndSlot<User> | undefined;

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, new one is created
	 * @param key userAccountPublicKey to get User for
	 * @returns  User
	 */
	mustGet(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<User>;

	mustGetWithSlot(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<DataAndSlot<User>>;

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

	values(): IterableIterator<User>;

	valuesWithSlot(): IterableIterator<DataAndSlot<User>>;

	entries(): IterableIterator<[string, User]>;

	entriesWithSlot(): IterableIterator<[string, DataAndSlot<User>]>;

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
