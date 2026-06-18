import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { getCommandContext, printVaultDepositor } from "../utils";
import { getVaultDepositorAddressSync } from "../../src";

export const viewVaultDepositor = async (program: Command, cmdOpts: OptionValues) => {

    let vaultDepositorAddress: PublicKey;

    const {
        driftVault
    } = await getCommandContext(program, false);

    try {
        if (cmdOpts.vaultDepositorAddress !== undefined) {
            vaultDepositorAddress = new PublicKey(cmdOpts.vaultDepositorAddress as string);
        } else if (cmdOpts.authority !== undefined && cmdOpts.vaultAddress !== undefined) {
            vaultDepositorAddress = getVaultDepositorAddressSync(
                driftVault.program.programId,
                new PublicKey(cmdOpts.vaultAddress as string),
                new PublicKey(cmdOpts.authority as string));
        } else {
            console.error("Must supply --vault-depositor-address or --authority and --vault-address");
            process.exit(1);
        }
    } catch (err) {
        console.error("Failed to load VaultDepositor address");
        process.exit(1);
    }

    const vaultDepositor = await driftVault.getVaultDepositor(vaultDepositorAddress);
    printVaultDepositor(vaultDepositor);
};