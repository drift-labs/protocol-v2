// require('ts-node').register();

// import { Commitment, Connection, PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { parentPort } from 'worker_threads';
// import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
// import { Wallet, Keypair } from '../wallet'
// import { UserAccount } from '..';
// import driftIDL from '../idl/drift.json';

// const wallet = new Wallet(new Keypair());

// Listen for messages from the main thread
parentPort.on('message', async (data /*: WorkerData*/) => {
    console.log('Worker :: UserMap worker syncing usermap...');

    const connection = new Connection(data.rpcEndpoint, {
        commitment: data.commitment
    });
    const provider = new AnchorProvider(
        connection,
        // wallet,
        {
            commitment: data.commitment,
        }
    );
    const driftProgram = new Program(
        data.driftIDL, // as Idl,
        new PublicKey(data.programId),
        provider
    );


    // const filters = [getUserFilter()];
    // if (!data.includeIdle) {
    //     filters.push(getNonIdleUserFilter());
    // }

    const rpcRequestArgs = [
        driftProgram.programId.toBase58(),
        {
            commitment: data.commitment,
            filters: data.filters,
            encoding: 'base64',
            withContext: true,
        },
    ];

    // local measuremeant start
    const rpcStart = Date.now();
    const rpcJSONResponse/*: any*/ =
        await connection._rpcRequest(
            'getProgramAccounts',
            rpcRequestArgs
        );
    console.log(`Worker :: RPC call took ${Date.now() - rpcStart} ms`)
    // local measuremeant stop, took 3050 ms

    const rpcResponseAndContext/*: RpcResponseAndContext<
        Array<{
            pubkey: PublicKey;
            account: {
                data: [string, string];
            };
        }>
    >*/ = rpcJSONResponse.result;

    const slot = rpcResponseAndContext.context.slot;

    // local measuremeant start, load rpc response into map
    const startProcessUsers = Date.now();
    const rawUsers /*: Array<[string, number, [string, string]]> */ = [];
    // const programAccountBufferMap = new Map/*<string, Buffer>*/();
    for (const programAccount of rpcResponseAndContext.value) {
        // programAccountBufferMap.set(
        //     programAccount.pubkey.toString(),
        //     // @ts-ignore
        //     Buffer.from(
        //         programAccount.account.data[0],
        //         programAccount.account.data[1]
        //     )
        // );
        rawUsers.push([
            programAccount.pubkey.toString(),
            slot,
            // Buffer.from(
            [
                programAccount.account.data[0],
                programAccount.account.data[1]
            ],
            // )
        ]);
    }
    console.log(`Worker :: Raw ${rawUsers.length} users in ${Date.now() - startProcessUsers} ms`)
    // local measuremeant stop, took 138 ms

    // const decodedUsers/*: Array<[string, number, UserAccount]>*/ = [];
    // for (const [key, buffer] of programAccountBufferMap.entries()) {
    //     const userAccount =
    //         driftProgram.account.user.coder.accounts.decode(
    //             'User',
    //             buffer
    //         );
    //     decodedUsers.push([key, slot, userAccount])
    // }
    // console.log(`Worker :: Decoded ${decodedUsers.length} users in ${Date.now() - startDecodeUsers} ms`)
    // local measuremeant stop, took 8964 ms


    parentPort.postMessage({
        ts: Date.now(),
        // decodedUsers,
        rawUsers,
    }/* as WorkerResult */);
});