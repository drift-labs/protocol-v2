import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { EventSubscriber, DRIFT_PROGRAM_ID, EventType, WrappedEvent, EventMap } from '@drift-labs/sdk';
import driftIDL from '@drift-labs/sdk/src/idl/drift.json';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// const { EventSubscriber } = require('../src/events/eventSubscriber');

const main = async () => {
	const argv = await yargs(hideBin(process.argv))
		.option('mode', {
			alias: 'm',
			description: 'Select between events server or rpc modes',
			choices: ['events-server', 'rpc'],
			default: 'events-server'
		})
		.option('userAccount', {
			alias: 'u',
			description: 'User account to watch',
			type: 'string',
			demandOption: true
		})
		.help()
		.alias('help', 'h')
		.argv;

	const rpcEndpoint = 'https://drift-cranking.rpcpool.com/f1ead98714b94a67f82203cce918';
	const connection = new Connection(rpcEndpoint, 'confirmed');

	const provider = new AnchorProvider(
		connection,
		new Wallet(new Keypair()),
		{}
	);
	const program = new Program(
		driftIDL as Idl,
		new PublicKey(DRIFT_PROGRAM_ID),
		provider
	);

	const userAcc = argv.userAccount;
	console.log(`Watching user account: ${userAcc}`);

	const eventTypes: (keyof EventMap)[] = [
		'OrderRecord',
		'OrderActionRecord',
	];

	let eventSubscriber;
	if (argv.mode === 'events-server') {
		eventSubscriber = new EventSubscriber(connection, program, {
			address: new PublicKey(userAcc),
			eventTypes,
		});
	} else {
		eventSubscriber = new EventSubscriber(connection, program, {
			address: new PublicKey(userAcc),
			eventTypes,
			logProviderConfig: {
				type: 'websocket',
				resubTimeoutMs: 30_000,
			},
		});
	}

	await eventSubscriber.subscribe();

	// console.log(`EventSubscriber (${argv.mode}) subscribed:`, eventSubscriber.logProvider.isSubscribed());

	const eventCount = 0;
	const startTime = Date.now();

	const metrics = {
		lastEventTime: 0,
		totalEvents: 0,
		eventCount: {} as Record<string, number>
	};

	eventSubscriber.eventEmitter.on('newEvent', (event: WrappedEvent<EventType>) => {
		const eventType = event.eventType as string;
		metrics.eventCount[eventType] = (metrics.eventCount[eventType] || 0) + 1;
		console.log(event);
		metrics.totalEvents++;
		metrics.lastEventTime = Date.now();
	});

	const interval = 1000;
	setInterval(() => {
		const currentTime = Date.now();
		const elapsedTime = currentTime - metrics.lastEventTime;
		const eventsPerSecond = metrics.totalEvents / (elapsedTime / 1000);
		const timeSinceLastEvent = currentTime - metrics.lastEventTime;
		console.log(`${new Date(currentTime).toISOString()} (eventsPerSecond: ${eventsPerSecond.toFixed(2)}): ${metrics.totalEvents} events, ${timeSinceLastEvent}ms since last event, ${JSON.stringify(metrics)}`);
	}, interval);
};

main().catch(console.error);