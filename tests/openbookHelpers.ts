import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { BankrunContextWrapper } from "../sdk/src/bankrun/bankrunConnection";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN, Program } from "@coral-xyz/anchor";

export const OPENBOOK = new PublicKey("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");

const BID_ASKS_SIZE = 90952;
const EVENT_HEAP_SIZE = 91288;

const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], OPENBOOK)[0];

export class OrderType {
    static readonly MARKET = { market: {} };
	static readonly LIMIT = { limit: {} };
}

export class Side {
    static readonly BID = { bid: {} };
    static readonly ASK = { ask: {} };
}

export class SelfTradeBehavior {
    static readonly DECREMENT_TAKE = { decrementTake: {} };
}

export async function createBidsAsksEventHeap(
    context: BankrunContextWrapper,
    bids: Keypair,
    asks: Keypair,
    eventHeap: Keypair,
): Promise<void> {
    const createBidsIx = SystemProgram.createAccount({
        fromPubkey: context.context.payer.publicKey,
        newAccountPubkey: bids.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
        space: BID_ASKS_SIZE,
        programId: OPENBOOK
    });

    const createAsksIx = SystemProgram.createAccount({
        fromPubkey: context.context.payer.publicKey,
        newAccountPubkey: asks.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
        space: BID_ASKS_SIZE,
        programId: OPENBOOK
    });

    const createEventHeapIx = SystemProgram.createAccount({
        fromPubkey: context.context.payer.publicKey,
        newAccountPubkey: eventHeap.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
        space: EVENT_HEAP_SIZE,
        programId: OPENBOOK
    });

    const tx = new Transaction().add(createBidsIx).add(createAsksIx).add(createEventHeapIx);

    await context.sendTransaction(tx, [bids, asks, eventHeap]);
}

export async function createMarket(
    context: BankrunContextWrapper,
    openbookProgram: Program,
    market: Keypair,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    bids: PublicKey,
    asks: PublicKey,
    eventHeap: PublicKey,
): Promise<[PublicKey, PublicKey, PublicKey]> {

    const marketAuthority = PublicKey.findProgramAddressSync([Buffer.from("Market"), market.publicKey.toBuffer()], OPENBOOK)[0];
    const marketBaseVault = getAssociatedTokenAddressSync(baseMint, marketAuthority, true);
    const marketQuoteVault = getAssociatedTokenAddressSync(quoteMint, marketAuthority, true);

    const name = "SOL-USDC";
    const quoteLotSize = new BN(1);
    const baseLotSize = new BN(1);
    const makerFee = new BN(1_000);
    const takerFee = new BN(1_000);
    const timeExpiry = new BN(0);
    const oracleConfigParams = {
        confFilter: new BN(0.1),
        maxStalenessSlots: new BN(100)
    };

    const createMarketIx = openbookProgram.instruction.createMarket(
        name,
        oracleConfigParams,
        quoteLotSize,
        baseLotSize,
        makerFee,
        takerFee,
        timeExpiry,
        {
        accounts: {
            market: market.publicKey,
            marketAuthority: marketAuthority,
            bids: bids,
            asks: asks,
            eventHeap: eventHeap,
            payer: context.context.payer.publicKey,
            marketBaseVault: marketBaseVault,
            marketQuoteVault: marketQuoteVault,
            baseMint: baseMint,
            quoteMint: quoteMint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            oracleA: OPENBOOK,
            oracleB: OPENBOOK,
            collectFeeAdmin: OPENBOOK,
            openOrdersAdmin: OPENBOOK,
            consumeEventsAdmin: OPENBOOK,
            closeMarketAdmin: OPENBOOK,
            eventAuthority: EVENT_AUTHORITY,
            program: OPENBOOK,
        },
    });

    await context.sendTransaction(new Transaction().add(createMarketIx), [market]);

    return [marketAuthority, marketBaseVault, marketQuoteVault];
}

export async function placeOrder(
    context: BankrunContextWrapper,
    openbookProgram: Program,
    openOrdersAccount: PublicKey,
    mint: PublicKey,
    market: PublicKey,
    bids: PublicKey,
    asks: PublicKey,
    eventHeap: PublicKey,
    marketVault: PublicKey,
    userTokenAccount: PublicKey,
    args: {
        side: Side,
        priceLots: BN,
        maxBaseLots: BN,
        maxQuoteLotsIncludingFees: BN,
        clientOrderId: BN,
        orderType: OrderType,
        expiryTimestamp: BN,
        selfTradeBehavior: SelfTradeBehavior
        limit: BN,
    },
): Promise<void> {

    const placeOrderIx = openbookProgram.instruction.placeOrder(
        args,
    {
        accounts: {
            signer: context.context.payer.publicKey,
            openOrdersAccount: openOrdersAccount,
            openOrdersAdmin: OPENBOOK,
            userTokenAccount: userTokenAccount,
            market: market,
            bids: bids,
            asks: asks,
            eventHeap: eventHeap,
            marketVault: marketVault,
            oracleA: OPENBOOK,
            oracleB: OPENBOOK,
            tokenProgram: TOKEN_PROGRAM_ID,
            program: OPENBOOK
        }
    });

    const tx = new Transaction().add(placeOrderIx);

    await context.sendTransaction(tx);
}

export async function createOpenOrdersAccount(
    context: BankrunContextWrapper,
    openbookProgram: Program,
    market: PublicKey
): Promise<[PublicKey, PublicKey]> {
    const openOrdersIndexer = PublicKey.findProgramAddressSync([Buffer.from("OpenOrdersIndexer"), context.context.payer.publicKey.toBuffer()], OPENBOOK)[0];
    const openOrdersAccount = PublicKey.findProgramAddressSync([Buffer.from("OpenOrders"), context.context.payer.publicKey.toBuffer(), new BN(1).toArrayLike(Buffer, 'le', 4)], OPENBOOK)[0];

    const createOpenOrdersIndexerIx = openbookProgram.instruction.createOpenOrdersIndexer({
        accounts: {
            payer: context.context.payer.publicKey,
            owner: context.context.payer.publicKey,
            openOrdersIndexer: openOrdersIndexer,
            systemProgram: SystemProgram.programId,
            program: OPENBOOK,
        }
    });

    const createOpenOrdersAccountIx = openbookProgram.instruction.createOpenOrdersAccount(
        "Freddy",
    {
        accounts: {
            payer: context.context.payer.publicKey,
            owner: context.context.payer.publicKey,
            delegateAccount: OPENBOOK,
            openOrdersIndexer: openOrdersIndexer,
            openOrdersAccount: openOrdersAccount,
            market: market,
            systemProgram: SystemProgram.programId,
            program: OPENBOOK
        }
    });

    const tx = new Transaction().add(createOpenOrdersIndexerIx).add(createOpenOrdersAccountIx);

    await context.sendTransaction(tx);

    return [openOrdersIndexer, openOrdersAccount];
}