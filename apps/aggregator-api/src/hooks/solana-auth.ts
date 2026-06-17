import { getTimestamp, logger } from '@backend/common';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { PublicKey } from '@solana/web3.js';
import { FastifyReply, FastifyRequest } from 'fastify';
import { decodeUser } from '../sdk';
import nacl from 'tweetnacl';

declare module 'fastify' {
	interface FastifyRequest {
		walletAddress?: string;
	}
}

interface SignedMessage {
	action: string;
	ts: number;
	walletAddress: string;
	isDelegate?: boolean;
	driftUserAccount?: string;
}

const ONE_HOUR = 60 * 60;
const FIVE_MINUTES = 5 * 60;

export const solanaAuth = async (request: FastifyRequest, reply: FastifyReply) => {
	try {
		const walletAddress = request.headers['x-wallet-address'] as string;
		const rawSignature = request.headers['x-signature'] as string;
		const signedMessageString = request.headers['x-signed-message'] as string;

		if (!walletAddress || !rawSignature || !signedMessageString) {
			return reply
				.code(401)
				.send({ success: false, error: 'Missing authentication headers' });
		}

		let publicKey: PublicKey;
		try {
			publicKey = new PublicKey(walletAddress);
		} catch {
			return reply.code(401).send({ success: false, error: 'Invalid wallet address' });
		}

		let messageData: SignedMessage;
		try {
			messageData = JSON.parse(signedMessageString);
			if (!messageData.action || !messageData.ts || !messageData.walletAddress) {
				throw new Error();
			}
			if (messageData.walletAddress !== walletAddress) {
				return reply.code(401).send({ success: false, error: 'Wallet address mismatch' });
			}
		} catch {
			return reply.code(401).send({ success: false, error: 'Invalid message format' });
		}

		const messageTime = messageData.ts;
		const now = getTimestamp();
		if (typeof messageTime !== 'number' || messageTime <= 0) {
			return reply.code(401).send({
				success: false,
				error: 'Invalid timestamp - must be unix timestamp in seconds',
			});
		}
		if (now - messageTime > ONE_HOUR) {
			return reply.code(401).send({ success: false, error: 'Signature expired' });
		}
		if (messageTime > now + FIVE_MINUTES) {
			return reply.code(401).send({ success: false, error: 'Timestamp too far in future' });
		}

		try {
			const signatureBytes = bs58.decode(rawSignature);
			const messageBytes = new TextEncoder().encode(signedMessageString);
			const publicKeyBytes = publicKey.toBytes();

			const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
			if (!isValid) {
				return reply.code(401).send({ success: false, error: 'Invalid signature' });
			}
		} catch (error) {
			logger.error(`Signature verification internal error:${error}`);
			return reply.code(401).send({ success: false, error: 'Signature verification failed' });
		}

		if (messageData.isDelegate) {
			if (!messageData.driftUserAccount) {
				return reply.code(400).send({
					success: false,
					error: 'driftUserAccount required when isDelegate is true',
				});
			}

			try {
				const connection = request.server.connection;
				const driftUserPubkey = new PublicKey(messageData.driftUserAccount);
				const accountInfo = await connection.getAccountInfo(driftUserPubkey);

				if (!accountInfo) {
					return reply.code(404).send({
						success: false,
						error: 'Velocity user account not found',
					});
				}

				const userData = decodeUser(accountInfo.data);
				const isDelegate = userData.delegate.equals(publicKey);

				if (!isDelegate) {
					return reply.code(403).send({
						success: false,
						error: 'Not authorized as delegate for this Velocity account',
					});
				}

				request.walletAddress = userData.authority.toString();
			} catch (error) {
				logger.error(`Velocity account verification error: ${error}`);
				return reply.code(401).send({
					success: false,
					error: 'Failed to verify Velocity account authority',
				});
			}
		} else {
			request.walletAddress = walletAddress;
		}
	} catch (error) {
		logger.error(`Solana authentication caught an unexpected error: ${error}`);
		return reply.code(500).send({ success: false, error: 'Authentication failed' });
	}
};
