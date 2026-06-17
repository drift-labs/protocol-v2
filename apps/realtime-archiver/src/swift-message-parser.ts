import { DEFAULT_ENDPOINT, logger, simpleSerialize } from '@backend/common';
import { S3 } from '@backend/s3';
import { AnchorProvider, Idl, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';
import { digestSignature } from '@velocity-exchange/sdk';
import { S3Event } from 'aws-lambda';

const idl = require('@velocity-exchange/sdk/src/idl/drift.json');

const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT);
const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
	commitment: 'confirmed',
});

export const decodeMessage = (encodedMessage: string) => {
	const program = new Program(idl as Idl, idl.metadata.address, provider);
	const borshBuf = Buffer.from(encodedMessage, 'base64');
	const message = program.coder.types.decode('OrderMetadataAndMessage', borshBuf);
	// flatten the enum
	if (message.orderMessage?.authority) {
		message.orderMessage = message.orderMessage?.authority;
	}
	if (message.orderMessage?.delegated) {
		message.orderMessage = message.orderMessage?.delegated;
	}
	const serialized = simpleSerialize(message);
	const hash = digestSignature(Uint8Array.from(serialized.orderSignature));

	return {
		...serialized,
		hash,
	};
};

const signedMsgOrderMessageMetadata = {
	name: 'OrderMetadataAndMessage',
	type: {
		kind: 'struct',
		fields: [
			{
				name: 'taker_authority',
				type: 'publicKey',
			},
			{
				name: 'signing_authority',
				type: 'publicKey',
			},
			{
				name: 'order_message',
				type: {
					defined: 'SignedMsgType',
				},
			},
			{
				name: 'order_signature',
				type: {
					array: ['u8', 64],
				},
			},
			{
				name: 'uuid',
				type: {
					array: ['u8', 8],
				},
			},
			{
				name: 'ts',
				type: 'u64',
			},
		],
	},
};

const signedMsgType = {
	name: 'SignedMsgType',
	type: {
		kind: 'enum',
		variants: [
			{
				name: 'Authority',
				fields: [
					{
						name: 'signedMsgOrderParams',
						type: {
							defined: 'OrderParams',
						},
					},
					{
						name: 'subAccountId',
						type: 'u16',
					},
					{
						name: 'slot',
						type: 'u64',
					},
					{
						name: 'uuid',
						type: {
							array: ['u8', 8],
						},
					},
					{
						name: 'takeProfitOrderParams',
						type: {
							option: {
								defined: 'SignedMsgTriggerOrderParams',
							},
						},
					},
					{
						name: 'stopLossOrderParams',
						type: {
							option: {
								defined: 'SignedMsgTriggerOrderParams',
							},
						},
					},
				],
			},
			{
				name: 'Delegated',
				fields: [
					{
						name: 'signedMsgOrderParams',
						type: {
							defined: 'OrderParams',
						},
					},
					{
						name: 'takerPubkey',
						type: 'publicKey',
					},
					{
						name: 'slot',
						type: 'u64',
					},
					{
						name: 'uuid',
						type: {
							array: ['u8', 8],
						},
					},
					{
						name: 'takeProfitOrderParams',
						type: {
							option: {
								defined: 'SignedMsgTriggerOrderParams',
							},
						},
					},
					{
						name: 'stopLossOrderParams',
						type: {
							option: {
								defined: 'SignedMsgTriggerOrderParams',
							},
						},
					},
				],
			},
		],
	},
};

idl['types'].push(signedMsgOrderMessageMetadata);
idl['types'].push(signedMsgType);

export const handler = async (event: S3Event) => {
	const { getObject, putObject } = S3();

	try {
		for (const record of event.Records) {
			const sourceKey = decodeURIComponent(record.s3.object.key);
			const destinationKey = `parsed/${sourceKey}.gz`;

			const content = await getObject(sourceKey);
			const lines = content.split('\n').filter(Boolean);

			const decodedLines = lines.map((line) => {
				try {
					return JSON.stringify(decodeMessage(line));
				} catch (error) {
					console.error(error);
					logger.warn(`Failed to decode line: ${line}`, true);
					return line;
				}
			});

			await putObject(destinationKey, decodedLines.join('\n'));
			logger.info(`Successfully processed ${sourceKey} to ${destinationKey}`);
		}
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Error processing file: ${message}`);
		throw error;
	}
};
