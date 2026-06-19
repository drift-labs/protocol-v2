import { Command, OptionValues } from "commander";
import { PublicKey } from "@solana/web3.js";
import { VaultClass } from "../../src";
import { dumpTransactionMessage, getCommandContext } from "../utils";

export async function adminUpdateVaultClass(program: Command, cmdOpts: OptionValues): Promise<void> {
    const { vaultAddress, vaultClass, dumpTransactionMessage: dumpTx } = cmdOpts;

    const {
        velocityClient,
        velocityVault
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
            const ix = await velocityVault.getAdminUpdateVaultClassIx(vault, newVaultClass);
            console.log("Transaction Instruction:");
            console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, [ix]));
            return;
        }

        const txSig = await velocityVault.adminUpdateVaultClass(vault, newVaultClass);
        console.log(`Admin update vault class transaction signature: ${txSig}`);
        console.log(`Transaction: https://solana.fm/tx/${txSig}${velocityClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
    } catch (error) {
        console.error("Error updating vault class:", error);
        throw error;
    }
} 