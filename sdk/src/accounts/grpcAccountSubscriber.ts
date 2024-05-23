import {
	DataAndSlot,
	BufferAndSlot,
	AccountSubscriber,
	ResubOpts,
} from './types';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { AccountInfo, Commitment, Context, PublicKey } from '@solana/web3.js';
import { capitalize } from './utils';
import Client, {
	CommitmentLevel,
	SubscribeRequest,
	SubscribeRequestFilterAccountsFilter,
} from '@triton-one/yellowstone-grpc';
import { ChannelOptions } from '@grpc/grpc-js';

export class GrpcAccountSubscriber<T> implements AccountSubscriber<T> {
	dataAndSlot?: DataAndSlot<T>;
	bufferAndSlot?: BufferAndSlot;
	accountName: string;
	program: Program;
	client: Client;
	accountPublicKey: PublicKey;
	decodeBufferFn: (buffer: Buffer) => T;
	onChange: (data: T) => void;
	listenerId?: number;

	resubOpts?: ResubOpts;

	commitment?: Commitment;
	isUnsubscribing = false;

	timeoutId?: NodeJS.Timeout;

	receivingData: boolean;

	public constructor(
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey,
		grpcEndpoint: string,
		grpcXToken?: string,
		grpcChannelOptions?: ChannelOptions,
		// decodeBuffer?: (buffer: Buffer) => T,
		commitment?: Commitment
	) {
		this.accountName = accountName;
		this.program = program;
		this.accountPublicKey = accountPublicKey;
		this.receivingData = false;
		this.commitment =
			commitment ?? (this.program.provider as AnchorProvider).opts.commitment;
		this.client = new Client(grpcEndpoint, grpcXToken, grpcChannelOptions);
	}

	async subscribe(onChange: (data: T) => void): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			return;
		}
		this.onChange = onChange;
		if (!this.dataAndSlot) {
			await this.fetch();
		}
	}
	fetch(): Promise<void> {
		throw new Error('Method not implemented.');
	}
	unsubscribe(): Promise<void> {
		throw new Error('Method not implemented.');
	}
	setData(userAccount: T, slot?: number): void {
		throw new Error('Method not implemented.');
	}
}
