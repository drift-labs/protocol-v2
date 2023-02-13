import * as anchor from '@project-serum/anchor';

describe('print trades', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as anchor.Program;

	before(async () => { });

	after(async () => { });

	it('initializes a print trade', async () => {
		// @ts-ignore
		const payer: anchor.web3.Keypair = provider.wallet.payer;
		const [print_trade, ] = anchor.web3.PublicKey.findProgramAddressSync(
			[Buffer.from("print_trade"), payer.publicKey.toBuffer()],
			chProgram.programId,
		);
		const tx = await chProgram.methods.initializePrintTrade().accounts(
			{
				printTrade: print_trade,
				payer: payer.publicKey,
				systemProgram: anchor.web3.SystemProgram.programId,
			}
		).signers(
			[payer]
		).rpc();
		console.log("print trade creation tx: ", tx);
	});
});
