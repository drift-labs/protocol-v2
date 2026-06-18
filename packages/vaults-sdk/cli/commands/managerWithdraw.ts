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
        driftVault,
        driftClient
    } = await getCommandContext(program, true);

    if (cmdOpts.dumpTransactionMessage) {
        const tx = await driftVault.getManagerWithdrawIx(vaultAddress);
        console.log(dumpTransactionMessage(driftClient.wallet.publicKey, tx));
    } else {
        const tx = await driftVault.managerWithdraw(vaultAddress);
        console.log(`Withrew as vault manager: https://solana.fm/tx/${tx}${driftClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    }
};
