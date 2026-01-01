import {
	Connection,
	Transaction,
	TransactionInstruction,
	PublicKey,
	VersionedTransaction,
	TransactionMessage,
} from '@solana/web3.js';
import { RetryTxSender, WhileValidTxSender, Wallet, loadKeypair } from '../src';

// ============================================================================
// Configuration
// ============================================================================

const RPC_ENDPOINT = 'https://api.devnet.solana.com';
const MEMO_PROGRAM_ID = new PublicKey(
	'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
);

// ============================================================================
// Helper Functions
// ============================================================================

async function verifyTransactionFeePayer(
	connection: Connection,
	txSig: string,
	expectedFeePayer: PublicKey
): Promise<void> {
	console.log('🔍 Verifying transaction details...');

	await new Promise((resolve) => setTimeout(resolve, 2000));

	const tx = await connection.getParsedTransaction(txSig, {
		commitment: 'confirmed',
		maxSupportedTransactionVersion: 0,
	});

	if (!tx) {
		throw new Error(`Transaction ${txSig} not found`);
	}

	const actualFeePayer = tx.transaction.message.accountKeys[0].pubkey;

	console.log('   Expected Fee Payer:', expectedFeePayer.toBase58());
	console.log('   Actual Fee Payer:  ', actualFeePayer.toBase58());
	console.log('   Transaction Fee:   ', tx.meta?.fee || 0, 'lamports');

	const signers = tx.transaction.message.accountKeys
		.filter((key) => key.signer)
		.map((key) => key.pubkey.toBase58());
	console.log('   Signers:');
	signers.forEach((signer, idx) => {
		console.log(`     ${idx + 1}. ${signer}`);
	});

	if (!actualFeePayer.equals(expectedFeePayer)) {
		throw new Error(
			`Fee payer mismatch! Expected: ${expectedFeePayer.toBase58()}, Got: ${actualFeePayer.toBase58()}`
		);
	}

	console.log('   ✅ Fee payer verification passed!\n');
}

// ============================================================================
// Test Functions
// ============================================================================

async function testRetryTxSender(wallet: Wallet, connection: Connection) {
	console.log('\n========================================');
	console.log('Testing RetryTxSender');
	console.log('========================================\n');

	const retryTxSender = new RetryTxSender({
		connection,
		wallet,
	});

	const expectedFeePayer = wallet.payer!.publicKey;

	// Test Legacy Transaction
	console.log('📤 Sending legacy transaction...');
	const legacyTx = new Transaction({
		feePayer: expectedFeePayer,
	}).add(
		new TransactionInstruction({
			keys: [
				{
					pubkey: wallet.authority.publicKey,
					isSigner: true,
					isWritable: true,
				},
				{
					pubkey: expectedFeePayer,
					isSigner: false,
					isWritable: true,
				},
			],
			data: Buffer.from('RetryTxSender - Legacy Transaction Test', 'utf-8'),
			programId: MEMO_PROGRAM_ID,
		})
	);
	const { txSig: legacyTxSig } = await retryTxSender.send(legacyTx);
	console.log(`\n✅ RetryTxSender - Legacy Transaction sent successfully`);
	console.log(`   Signature: ${legacyTxSig}`);
	console.log(
		`   Explorer: https://solscan.io/tx/${legacyTxSig}?cluster=devnet\n`
	);
	await verifyTransactionFeePayer(connection, legacyTxSig, expectedFeePayer);

	// Test Versioned Transaction
	console.log('📤 Sending versioned transaction...');
	const { blockhash } = await connection.getLatestBlockhash();
	const versionedTxMessage = new TransactionMessage({
		payerKey: expectedFeePayer,
		instructions: [
			new TransactionInstruction({
				keys: [
					{
						pubkey: wallet.authority.publicKey,
						isSigner: true,
						isWritable: true,
					},
					{
						pubkey: expectedFeePayer,
						isSigner: false,
						isWritable: true,
					},
				],
				data: Buffer.from(
					'RetryTxSender - Versioned Transaction Test',
					'utf-8'
				),
				programId: MEMO_PROGRAM_ID,
			}),
		],
		recentBlockhash: blockhash,
	});
	const versionedTx = new VersionedTransaction(
		versionedTxMessage.compileToV0Message([])
	);
	const { txSig: versionedTxSig } =
		await retryTxSender.sendVersionedTransaction(versionedTx);
	console.log(`\n✅ RetryTxSender - Versioned Transaction sent successfully`);
	console.log(`   Signature: ${versionedTxSig}`);
	console.log(
		`   Explorer: https://solscan.io/tx/${versionedTxSig}?cluster=devnet\n`
	);
	await verifyTransactionFeePayer(connection, versionedTxSig, expectedFeePayer);
}

