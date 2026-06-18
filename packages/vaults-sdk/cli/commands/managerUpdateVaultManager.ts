import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export const managerUpdateVaultManager = async (program: Command, cmdOpts: OptionValues) => {

    let vaultAddress: PublicKey;
    try {
        vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
    } catch (err) {
        console.error("Invalid vault address");
        process.exit(1);
    }

    let manager: PublicKey;
    try {
        manager = new PublicKey(cmdOpts.newManager as string);
    } catch (err) {
        console.error("Invalid manager address");
        process.exit(1);
    }

    const {
        driftVault,
        driftClient,
    } = await getCommandContext(program, true);

    const vault = await driftVault.getVault(vaultAddress);

    console.log(`Updating vault manager:`);
    console.log(`  Current manager: ${vault.manager.toString()}`);
    console.log(`  New manager:     ${manager.toString()}`);

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
        console.log('Vault manager update canceled.');
        process.exit(0);
    }
    console.log('Updating vault manager...');

    let done = false;
    while (!done) {
        try {
            if (cmdOpts.dumpTransactionMessage) {
                const tx = await driftVault.getManagerUpdateVaultManagerIx(vaultAddress, manager);
                console.log(dumpTransactionMessage(driftClient.wallet.publicKey, [tx]));
            } else {
                const tx = await driftVault.managerUpdateVaultManager(vaultAddress, manager);
                console.log(`Updated vault manager: https://solana.fm/tx/${tx}${driftClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
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