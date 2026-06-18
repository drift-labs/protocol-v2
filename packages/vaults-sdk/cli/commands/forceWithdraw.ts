import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { getCommandContext } from "../utils";
import { getVaultDepositorAddressSync } from "../../src/addresses";
import { VAULT_PROGRAM_ID } from "../../src";

export const forceWithdraw = async (program: Command, cmdOpts: OptionValues) => {

    let vaultDepositorAddress: PublicKey | undefined;
    try {
        vaultDepositorAddress = new PublicKey(cmdOpts.vaultDepositorAddress as string);
    } catch (err) {
        console.error("Failed to parse vaultDepositorAddress trying vaultDepositorAuthority");
    }

    let vaultDepositorAuthority: PublicKey | undefined;
    try {
        vaultDepositorAuthority = new PublicKey(cmdOpts.vaultDepositorAuthority as string);
    } catch (err) {
        console.error("Failed to parse vaultDepositorAuthority");
    }

    if (!vaultDepositorAuthority && !vaultDepositorAddress) {
        throw new Error("VaultDepositor address or authority must be provided");
    }

    let vaultAddress: PublicKey | undefined;
    if (vaultDepositorAuthority && !vaultDepositorAddress) {
        try {
            vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
        } catch (err) {
            throw new Error("Must provide --vault-address if only --vault-depositor-authority is provided");
        }
        vaultDepositorAddress = getVaultDepositorAddressSync(
            VAULT_PROGRAM_ID,
            vaultAddress,
            vaultDepositorAuthority);
    }

    if (!vaultDepositorAddress) {
        throw new Error("Failed to derive vault depositor address");
    }

    const {
        driftVault,
        driftClient,
    } = await getCommandContext(program, true);

    const tx = await driftVault.forceWithdraw(vaultDepositorAddress, {
        lookupTables: await driftClient.fetchAllLookupTableAccounts()
    });
    console.log(`Forced withdraw from vault: ${tx}`);
};