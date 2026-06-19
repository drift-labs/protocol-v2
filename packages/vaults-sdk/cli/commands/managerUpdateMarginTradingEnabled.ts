import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export const managerUpdateMarginTradingEnabled = async (program: Command, cmdOpts: OptionValues) => {

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

    const enabled = cmdOpts.enabled ? (cmdOpts.enabled as string).toLowerCase() === "true" : false;

    if (cmdOpts.dumpTransactionMessage) {
        const tx = await velocityVault.getUpdateMarginTradingEnabledIx(vaultAddress, enabled);
        console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, [tx]));
    } else {
        const tx = await velocityVault.updateMarginTradingEnabled(vaultAddress, enabled);
        console.log(`Updated margin trading vault manager: https://solana.fm/tx/${tx}${velocityClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    }
};