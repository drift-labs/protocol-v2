import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export const managerUpdateVaultDelegate = async (program: Command, cmdOpts: OptionValues) => {

    let vaultAddress: PublicKey;
    try {
        vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
    } catch (err) {
        console.error("Invalid vault address");
        process.exit(1);
    }

    const {
        velocityVault,
        velocityClient
    } = await getCommandContext(program, true);

    let delegate = cmdOpts.delegate;
    if (!delegate) {
        throw new Error(`Must provide delegate address`);
    } else {
        try {
            delegate = new PublicKey(delegate);
        } catch (err) {
            throw new Error(`Invalid delegate address: ${err}`);
        }
    }

    if (cmdOpts.dumpTransactionMessage) {
        const vaultAccount = await velocityVault.program.account.vault.fetch(vaultAddress);
        const tx = await velocityVault.getUpdateDelegateIx(vaultAddress, delegate, vaultAccount.user, vaultAccount.manager);
        console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, [tx]));
    } else {
        const tx = await velocityVault.updateDelegate(vaultAddress, delegate);
        console.log(`Updated vault delegate to ${delegate.toBase58()}: https://solana.fm/tx/${tx}${velocityClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    }

};