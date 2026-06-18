import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { dumpTransactionMessage, getCommandContext } from "../utils";
import { VAULT_ADMIN_KEY } from "../../src";

export const adminInitFeeUpdate = async (program: Command, cmdOpts: OptionValues) => {
    let vaultAddress: PublicKey;
    try {
        vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
    } catch (err) {
        console.error("Invalid vault address");
        process.exit(1);
    }

    const {
        driftVault,
        driftClient,
    } = await getCommandContext(program, true);

    if (!driftClient.wallet.publicKey.equals(VAULT_ADMIN_KEY)) {
        console.error("Only vault admin can initialize fee update");
        process.exit(1);
    }

    const vault = await driftVault.getVault(vaultAddress);

    console.log(`Initializing fee update for vault:`);
    console.log(`  Vault: ${vault.pubkey.toBase58()}`);

    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    console.log('');
    const answer = await new Promise(resolve => {
        readline.question('Is the above information correct? (yes/no) ', (answer: string) => {
            readline.close();
            resolve(answer);
        });
    });
    if ((answer as string).toLowerCase() !== 'yes') {
        console.log('Fee update initialization canceled.');
        process.exit(0);
    }
    console.log('Initializing fee update...');

    let done = false;
    while (!done) {
        try {
            if (cmdOpts.dumpTransactionMessage) {
                const tx = await driftVault.getAdminInitFeeUpdateIx(vaultAddress);
                console.log(dumpTransactionMessage(driftClient.wallet.publicKey, [tx]));
            } else {
                const tx = await driftVault.adminInitFeeUpdate(vaultAddress);
                console.log(`Initialized fee update as admin: https://solana.fm/tx/${tx}${driftClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
                done = true;
            }
            break;
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('TransactionExpiredTimeoutError')) {
                console.log(err.message);
                console.log('Transaction timeout. Retrying...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                throw err;
            }
        }
    }
}; 