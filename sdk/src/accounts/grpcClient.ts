import Client, {
	SubscribeRequest,
	SubscribeUpdate,
	SubscribeRequestFilterAccountsFilter,
	SubscribeRequestFilterAccounts,
	SubscribeRequestFilterSlots,
	SubscribeRequestFilterTransactions,
	SubscribeRequestFilterBlocks,
	SubscribeRequestFilterBlocksMeta,
	SubscribeRequestFilterEntry,
} from '@triton-one/yellowstone-grpc';
import { ChannelOptions, ClientDuplexStream } from '@grpc/grpc-js';
import {
	SubscribeRequestPing,
	SubscribeUpdateAccount,
	SubscribeUpdateSlot,
} from '@triton-one/yellowstone-grpc/dist/grpc/geyser';

const emptyRequest: SubscribeRequest = {
	slots: {},
	accounts: {},
	transactions: {},
	blocks: {},
	blocksMeta: {},
	accountsDataSlice: [],
	entry: {},
};

/// A single grpc connection can manage multiple subscriptions (accounts, programs, blocks, etc.)
/// This class is a wrapper around a grpc client to manage multiplexing these subscriptions
/// and avoid unintentionally unsubscribing when multiple account subscribers share a connection.
///
/// SubscriptionAwareGrpcClient can be safely shared across multiple objects.
export class SubscriptionAwareGrpcClient {
	client: Client;
	/// the latest set of subscriptions
	callbacks: Map<
		string,
		[(key: string, data: any) => void, keyof SubscribeUpdate]
	> = new Map();
	subcribeRequest: SubscribeRequest;
	stream?: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;

	constructor(
		grpcEndpoint: string,
		grpcXToken?: string,
		grpcChannelOptions?: ChannelOptions
	) {
		this.client = new Client(grpcEndpoint, grpcXToken, grpcChannelOptions);
		this.subcribeRequest = emptyRequest;
	}

	async subscribe() {
		if (this.stream) {
			return;
		}
		this.stream = await this.client.subscribe();
		this.stream.on('data', (data: SubscribeUpdate) => {
			console.log('DATA:', data);
			for (const filter of data.filters) {
				if (this.callbacks.has(filter)) {
					const [callback, payloadKey] = this.callbacks.get(filter);
					callback(filter, data[payloadKey]);
				}
			}
		});
	}

	async unsubscribe() {
		if (!this.stream) {
			return;
		}

		// https://docs.triton.one/project-yellowstone/dragons-mouth-grpc-subscriptions#unsubscribing
		this.subcribeRequest = emptyRequest;
		this.stream.write(this.subcribeRequest);
		this.stream.end();
		this.stream = undefined;
		this.callbacks.clear();
	}

	addAccountSubscription(
		key: string,
		account: string[],
		callback: (key: string, data: SubscribeUpdateAccount) => void
	) {
		if (!this.stream) {
			throw new Error('must call subscribe() before adding subscriptions');
		}
		if (this.subcribeRequest.accounts[key]) {
			throw new Error(
				`Account subscription key ${key} already exists, existing subscription: ${JSON.stringify(
					this.subcribeRequest.accounts[key]
				)}, new subscription: ${JSON.stringify(account)}`
			);
		}
		this.callbacks.set(key, [callback, 'account']);
		this.subcribeRequest.accounts[key] = SubscribeRequestFilterAccounts.create({
			account,
		});
		this.stream.write(this.subcribeRequest);
	}

	addProgramSubscription(
		key: string,
		owner: string[],
		filters: SubscribeRequestFilterAccountsFilter[],
		callback: (key: string, data: SubscribeUpdateAccount) => void
	) {
		if (!this.stream) {
			throw new Error('must call subscribe() before adding subscriptions');
		}
		if (this.subcribeRequest.accounts[key]) {
			throw new Error(
				`Account subscription key ${key} already exists, existing subscription: ${JSON.stringify(
					this.subcribeRequest.accounts[key]
				)}, new subscription: ${JSON.stringify({ owner, filters })}`
			);
		}
		this.callbacks.set(key, [callback, 'account']);
		this.subcribeRequest.accounts[key] = SubscribeRequestFilterAccounts.create({
			owner,
			filters,
		});
		this.stream.write(this.subcribeRequest);
	}

	addSlotSubscription(
		key: string,
		callback: (key: string, data: SubscribeUpdateSlot) => void
	) {
		if (!this.stream) {
			throw new Error('must call subscribe() before adding subscriptions');
		}
		if (this.subcribeRequest.slots[key]) {
			throw new Error(`Slot subscription key ${key} already exists`);
		}
		this.callbacks.set(key, [callback, 'slot']);
		this.subcribeRequest.slots[key] = SubscribeRequestFilterSlots.create({});
		this.stream.write(this.subcribeRequest);
	}

