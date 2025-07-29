import { UserSubscriptionConfig } from '../userConfig';
import { EventEmitter } from 'events';
import { StrictEventEmitter } from 'strict-event-emitter-types';
import { User } from '../user';
import { UserEvents } from './events';
import { OrderRecord, UserAccount } from '../types';
import { PublicKey } from '@solana/web3.js';
import { DataAndSlot } from '../accounts/types';
import { DriftClient } from '../driftClient';

export interface UserMapInterface {
	eventEmitter: StrictEventEmitter<EventEmitter, UserEvents>;
	driftClient: DriftClient;
	subscribe(): Promise<void>;
	unsubscribe(): Promise<void>;
	addPubkey(
		userAccountPublicKey: PublicKey,
		userAccount?: UserAccount,
		slot?: number,
		accountSubscription?: UserSubscriptionConfig
	): Promise<void>;
	has(key: string): boolean;
	get(key: string): User | undefined;
	getWithSlot(key: string): DataAndSlot<User> | undefined;
	mustGet(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<User>;
	mustGetWithSlot(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<DataAndSlot<User>>;
	getUserAuthority(key: string): PublicKey | undefined;
	updateWithOrderRecord(record: OrderRecord): Promise<void>;
	values(): IterableIterator<User>;
	valuesWithSlot(): IterableIterator<DataAndSlot<User>>;
	entries(): IterableIterator<[string, User]>;
	entriesWithSlot(): IterableIterator<[string, DataAndSlot<User>]>;
	sync(): Promise<void>;
	updateUserAccount(
		key: string,
		userAccount: UserAccount,
		slot: number
	): Promise<void>;
	updateLatestSlot(slot: number): void;
	getSlot(): number;
}
