import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { getCommandContext } from "../utils";

export const listDepositorsForVault = async (program: Command, cmdOpts: OptionValues) => {

    const {
        driftVault
    } = await getCommandContext(program, false);

    let vaultAddress: PublicKey | undefined = undefined;
    try {
        if (cmdOpts.vaultAddress !== undefined) {
            vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
        } else {
            console.error("Must supply --vault-address");
            process.exit(1);
        }
    } catch (err) {
        console.error("Failed to load VaultDepositor address");
        process.exit(1);
    }

    const vaultDepositors = await driftVault.getAllVaultDepositors(vaultAddress);
    vaultDepositors.forEach((vaultDepositor) => {
        console.log(vaultDepositor.publicKey.toBase58());
    });
    // printVaultDepositor(vaultDepositor);
};