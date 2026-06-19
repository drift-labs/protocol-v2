import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export const managerWithdraw = async (program: Command, cmdOpts: OptionValues) => {

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

    if (cmdOpts.dumpTransactionMessage) {
        const tx = await velocityVault.getManagerWithdrawIx(vaultAddress);
        console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, tx));
    } else {
        const tx = await velocityVault.managerWithdraw(vaultAddress);
        console.log(`Withrew as vault manager: https://solana.fm/tx/${tx}${velocityClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    }
};