async function testWhileValidTxSender(wallet: Wallet, connection: Connection) {
	console.log('\n========================================');
	console.log('Testing WhileValidTxSender');
	console.log('========================================\n');

	const whileValidTxSender = new WhileValidTxSender({
		connection,
		wallet,
		timeout: 60000,
		retrySleep: 1000,
	});

	const expectedFeePayer = wallet.payer!.publicKey;

	// Test Legacy Transaction
	console.log('📤 Sending legacy transaction...');
	const legacyTx = new Transaction({
		feePayer: expectedFeePayer,
	}).add(
		new TransactionInstruction({
			keys: [
				{
					pubkey: wallet.authority.publicKey,
					isSigner: true,
					isWritable: true,
				},
				{
					pubkey: expectedFeePayer,
					isSigner: false,
					isWritable: true,
				},
			],
			data: Buffer.from(
				'WhileValidTxSender - Legacy Transaction Test',
				'utf-8'
			),
			programId: MEMO_PROGRAM_ID,
		})
	);
	const { txSig: legacyTxSig } = await whileValidTxSender.send(legacyTx);
	console.log(`\n✅ WhileValidTxSender - Legacy Transaction sent successfully`);
	console.log(`   Signature: ${legacyTxSig}`);
	console.log(
		`   Explorer: https://solscan.io/tx/${legacyTxSig}?cluster=devnet\n`
	);
	await verifyTransactionFeePayer(connection, legacyTxSig, expectedFeePayer);

	// Test Versioned Transaction
	console.log('📤 Sending versioned transaction...');
	const { blockhash } = await connection.getLatestBlockhash();
	const versionedTxMessage = new TransactionMessage({
		payerKey: expectedFeePayer,
		instructions: [
			new TransactionInstruction({
				keys: [
					{
						pubkey: wallet.authority.publicKey,
						isSigner: true,
						isWritable: true,
					},
					{
						pubkey: expectedFeePayer,
						isSigner: false,
						isWritable: true,
					},
				],
				data: Buffer.from(
					'WhileValidTxSender - Versioned Transaction Test',
					'utf-8'
				),
				programId: MEMO_PROGRAM_ID,
			}),
		],
		recentBlockhash: blockhash,
	});
	const versionedTx = new VersionedTransaction(
		versionedTxMessage.compileToV0Message([])
	);
	const { txSig: versionedTxSig } =
		await whileValidTxSender.sendVersionedTransaction(versionedTx);
	console.log(
		`\n✅ WhileValidTxSender - Versioned Transaction sent successfully`
	);
	console.log(`   Signature: ${versionedTxSig}`);
	console.log(
		`   Explorer: https://solscan.io/tx/${versionedTxSig}?cluster=devnet\n`
	);
	await verifyTransactionFeePayer(connection, versionedTxSig, expectedFeePayer);
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
	try {
		const connection = new Connection(RPC_ENDPOINT);

		// Case 1: Wallet with separate fee payer
		console.log('\n========================================');
		console.log('Case 1: Testing with SEPARATE Fee Payer');
		console.log('========================================\n');

		const privateKey = process.env.PRIVATE_KEY!;
		const feePayerPrivateKey = process.env.FEE_PAYER_PRIVATE_KEY!;
		const keypair = loadKeypair(privateKey);
		const feePayerKeypair = loadKeypair(feePayerPrivateKey);
		const walletWithFeePayer = new Wallet(keypair, feePayerKeypair);

		console.log(
			'Authority Public Key:',
			walletWithFeePayer.publicKey.toBase58()
		);
		console.log(
			'Fee Payer Public Key:',
			walletWithFeePayer.payer?.publicKey?.toBase58()
		);

		if (!walletWithFeePayer.payer) {
			console.warn(
				'⚠️  Warning: FEE_PAYER_PRIVATE_KEY not set. Skipping separate fee payer tests.'
			);
		} else {
			console.log(
				'\n✅ Fee payer is DIFFERENT from authority - this should be reflected in transaction logs\n'
			);

			await testRetryTxSender(walletWithFeePayer, connection);
			await testWhileValidTxSender(walletWithFeePayer, connection);
		}

		// Case 2: Wallet without separate fee payer (authority pays fees)
		console.log('\n========================================');
		console.log('Case 2: Testing with SAME Authority and Fee Payer');
		console.log('========================================\n');

		const walletWithoutFeePayer = new Wallet(keypair);

		console.log(
			'Authority Public Key:',
			walletWithoutFeePayer.publicKey.toBase58()
		);
		console.log(
			'Fee Payer Public Key:',
			walletWithoutFeePayer.payer?.publicKey?.toBase58()
		);
		console.log(
			'\n✅ Fee payer is SAME as authority - this should be reflected in transaction logs\n'
		);

		await testRetryTxSender(walletWithoutFeePayer, connection);
		await testWhileValidTxSender(walletWithoutFeePayer, connection);

		console.log('\n========================================');
		console.log('All Tests Completed Successfully! 🎉');
		console.log('========================================\n');
		console.log('Summary:');
		console.log(
			'✅ Verified fee payer is correctly set when using separate fee payer'
		);
		console.log(
			'✅ Verified fee payer is correctly set when authority pays fees'
		);
		console.log(
			'✅ All transaction logs confirmed correct fee payer assignment\n'
		);
	} catch (error) {
		console.error('\n❌ Error occurred:', error);
		process.exit(1);
	}
}

main();
