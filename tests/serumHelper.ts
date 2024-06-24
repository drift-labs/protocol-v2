// TODO: Modernize all these apis. This is all quite clunky.

import {
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

const TokenInstructions = require('@project-serum/serum').TokenInstructions;
const Market = require('@project-serum/serum').Market;
const DexInstructions = require('@project-serum/serum').DexInstructions;
const web3 = require('@coral-xyz/anchor').web3;
const BN = require('@coral-xyz/anchor').BN;
const Account = web3.Account;
const Transaction = web3.Transaction;
const PublicKey = web3.PublicKey;
const SystemProgram = web3.SystemProgram;

const DEX_PID = new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");

async function listMarket({
	context,
	wallet,
	baseMint,
	quoteMint,
	baseLotSize,
	quoteLotSize,
	dexProgramId,
	feeRateBps,
}) {
	const market = new Account();
	const requestQueue = new Account();
	const eventQueue = new Account();
	const bids = new Account();
	const asks = new Account();
	const baseVault = new Account();
	const quoteVault = new Account();
	const quoteDustThreshold = new BN(100);

	const vaultOwner = await PublicKey.createProgramAddress(
		[market.publicKey.toBuffer(), Buffer.from(new BN(255))],
		dexProgramId
	);
	const vaultSignerNonce = new BN(255);

	const tx1 = new Transaction();
	tx1.add(
		SystemProgram.createAccount({
			fromPubkey: wallet.publicKey,
			newAccountPubkey: baseVault.publicKey,
			lamports: LAMPORTS_PER_SOL,
			space: 165,
			programId: TOKEN_PROGRAM_ID,
		}),
		SystemProgram.createAccount({
			fromPubkey: wallet.publicKey,
			newAccountPubkey: quoteVault.publicKey,
			lamports: LAMPORTS_PER_SOL,
			space: 165,
			programId: TOKEN_PROGRAM_ID,
		}),
		TokenInstructions.initializeAccount({
			account: baseVault.publicKey,
			mint: baseMint,
			owner: vaultOwner,
		}),
		TokenInstructions.initializeAccount({
			account: quoteVault.publicKey,
			mint: quoteMint,
			owner: vaultOwner,
		})
	);

	const tx2 = new Transaction();
	tx2.add(
		SystemProgram.createAccount({
			fromPubkey: wallet.publicKey,
			newAccountPubkey: market.publicKey,
			lamports: LAMPORTS_PER_SOL * 100,
			space: Market.getLayout(dexProgramId).span,
			programId: dexProgramId,
		}),
		SystemProgram.createAccount({
			fromPubkey: wallet.publicKey,
			newAccountPubkey: requestQueue.publicKey,
			lamports: LAMPORTS_PER_SOL * 100,
			space: 5120 + 12,
			programId: dexProgramId,
		}),
		SystemProgram.createAccount({
			fromPubkey: wallet.publicKey,
			newAccountPubkey: eventQueue.publicKey,
			lamports: LAMPORTS_PER_SOL * 100,
			space: 262144 + 12,
			programId: dexProgramId,
		}),
		SystemProgram.createAccount({
			fromPubkey: wallet.publicKey,
			newAccountPubkey: bids.publicKey,
			lamports: LAMPORTS_PER_SOL * 100,
			space: 65536 + 12,
			programId: dexProgramId,
		}),
		SystemProgram.createAccount({
			fromPubkey: wallet.publicKey,
			newAccountPubkey: asks.publicKey,
			lamports: LAMPORTS_PER_SOL * 100,
			space: 65536 + 12,
			programId: dexProgramId,
		}),
		DexInstructions.initializeMarket({
			market: market.publicKey,
			requestQueue: requestQueue.publicKey,
			eventQueue: eventQueue.publicKey,
			bids: bids.publicKey,
			asks: asks.publicKey,
			baseVault: baseVault.publicKey,
			quoteVault: quoteVault.publicKey,
			baseMint,
			quoteMint,
			baseLotSize: new BN(baseLotSize),
			quoteLotSize: new BN(quoteLotSize),
			feeRateBps,
			vaultSignerNonce,
			quoteDustThreshold,
			programId: dexProgramId,
		})
	);

	const signedTransactions = await signTransactions({
		transactionsAndSigners: [
			{ transaction: tx1, signers: [baseVault, quoteVault] },
			{
				transaction: tx2,
				signers: [market, requestQueue, eventQueue, bids, asks],
			},
		],
		wallet,
		connection: context,
	});

	for (const signedTransaction of signedTransactions) {
		await context.connection.sendTransaction(signedTransaction);
	}

	await context.getAccountInfo(market.publicKey);

	return market.publicKey;
}

async function signTransactions({
	transactionsAndSigners,
	wallet,
	connection,
}) {
	const blockhash = (await connection.getLatestBlockhash());
	transactionsAndSigners.forEach(({ transaction, signers = [] }) => {
		transaction.recentBlockhash = blockhash;
		transaction.setSigners(
			wallet.publicKey,
			...signers.map((s) => s.publicKey)
		);
		if (signers.length > 0) {
			transaction.partialSign(...signers);
		}
	});
	return await wallet.signAllTransactions(
		transactionsAndSigners.map(({ transaction }) => transaction)
	);
}

module.exports = {
	listMarket,
};