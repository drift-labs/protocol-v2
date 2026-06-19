import { PublicKey } from "@solana/web3.js";
import {
    OptionValues,
    Command
} from "commander";
import { getCommandContext, printVault } from "../utils";
import { FeeUpdate, getFeeUpdateAddressSync } from "../../src";

export const viewVault = async (program: Command, cmdOpts: OptionValues) => {

    let address: PublicKey;
    try {
        address = new PublicKey(cmdOpts.vaultAddress as string);
    } catch (err) {
        console.error("Invalid vault address");
        process.exit(1);
    }

    const {
        velocityVault,
        velocityClient,
    } = await getCommandContext(program, false);


    const vaultAndSlot = await velocityVault.getVaultAndSlot(address);
    const vault = vaultAndSlot.vault;
    const spotMarket = velocityClient.getSpotMarketAccount(vault.spotMarketIndex);
    if (!spotMarket) {
        throw new Error(`Spot market ${vault.spotMarketIndex} not found`);
    }
    const spotOracle = velocityClient.getOracleDataForSpotMarket(vault.spotMarketIndex);
    if (!spotOracle) {
        throw new Error(`Spot oracle ${vault.spotMarketIndex} not found`);
    }
    const vaultEquity = await velocityVault.calculateVaultEquity({
        vault,
    });

    let feeUpdateAccount: FeeUpdate | null = null;

    try {
        const feeUpdatePubkey = getFeeUpdateAddressSync(velocityVault.program.programId, address);
        feeUpdateAccount = await velocityVault.getFeeUpdate(feeUpdatePubkey);
    } catch (err) {
        feeUpdateAccount = null;
    }

    await printVault(vaultAndSlot.slot, velocityClient, vault, vaultEquity, spotMarket, spotOracle, feeUpdateAccount);
};

