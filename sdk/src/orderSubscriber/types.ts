import { Commitment, PublicKey } from '@solana/web3.js';
import { Order, UserAccount } from '../types';
import { IDriftClient } from '../driftClient/types';
import { GrpcConfigs } from '../accounts/types';
import { Buffer } from 'buffer';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { ProtectMakerParamsMap, IDLOB } from '../dlob/types';

export type OrderSubscriberConfig = {
	driftClient: IDriftClient;
	subscriptionConfig:
		| {
				type: 'polling';
				frequency: number;
				commitment?: Commitment;
		  }
		| {
				type: 'websocket';
				skipInitialLoad?: boolean;
				resubTimeoutMs?: number;
				logResubMessages?: boolean;
				resyncIntervalMs?: number;
				commitment?: Commitment;
		  }
		| {
				type: 'grpc';
				grpcConfigs: GrpcConfigs;
				skipInitialLoad?: boolean;
				resubTimeoutMs?: number;
				logResubMessages?: boolean;
				resyncIntervalMs?: number;
				commitment?: Commitment;
		  };
	fastDecode?: boolean;
	decodeData?: boolean;
	fetchAllNonIdleUsers?: boolean;
};

export interface OrderSubscriberEvents {
	orderCreated: (
		account: UserAccount,
		updatedOrders: Order[],
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
	userUpdated: (
		account: UserAccount,
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
	updateReceived: (
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
}

export interface IOrderSubscriber {
	driftClient: IDriftClient;
	usersAccounts: Map<string, { slot: number; userAccount: UserAccount }>;
	commitment: Commitment;
	eventEmitter: StrictEventEmitter<EventEmitter, OrderSubscriberEvents>;
	fetchPromise?: Promise<void>;
	fetchPromiseResolver: () => void;
	mostRecentSlot: number;
	decodeFn: (name: string, data: Buffer) => UserAccount;
	decodeData?: boolean;
	fetchAllNonIdleUsers?: boolean;

	subscribe(): Promise<void>;

	fetch(): Promise<void>;

	tryUpdateUserAccount(
		key: string,
		dataType: 'raw' | 'decoded' | 'buffer',
		data: string[] | UserAccount | Buffer,
		slot: number
	): void;

	getDLOB(
		slot: number,
		protectedMakerParamsMap?: ProtectMakerParamsMap
	): Promise<IDLOB>;

	getSlot(): number;

	addPubkey(userAccountPublicKey: PublicKey): Promise<void>;

	mustGetUserAccount(key: string): Promise<UserAccount>;

	unsubscribe(): Promise<void>;
}
