import { PublicKey } from "@solana/web3.js";
import {
    getVaultDepositorAddressSync
} from "../../src/addresses";
import {
    OptionValues,
    Command
} from "commander";
import { getCommandContext } from "../utils";
import { VAULT_PROGRAM_ID } from "../../src/types/types";

export const vaultWithdraw= async (program: Command, cmdOpts: OptionValues) => {

    let vaultAddress: PublicKey;
    try {
        vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
    } catch (err) {
        console.error("Invalid vault address");
        process.exit(1);
    }

    let depositAuthority: PublicKey;
    try {
        depositAuthority = new PublicKey(cmdOpts.depositAuthority as string);
    } catch (err) {
        console.error("Invalid deposit authority");
        process.exit(1);
    }

    const {
        driftVault
    } = await getCommandContext(program, true);

    const vaultDepositorAddress = getVaultDepositorAddressSync(
        VAULT_PROGRAM_ID,
        vaultAddress,
        depositAuthority,
    );
    const tx = await driftVault.initializeVaultDepositor(vaultAddress, depositAuthority);
    console.log(`VaultDepositor initialized for ${depositAuthority}: ${tx}`);
    console.log(`VaultDepositor address: ${vaultDepositorAddress}`);
};