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
        velocityVault,
        velocityClient
    } = await getCommandContext(program, true);

    const vaultDepositorAddress = new PublicKey(cmdOpts.vaultDepositor as string);

    if (cmdOpts.dumpTransactionMessage) {
        const tx = await velocityVault.getApplyProfitShareIx(vaultAddress, vaultDepositorAddress);
        console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, [tx]));
    } else {
        const tx = await velocityVault.applyProfitShare(vaultAddress, vaultDepositorAddress);
        console.log(`Applied profit share: https://solana.fm/tx/${tx}${velocityClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    }
};