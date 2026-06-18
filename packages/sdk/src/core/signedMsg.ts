import { sha256 } from '@noble/hashes/sha256';
import type {
	SignedMsgOrderParamsDelegateMessage,
	SignedMsgOrderParamsMessage,
} from '../types';

export type AnchorTypesCoder = {
	encode: (typeName: string, value: any) => Buffer;
	decode: (typeName: string, buffer: Buffer) => any;
};

export function encodeSignedMsgOrderParamsMessage(args: {
	coderTypes: AnchorTypesCoder;
	orderParamsMessage:
		| SignedMsgOrderParamsMessage
		| SignedMsgOrderParamsDelegateMessage;
	delegateSigner?: boolean;
}): Buffer {
	const { coderTypes, delegateSigner } = args;
	const orderParamsMessage: any = { ...args.orderParamsMessage };

	if (orderParamsMessage.maxMarginRatio === undefined) {
		orderParamsMessage.maxMarginRatio = null;
	}
	if (orderParamsMessage.isolatedPositionDeposit === undefined) {
		orderParamsMessage.isolatedPositionDeposit = null;
	}

	const anchorIxName = delegateSigner
		? 'global' + ':' + 'SignedMsgOrderParamsDelegateMessage'
		: 'global' + ':' + 'SignedMsgOrderParamsMessage';
	const prefix = Buffer.from(sha256(anchorIxName).slice(0, 8));

	const withBuilderDefaults = {
		...orderParamsMessage,
		builderIdx:
			orderParamsMessage.builderIdx !== undefined
				? orderParamsMessage.builderIdx
				: null,
		builderFeeTenthBps:
			orderParamsMessage.builderFeeTenthBps !== undefined
				? orderParamsMessage.builderFeeTenthBps
				: null,
	};

	const body = delegateSigner
		? coderTypes.encode(
				'signedMsgOrderParamsDelegateMessage',
				withBuilderDefaults as SignedMsgOrderParamsDelegateMessage
		  )
		: coderTypes.encode(
				'signedMsgOrderParamsMessage',
				withBuilderDefaults as SignedMsgOrderParamsMessage
		  );

	return Buffer.concat([prefix, body]);
}

export function decodeSignedMsgOrderParamsMessage(args: {
	coderTypes: AnchorTypesCoder;
	encodedMessage: Buffer;
	delegateSigner?: boolean;
}): SignedMsgOrderParamsMessage | SignedMsgOrderParamsDelegateMessage {
	const decodeStr = args.delegateSigner
		? 'signedMsgOrderParamsDelegateMessage'
		: 'signedMsgOrderParamsMessage';
	return args.coderTypes.decode(
		decodeStr,
		Buffer.concat([args.encodedMessage.slice(8), Buffer.alloc(128)])
	);
}
