import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export const managerApplyProfitShare = async (program: Command, cmdOpts: OptionValues) => {

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

    const vaultDepositorAddress = new PublicKey(cmdOpts.vaultDepositor as string);

    if (cmdOpts.dumpTransactionMessage) {
        const tx = await driftVault.getApplyProfitShareIx(vaultAddress, vaultDepositorAddress);
        console.log(dumpTransactionMessage(driftClient.wallet.publicKey, [tx]));
    } else {
        const tx = await driftVault.applyProfitShare(vaultAddress, vaultDepositorAddress);
        console.log(`Applied profit share: https://solana.fm/tx/${tx}${driftClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    }
};