	addTransactionSubscription(
		key: string,
		subscription: SubscribeRequestFilterTransactions,
		callback: (key: string, data: any) => void
	) {
		if (!this.stream) {
			throw new Error('must call subscribe() before adding subscriptions');
		}
		if (this.subcribeRequest.transactions[key]) {
			throw new Error(
				`Transaction subscription key ${key} already exists, existing subscription: ${JSON.stringify(
					this.subcribeRequest.transactions[key]
				)}, new subscription: ${JSON.stringify(subscription)}`
			);
		}
		this.callbacks.set(key, [callback, 'transaction']);
		this.subcribeRequest.transactions[key] = subscription;
	}

	addBlockSubscription(
		key: string,
		subscription: SubscribeRequestFilterBlocks,
		callback: (key: string, data: any) => void
	) {
		if (!this.stream) {
			throw new Error('must call subscribe() before adding subscriptions');
		}
		if (this.subcribeRequest.blocks[key]) {
			throw new Error(
				`Block subscription key ${key} already exists, existing subscription: ${JSON.stringify(
					this.subcribeRequest.blocks[key]
				)}, new subscription: ${JSON.stringify(subscription)}`
			);
		}
		this.callbacks.set(key, [callback, 'block']);
		this.subcribeRequest.blocks[key] = subscription;
		this.stream.write(this.subcribeRequest);
	}

	addBlockMetaSubscription(
		key: string,
		subscription: SubscribeRequestFilterBlocksMeta,
		callback: (key: string, data: any) => void
	) {
		if (!this.stream) {
			throw new Error('must call subscribe() before adding subscriptions');
		}
		if (this.subcribeRequest.blocksMeta[key]) {
			throw new Error(
				`Block meta subscription key ${key} already exists, existing subscription: ${JSON.stringify(
					this.subcribeRequest.blocksMeta[key]
				)}, new subscription: ${JSON.stringify(subscription)}`
			);
		}
		this.callbacks.set(key, [callback, 'blockMeta']);
		this.subcribeRequest.blocksMeta[key] = subscription;
		this.stream.write(this.subcribeRequest);
	}

	addEntrySubscription(
		key: string,
		subscription: SubscribeRequestFilterEntry,
		callback: (key: string, data: any) => void
	) {
		if (!this.stream) {
			throw new Error('must call subscribe() before adding subscriptions');
		}
		if (this.subcribeRequest.entry[key]) {
			throw new Error(
				`Entry subscription key ${key} already exists, existing subscription: ${JSON.stringify(
					this.subcribeRequest.entry[key]
				)}, new subscription: ${JSON.stringify(subscription)}`
			);
		}
		this.callbacks.set(key, [callback, 'entry']);
		this.subcribeRequest.entry[key] = subscription;
		this.stream.write(this.subcribeRequest);
	}

	// addAccountsDataSliceSubscription(subscription: SubscribeRequestAccountsDataSlice, callback: (key: string, data: any) => void) {
	// 	if (!this.stream) {
	// 		throw new Error("must call subscribe() before adding subscriptions");
	// 	}
	// 	this.callbacks.set(key, callback);
	// 	this.subcribeRequest.accountsDataSlice.push(subscription);
	// 	this.stream.write(this.subcribeRequest);
	// }

	addPingSubscription(subscription: SubscribeRequestPing) {
		this.subcribeRequest.ping = subscription;
		this.stream.write(this.subcribeRequest);
	}
}

const main = async () => {
	const client = new SubscriptionAwareGrpcClient(
		'https://api.rpcpool.com:443',
		'<X_TOKEN>'
	);

	await client.subscribe();

	client.addAccountSubscription(
		'BRksHqLiq2gvQw1XxsZq6DXZjD3GB5a9J63tUBgd6QS9-account',
		['BRksHqLiq2gvQw1XxsZq6DXZjD3GB5a9J63tUBgd6QS9'],
		(key, data) => {
			console.log('ACCOUNT', key, data);
		}
	);

	client.addAccountSubscription(
		'BRksHqLiq2gvQw1XxsZq6DXZjD3GB5a9J63tUBgd6QS9-account2',
		['BRksHqLiq2gvQw1XxsZq6DXZjD3GB5a9J63tUBgd6QS9'],
		(key, data) => {
			console.log('ACCOUNT_2', key, data);
		}
	);

	// client.addSlotSubscription('slots', (key, data) => {
	// 	console.log("SLOT", key, data);
	// })

	console.log('waiting...');
	await new Promise((resolve) => setTimeout(resolve, 30_000));
	console.log('done!');
	await client.unsubscribe();
	process.exit(0);
};

main();
