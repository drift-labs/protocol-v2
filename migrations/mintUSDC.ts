import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { Network } from '../sdk';
import { MockUSDCFaucet } from '../sdk/src';

/**
 * Update these parameters after you run the `deploy.ts`
 */
const recipientPublicKey = new PublicKey(
	'E7iAhFMa9KvwhJtaPpoqJE4wPZb16zj2Az7PM9YdWK15'
);

async function main() {
	const endpoint = process.env.ENDPOINT;
	const provider = anchor.Provider.local(endpoint);
	const connection = provider.connection;
	console.log('Endpoint:', endpoint);
	console.log('Recipient:', recipientPublicKey.toString());

	const mockUsdcFaucetProgram = anchor.workspace.MockUsdcFaucet as Program;
	const mockUsdcFaucet = new MockUSDCFaucet(
		connection,
		Network.LOCAL,
		provider.wallet,
		mockUsdcFaucetProgram.programId
	);

	const amount = new BN(10 ** 10);
	const txSig = await mockUsdcFaucet.createAssociatedTokenAccountAndMintTo(
		recipientPublicKey,
		amount
	);
	console.log('Tx:', txSig);

	const mockUsdcFaucetState: any = await mockUsdcFaucet.program.state.fetch();
	const token = new Token(
		connection,
		mockUsdcFaucetState.mint,
		TOKEN_PROGRAM_ID,
		// @ts-ignore
		provider.wallet.payer
	);

	const userAssociatedToken = await token.getOrCreateAssociatedAccountInfo(
		recipientPublicKey
	);
	console.log('Amount:', userAssociatedToken.amount.toNumber());
}

main();
