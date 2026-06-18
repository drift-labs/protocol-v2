import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export const managerUpdatePoolId = async (program: Command, cmdOpts: OptionValues) => {

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

    const poolId = cmdOpts.poolId ? Number(cmdOpts.poolId) : null;
    if (poolId === null) {
        console.error("Invalid pool id");
        process.exit(1);
    }

    if (cmdOpts.dumpTransactionMessage) {
        const tx = await driftVault.getUpdatePoolIdIx(vaultAddress, poolId);
        console.log(dumpTransactionMessage(driftClient.wallet.publicKey, [tx]));
    } else {
        const tx = await driftVault.updateUserPoolId(vaultAddress, poolId);
        console.log(`Updated pool id vault manager: https://solana.fm/tx/${tx}${driftClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    }
};