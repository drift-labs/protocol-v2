import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { getCommandContext } from "../utils";
import { getVaultDepositorAddressSync, VAULT_PROGRAM_ID } from "../../src";

export const withdraw = async (program: Command, cmdOpts: OptionValues) => {

    // verify correct args provided
    if (!cmdOpts.vaultDepositorAddress) {
        if (!cmdOpts.vaultAddress || !cmdOpts.authority) {
            console.error("Must provide --vault-address and --authority if not providing --vault-depositor-address");
            process.exit(1);
        }
    }

    const {
        driftVault,
        driftClient
    } = await getCommandContext(program, true);

    let vaultDepositorAddress: PublicKey;
    if (cmdOpts.vaultDepositorAddress) {
        try {
            vaultDepositorAddress = new PublicKey(cmdOpts.vaultDepositorAddress as string);
        } catch (err) {
            console.error("Invalid vault depositor address");
            process.exit(1);
        }
    } else {
        const vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
        const authority = new PublicKey(cmdOpts.authority as string);
        vaultDepositorAddress = getVaultDepositorAddressSync(VAULT_PROGRAM_ID, vaultAddress, authority);
    }

    const tx = await driftVault.withdraw(vaultDepositorAddress);
    console.log(`Withdrew from vault: https://solana.fm/tx/${tx}${driftClient.env === "devnet" ? "?cluster=devnet-solana" : ""}`);
};