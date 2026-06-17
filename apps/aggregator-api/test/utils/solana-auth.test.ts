import bs58 from 'bs58';
import { FastifyReply, FastifyRequest } from 'fastify';
import nacl from 'tweetnacl';
import { solanaAuth } from '../../src/hooks/solana-auth';

const createTestSignature = (message: string, keypair: nacl.SignKeyPair) => {
	const encoded = new TextEncoder().encode(message);
	const signature = nacl.sign.detached(encoded, keypair.secretKey);
	return bs58.encode(signature);
};

describe('solanaAuth', () => {
	const keypair = nacl.sign.keyPair();
	const walletAddress = bs58.encode(keypair.publicKey);

	const buildRequest = (signedMessage: string, signature: string): FastifyRequest =>
		({
			headers: {
				'x-wallet-address': walletAddress,
				'x-signature': signature,
				'x-signed-message': signedMessage,
			},
		} as unknown as FastifyRequest);

	const buildReply = () => {
		const codeMock = jest.fn().mockReturnThis();
		const sendMock = jest.fn();
		return {
			code: codeMock,
			send: sendMock,
		} as unknown as FastifyReply & { code: typeof codeMock; send: typeof sendMock };
	};

	it('should authenticate valid signature', async () => {
		const ts = Math.floor(Date.now() / 1000);
		const message = JSON.stringify({ action: 'auth', ts, walletAddress });
		const signature = createTestSignature(message, keypair);
		const req = buildRequest(message, signature);
		const reply = buildReply();

		await solanaAuth(req, reply);

		expect(req.walletAddress).toBe(walletAddress);
		expect(reply.code).not.toHaveBeenCalledWith(401);
	});

	it('should reject invalid signature', async () => {
		const ts = Math.floor(Date.now() / 1000);
		const message = JSON.stringify({ action: 'auth', ts, walletAddress });
		const signature = bs58.encode(nacl.randomBytes(64));
		const req = buildRequest(message, signature);
		const reply = buildReply();

		await solanaAuth(req, reply);

		expect(reply.code).toHaveBeenCalledWith(401);
		expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
	});
});
