import { Command, OptionValues } from "commander";
import { PublicKey } from "@solana/web3.js";
import { VaultClass } from "../../src";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export async function adminUpdateVaultClass(program: Command, cmdOpts: OptionValues): Promise<void> {
    const { vaultAddress, vaultClass, dumpTransactionMessage: dumpTx } = cmdOpts;

    const {
        driftClient,
        driftVault
    } = await getCommandContext(program, true);

    if (!vaultAddress) {
        throw new Error("Must provide vault address with --vault-address");
    }

    if (!vaultClass) {
        throw new Error("Must provide vault class with --vault-class");
    }

    const vault = new PublicKey(vaultAddress);
    
    // Parse vault class from string input
    let newVaultClass: VaultClass;
    switch (vaultClass.toLowerCase()) {
        case 'trusted':
            newVaultClass = VaultClass.TRUSTED;
            break;
        default:
            throw new Error(`Invalid vault class: ${vaultClass}. Must be 'trusted'`);
    }

    try {
        if (dumpTx) {
            const ix = await driftVault.getAdminUpdateVaultClassIx(vault, newVaultClass);
            console.log("Transaction Instruction:");
            console.log(dumpTransactionMessage(driftClient.wallet.publicKey, [ix]));
            return;
        }

        const txSig = await driftVault.adminUpdateVaultClass(vault, newVaultClass);
        console.log(`Admin update vault class transaction signature: ${txSig}`);
        console.log(`Transaction: https://solana.fm/tx/${txSig}${driftClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    } catch (error) {
        console.error("Error updating vault class:", error);
        throw error;
    }
} 