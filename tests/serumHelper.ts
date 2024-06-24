// TODO: Modernize all these apis. This is all quite clunky.

import {
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Account, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram, Connection } from '@solana/web3.js';
import { TokenInstructions, Market, DexInstructions, OpenOrders } from "@project-serum/serum";
import { BN } from "@coral-xyz/anchor";
import { WRAPPED_SOL_MINT } from '../sdk/lib';

export const SERUM = new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");

export async function listMarket({
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

	async function getVaultOwnerAndNonce() {
		const nonce = new BN(0);
		while (nonce.lten(255)) {
		  try {
			const vaultOwner = await PublicKey.createProgramAddress(
			  [market.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
			  dexProgramId,
			);
			return [vaultOwner, nonce];
		  } catch (e) {
			nonce.iaddn(1);
		  }
		}
	  }
	  const [vaultOwner, vaultSignerNonce] = await getVaultOwnerAndNonce();
	

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

	await context.connection.getAccountInfo(market.publicKey);

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

export async function makePlaceOrderTransaction(
    connection: Connection,
	market: Market,
    {
      owner,
      payer,
      side,
      price,
      size,
      orderType = 'limit',
      clientId,
      openOrdersAddressKey,
      openOrdersAccount,
      feeDiscountPubkey = undefined,
      selfTradeBehavior = 'decrementTake',
      maxTs,
      replaceIfExists = false,
	  openOrdersAccounts = [],
    },
    feeDiscountPubkeyCacheDurationMs = 0,
  ) {
    // @ts-ignore
    const ownerAddress: PublicKey = owner.publicKey ?? owner;
    // const openOrdersAccounts = await this.findOpenOrdersAccountsForOwner(
    //   connection,
    //   ownerAddress,
    //   cacheDurationMs,
    // );
    const transaction = new Transaction();
    const signers: Account[] = [];

    // Fetch an SRM fee discount key if the market supports discounts and it is not supplied
    let useFeeDiscountPubkey: PublicKey | null;
    if (feeDiscountPubkey) {
      useFeeDiscountPubkey = feeDiscountPubkey;
    } else if (
      feeDiscountPubkey === undefined &&
      this.supportsSrmFeeDiscounts
    ) {
      useFeeDiscountPubkey = (
        await market.findBestFeeDiscountKey(
          connection,
          ownerAddress,
          feeDiscountPubkeyCacheDurationMs,
        )
      ).pubkey;
    } else {
      useFeeDiscountPubkey = null;
    }

    let openOrdersAddress: PublicKey;
    if (openOrdersAccounts.length === 0) {
      let account;
      if (openOrdersAccount) {
        account = openOrdersAccount;
      } else {
        account = new Account();
      }
      transaction.add(
        await OpenOrders.makeCreateAccountTransaction(
          connection,
          market.address,
          ownerAddress,
          account.publicKey,
          market._programId,
        ),
      );
      openOrdersAddress = account.publicKey;
      signers.push(account);
      // refresh the cache of open order accounts on next fetch
    //   market._openOrdersAccountsCache[ownerAddress.toBase58()].ts = 0;
    } else if (openOrdersAccount) {
      openOrdersAddress = openOrdersAccount.publicKey;
    } else if (openOrdersAddressKey) {
      openOrdersAddress = openOrdersAddressKey;
    } else {
      openOrdersAddress = openOrdersAccounts[0].address;
    }

    let wrappedSolAccount: Account | null = null;
    if (payer.equals(ownerAddress)) {
      if (
        (side === 'buy' && this.quoteMintAddress.equals(WRAPPED_SOL_MINT)) ||
        (side === 'sell' && this.baseMintAddress.equals(WRAPPED_SOL_MINT))
      ) {
        wrappedSolAccount = new Account();
        let lamports;
        if (side === 'buy') {
          lamports = Math.round(price * size * 1.01 * LAMPORTS_PER_SOL);
          if (openOrdersAccounts.length > 0) {
            lamports -= openOrdersAccounts[0].quoteTokenFree.toNumber();
          }
        } else {
          lamports = Math.round(size * LAMPORTS_PER_SOL);
          if (openOrdersAccounts.length > 0) {
            lamports -= openOrdersAccounts[0].baseTokenFree.toNumber();
          }
        }
        lamports = Math.max(lamports, 0) + 1e7;
        transaction.add(
          SystemProgram.createAccount({
            fromPubkey: ownerAddress,
            newAccountPubkey: wrappedSolAccount.publicKey,
            lamports,
            space: 165,
            programId: TOKEN_PROGRAM_ID,
          }),
        );
        transaction.add(
          TokenInstructions.initializeAccount({
            account: wrappedSolAccount.publicKey,
            mint: WRAPPED_SOL_MINT,
            owner: ownerAddress,
          }),
        );
        signers.push(wrappedSolAccount);
      } else {
        throw new Error('Invalid payer account');
      }
    }

    const placeOrderInstruction = this.makePlaceOrderInstruction(connection, {
      owner,
      payer: wrappedSolAccount?.publicKey ?? payer,
      side,
      price,
      size,
      orderType,
      clientId,
      openOrdersAddressKey: openOrdersAddress,
      feeDiscountPubkey: useFeeDiscountPubkey,
      selfTradeBehavior,
      maxTs,
      replaceIfExists,
    });
    transaction.add(placeOrderInstruction);

    if (wrappedSolAccount) {
      transaction.add(
        TokenInstructions.closeAccount({
          source: wrappedSolAccount.publicKey,
          destination: ownerAddress,
          owner: ownerAddress,
        }),
      );
    }

    return { transaction, signers, payer: owner };
  }