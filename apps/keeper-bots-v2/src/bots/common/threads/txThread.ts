import { logger } from '../../../logger';
import { TxSender } from './txSender';
import {
	IpcMessage,
	IpcMessageMap,
	IpcMessageTypes,
	WrappedIpcMessage,
	deserializedIx,
} from './types';
import { BlockhashSubscriber, SlotSubscriber } from '@drift-labs/sdk';
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import parseArgs from 'minimist';

const logPrefix = 'TxThread';

function sendToParent(msgType: IpcMessageTypes, data: IpcMessage) {
	process.send!({
		type: msgType,
		data,
	} as WrappedIpcMessage);
}

const main = async () => {
	// kill this process if the parent dies
	process.on('disconnect', () => process.exit());
	dotenv.config();

	const args = parseArgs(process.argv.slice(2));
	logger.info(`[${logPrefix}] Started with args: ${JSON.stringify(args)}`);
	const rpcUrl = args['rpc'];
	const sendTxEnabled = args['send-tx'] === 'true';

	if (process.send === undefined) {
		logger.error(
			`[${logPrefix}] Error spawning process: process.send is not a function`
		);
		process.exit(1);
	}

	const blockhashSubscriber = new BlockhashSubscriber({
		rpcUrl,
		commitment: 'finalized',
		updateIntervalMs: 3000,
	});
	await blockhashSubscriber.subscribe();

	const connection = new Connection(rpcUrl);
	const slotSubscriber = new SlotSubscriber(connection);
	await slotSubscriber.subscribe();

	const txSender = new TxSender({
		connection,
		blockhashSubscriber,
		slotSubscriber,
		resendInterval: 1000,
		sendTxEnabled,
	});
	await txSender.subscribe();

	const metricsSenderId = setInterval(async () => {
		sendToParent(IpcMessageTypes.METRICS, txSender.getMetrics());
	}, 10_000);

	sendToParent(IpcMessageTypes.NOTIFICATION, {
		message: 'Started',
	});

	const shutdown = async () => {
		clearInterval(metricsSenderId);

		blockhashSubscriber.unsubscribe();
		await txSender.unsubscribe();
	};

	process.on('SIGINT', async () => {
		console.log(`TxSender Received SIGINT, shutting down...`);
		await shutdown();
		process.exit(0);
	});

	process.on('SIGTERM', async () => {
		console.log(`TxSender Received SIGTERM, shutting down...`);
		await shutdown();
		process.exit(0);
	});

	process.on('message', async (_msg: WrappedIpcMessage, _sendHandle: any) => {
		switch (_msg.type) {
			case IpcMessageTypes.NOTIFICATION: {
				const notification =
					_msg.data as IpcMessageMap[IpcMessageTypes.NOTIFICATION];
				if (notification.message === 'close') {
					logger.info(`Parent close notification ${notification.message}`);
					process.exit(0);
				}
				logger.info(`Notification from parent: ${notification.message}`);
				break;
			}
			case IpcMessageTypes.NEW_SIGNER: {
				const signerPayload =
					_msg.data as IpcMessageMap[IpcMessageTypes.NEW_SIGNER];
				txSender.addSigner(signerPayload.signerKey, signerPayload.signerInfo);
				break;
			}
			case IpcMessageTypes.NEW_ADDRESS_LOOKUP_TABLE: {
				const addressLookupTablePayload =
					_msg.data as IpcMessageMap[IpcMessageTypes.NEW_ADDRESS_LOOKUP_TABLE];
				await txSender.addAddressLookupTable(addressLookupTablePayload.address);
				break;
			}
			case IpcMessageTypes.TRANSACTION: {
				const txPayload =
					_msg.data as IpcMessageMap[IpcMessageTypes.TRANSACTION];

				if (txPayload.newSigners?.length > 0) {
					for (const signer of txPayload.newSigners) {
						txSender.addSigner(signer.key, signer.info);
					}
				}

				txPayload.ixs = txPayload.ixsSerialized.map((ix) => deserializedIx(ix));
				await txSender.addTxPayload(txPayload);
				break;
			}
			case IpcMessageTypes.CONFIRM_TRANSACTION: {
				const confirmPayload =
					_msg.data as IpcMessageMap[IpcMessageTypes.CONFIRM_TRANSACTION];
				txSender.addTxToConfirm(confirmPayload);
				break;
			}
			case IpcMessageTypes.SET_TRANSACTIONS_ENABLED: {
				const txPayload =
					_msg.data as IpcMessageMap[IpcMessageTypes.SET_TRANSACTIONS_ENABLED];
				logger.info(`Parent set transactions enabled: ${txPayload.txEnabled}`);
				txSender.setTransactionsEnabled(txPayload.txEnabled);
				break;
			}
			default: {
				logger.info(
					`Unknown message type from parent: ${JSON.stringify(_msg)}`
				);
				break;
			}
		}
	});
};

main().catch((err) => {
	logger.error(`[${logPrefix}] Error in TxThread: ${JSON.stringify(err)}`);
	process.exit(1);
});
