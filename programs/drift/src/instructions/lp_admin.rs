use crate::controller;
use crate::controller::token::{receive, send_from_program_vault};
use crate::error::ErrorCode;
use crate::ids::admin_hot_wallet;
use crate::instructions::optional_accounts::get_token_mint;
use crate::math::constants::PRICE_PRECISION_U64;
use crate::math::safe_math::SafeMath;
use crate::state::lp_pool::{
    AmmConstituentDatum, AmmConstituentMapping, Constituent, ConstituentCorrelations,
    ConstituentTargetBase, LPPool, TargetsDatum, AMM_MAP_PDA_SEED,
    CONSTITUENT_CORRELATIONS_PDA_SEED, CONSTITUENT_PDA_SEED, CONSTITUENT_TARGET_BASE_PDA_SEED,
    CONSTITUENT_VAULT_PDA_SEED,
};
use crate::state::spot_market::SpotMarket;
use crate::state::state::State;
use crate::validate;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::ids::{
    jupiter_mainnet_3, jupiter_mainnet_4, jupiter_mainnet_6, lighthouse, marinade_mainnet,
    serum_program, usdc_mint,
};

use crate::state::traits::Size;
use solana_program::sysvar::instructions;

use super::optional_accounts::get_token_interface;

pub fn handle_initialize_lp_pool(
    ctx: Context<InitializeLpPool>,
    name: [u8; 32],
    min_mint_fee: i64,
    max_mint_fee: i64,
    revenue_rebalance_period: u64,
    max_aum: u128,
    max_settle_quote_amount_per_market: u64,
) -> Result<()> {
    let mut lp_pool = ctx.accounts.lp_pool.load_init()?;
    let mint = &ctx.accounts.mint;

    validate!(
        mint.decimals == 6,
        ErrorCode::DefaultError,
        "lp mint must have 6 decimals"
    )?;

    validate!(
        mint.mint_authority == Some(ctx.accounts.drift_signer.key()).into(),
        ErrorCode::DefaultError,
        "lp mint must have drift_signer as mint authority"
    )?;

    *lp_pool = LPPool {
        name,
        pubkey: ctx.accounts.lp_pool.key(),
        mint: mint.key(),
        constituent_target_base: ctx.accounts.constituent_target_base.key(),
        constituent_correlations: ctx.accounts.constituent_correlations.key(),
        constituents: 0,
        max_aum,
        last_aum: 0,
        last_aum_slot: 0,
        max_settle_quote_amount: max_settle_quote_amount_per_market,
        last_hedge_ts: 0,
        total_mint_redeem_fees_paid: 0,
        bump: ctx.bumps.lp_pool,
        min_mint_fee,
        max_mint_fee_premium: max_mint_fee,
        revenue_rebalance_period,
        next_mint_redeem_id: 1,
        quote_consituent_index: 0,
        cumulative_quote_sent_to_perp_markets: 0,
        cumulative_quote_received_from_perp_markets: 0,
        gamma_execution: 2,
        volatility: 4,
        xi: 2,
        padding: 0,
    };

    let amm_constituent_mapping = &mut ctx.accounts.amm_constituent_mapping;
    amm_constituent_mapping.lp_pool = ctx.accounts.lp_pool.key();
    amm_constituent_mapping.bump = ctx.bumps.amm_constituent_mapping;
    amm_constituent_mapping
        .weights
        .resize_with(0 as usize, AmmConstituentDatum::default);
    amm_constituent_mapping.validate()?;

    let constituent_target_base = &mut ctx.accounts.constituent_target_base;
    constituent_target_base.lp_pool = ctx.accounts.lp_pool.key();
    constituent_target_base.bump = ctx.bumps.constituent_target_base;
    constituent_target_base
        .targets
        .resize_with(0 as usize, TargetsDatum::default);
    constituent_target_base.validate()?;

    let consituent_correlations = &mut ctx.accounts.constituent_correlations;
    consituent_correlations.lp_pool = ctx.accounts.lp_pool.key();
    consituent_correlations.bump = ctx.bumps.constituent_correlations;
    consituent_correlations.correlations.resize(0 as usize, 0);
    consituent_correlations.validate()?;

    Ok(())
}

pub fn handle_increase_lp_pool_max_aum(
    ctx: Context<UpdateLpPoolParams>,
    new_max_aum: u128,
) -> Result<()> {
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;
    msg!(
        "lp pool max aum: {:?} -> {:?}",
        lp_pool.max_aum,
        new_max_aum
    );
    lp_pool.max_aum = new_max_aum;
    Ok(())
}

pub fn handle_initialize_constituent<'info>(
    ctx: Context<'_, '_, '_, 'info, InitializeConstituent<'info>>,
    spot_market_index: u16,
    decimals: u8,
    max_weight_deviation: i64,
    swap_fee_min: i64,
    swap_fee_max: i64,
    max_borrow_token_amount: u64,
    oracle_staleness_threshold: u64,
    cost_to_trade_bps: i32,
    constituent_derivative_index: Option<i16>,
    constituent_derivative_depeg_threshold: u64,
    derivative_weight: u64,
    volatility: u64,
    gamma_execution: u8,
    gamma_inventory: u8,
    xi: u8,
    new_constituent_correlations: Vec<i64>,
) -> Result<()> {
    let mut constituent = ctx.accounts.constituent.load_init()?;
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    let constituent_target_base = &mut ctx.accounts.constituent_target_base;
    let current_len = constituent_target_base.targets.len();

    constituent_target_base
        .targets
        .resize_with((current_len + 1) as usize, TargetsDatum::default);

    let new_target = constituent_target_base
        .targets
        .get_mut(current_len)
        .unwrap();
    new_target.cost_to_trade_bps = cost_to_trade_bps;
    constituent_target_base.validate()?;

    msg!(
        "initializing constituent {} with spot market index {}",
        lp_pool.constituents,
        spot_market_index
    );

    validate!(
        derivative_weight <= PRICE_PRECISION_U64,
        ErrorCode::InvalidConstituent,
        "stablecoin_weight must be between 0 and 1",
    )?;

    constituent.spot_market_index = spot_market_index;
    constituent.constituent_index = lp_pool.constituents;
    constituent.decimals = decimals;
    constituent.max_weight_deviation = max_weight_deviation;
    constituent.swap_fee_min = swap_fee_min;
    constituent.swap_fee_max = swap_fee_max;
    constituent.oracle_staleness_threshold = oracle_staleness_threshold;
    constituent.pubkey = ctx.accounts.constituent.key();
    constituent.mint = ctx.accounts.spot_market_mint.key();
    constituent.vault = ctx.accounts.constituent_vault.key();
    constituent.bump = ctx.bumps.constituent;
    constituent.max_borrow_token_amount = max_borrow_token_amount;
    constituent.lp_pool = lp_pool.pubkey;
    constituent.constituent_index = (constituent_target_base.targets.len() - 1) as u16;
    constituent.next_swap_id = 1;
    constituent.constituent_derivative_index = constituent_derivative_index.unwrap_or(-1);
    constituent.constituent_derivative_depeg_threshold = constituent_derivative_depeg_threshold;
    constituent.derivative_weight = derivative_weight;
    constituent.volatility = volatility;
    constituent.gamma_execution = gamma_execution;
    constituent.gamma_inventory = gamma_inventory;
    constituent.spot_balance.market_index = spot_market_index;
    constituent.xi = xi;
    lp_pool.constituents += 1;

    if constituent.mint.eq(&usdc_mint::ID) {
        lp_pool.quote_consituent_index = constituent.constituent_index;
    }

    let constituent_correlations = &mut ctx.accounts.constituent_correlations;
    validate!(
        new_constituent_correlations.len() as u16 == lp_pool.constituents - 1,
        ErrorCode::InvalidConstituent,
        "expected {} correlations, got {}",
        lp_pool.constituents,
        new_constituent_correlations.len()
    )?;
    constituent_correlations.add_new_constituent(&new_constituent_correlations)?;

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ConstituentParams {
    pub max_weight_deviation: Option<i64>,
    pub swap_fee_min: Option<i64>,
    pub swap_fee_max: Option<i64>,
    pub max_borrow_token_amount: Option<u64>,
    pub oracle_staleness_threshold: Option<u64>,
    pub cost_to_trade_bps: Option<i32>,
    pub constituent_derivative_index: Option<i16>,
    pub derivative_weight: Option<u64>,
    pub volatility: Option<u8>,
    pub gamma_execution: Option<u8>,
    pub gamma_inventory: Option<u8>,
    pub xi: Option<u8>,
}

pub fn handle_update_constituent_params<'info>(
    ctx: Context<UpdateConstituentParams>,
    constituent_params: ConstituentParams,
) -> Result<()> {
    let mut constituent = ctx.accounts.constituent.load_mut()?;
    if constituent.spot_balance.market_index != constituent.spot_market_index {
        constituent.spot_balance.market_index = constituent.spot_market_index;
    }

    if let Some(max_weight_deviation) = constituent_params.max_weight_deviation {
        msg!(
            "max_weight_deviation: {:?} -> {:?}",
            constituent.max_weight_deviation,
            max_weight_deviation
        );
        constituent.max_weight_deviation = max_weight_deviation;
    }

    if let Some(swap_fee_min) = constituent_params.swap_fee_min {
        msg!(
            "swap_fee_min: {:?} -> {:?}",
            constituent.swap_fee_min,
            swap_fee_min
        );
        constituent.swap_fee_min = swap_fee_min;
    }

    if let Some(swap_fee_max) = constituent_params.swap_fee_max {
        msg!(
            "swap_fee_max: {:?} -> {:?}",
            constituent.swap_fee_max,
            swap_fee_max
        );
        constituent.swap_fee_max = swap_fee_max;
    }

    if let Some(oracle_staleness_threshold) = constituent_params.oracle_staleness_threshold {
        msg!(
            "oracle_staleness_threshold: {:?} -> {:?}",
            constituent.oracle_staleness_threshold,
            oracle_staleness_threshold
        );
        constituent.oracle_staleness_threshold = oracle_staleness_threshold;
    }

    if let Some(cost_to_trade_bps) = constituent_params.cost_to_trade_bps {
        let constituent_target_base = &mut ctx.accounts.constituent_target_base;

        let target = constituent_target_base
            .targets
            .get_mut(constituent.constituent_index as usize)
            .unwrap();

        msg!(
            "cost_to_trade: {:?} -> {:?}",
            target.cost_to_trade_bps,
            cost_to_trade_bps
        );
        target.cost_to_trade_bps = cost_to_trade_bps;
    }

    if let Some(derivative_weight) = constituent_params.derivative_weight {
        msg!(
            "derivative_weight: {:?} -> {:?}",
            constituent.derivative_weight,
            derivative_weight
        );
        constituent.derivative_weight = derivative_weight;
    }

    if let Some(constituent_derivative_index) = constituent_params.constituent_derivative_index {
        msg!(
            "constituent_derivative_index: {:?} -> {:?}",
            constituent.constituent_derivative_index,
            constituent_derivative_index
        );
        constituent.constituent_derivative_index = constituent_derivative_index;
    }

    if let Some(gamma_execution) = constituent_params.gamma_execution {
        msg!(
            "gamma_execution: {:?} -> {:?}",
            constituent.gamma_execution,
            gamma_execution
        );
        constituent.gamma_execution = gamma_execution;
    }

    if let Some(gamma_inventory) = constituent_params.gamma_inventory {
        msg!(
            "gamma_inventory: {:?} -> {:?}",
            constituent.gamma_inventory,
            gamma_inventory
        );
        constituent.gamma_inventory = gamma_inventory;
    }

    if let Some(xi) = constituent_params.xi {
        msg!("xi: {:?} -> {:?}", constituent.xi, xi);
        constituent.xi = xi;
    }

    if let Some(max_borrow_token_amount) = constituent_params.max_borrow_token_amount {
        msg!(
            "max_borrow_token_amount: {:?} -> {:?}",
            constituent.max_borrow_token_amount,
            max_borrow_token_amount
        );
        constituent.max_borrow_token_amount = max_borrow_token_amount;
    }

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct LpPoolParams {
    pub max_settle_quote_amount: Option<u64>,
    pub volatility: Option<u64>,
    pub gamma_execution: Option<u8>,
    pub xi: Option<u8>,
}

pub fn handle_update_lp_pool_params<'info>(
    ctx: Context<UpdateLpPoolParams>,
    lp_pool_params: LpPoolParams,
) -> Result<()> {
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    if let Some(max_settle_quote_amount) = lp_pool_params.max_settle_quote_amount {
        msg!(
            "max_settle_quote_amount: {:?} -> {:?}",
            lp_pool.max_settle_quote_amount,
            max_settle_quote_amount
        );
        lp_pool.max_settle_quote_amount = max_settle_quote_amount;
    }

    if let Some(volatility) = lp_pool_params.volatility {
        msg!("volatility: {:?} -> {:?}", lp_pool.volatility, volatility);
        lp_pool.volatility = volatility;
    }

    if let Some(gamma_execution) = lp_pool_params.gamma_execution {
        msg!(
            "gamma_execution: {:?} -> {:?}",
            lp_pool.gamma_execution,
            gamma_execution
        );
        lp_pool.gamma_execution = gamma_execution;
    }

    if let Some(xi) = lp_pool_params.xi {
        msg!("xi: {:?} -> {:?}", lp_pool.xi, xi);
        lp_pool.xi = xi;
    }

    Ok(())
}

pub fn handle_update_amm_constituent_mapping_data<'info>(
    ctx: Context<UpdateAmmConstituentMappingData>,
    amm_constituent_mapping_data: Vec<AddAmmConstituentMappingDatum>,
) -> Result<()> {
    let amm_mapping = &mut ctx.accounts.amm_constituent_mapping;

    for datum in amm_constituent_mapping_data {
        let existing_datum = amm_mapping.weights.iter().position(|existing_datum| {
            existing_datum.perp_market_index == datum.perp_market_index
                && existing_datum.constituent_index == datum.constituent_index
        });

        if existing_datum.is_none() {
            msg!(
                "AmmConstituentDatum not found for perp_market_index {} and constituent_index {}",
                datum.perp_market_index,
                datum.constituent_index
            );
            return Err(ErrorCode::InvalidAmmConstituentMappingArgument.into());
        }

        amm_mapping.weights[existing_datum.unwrap()] = AmmConstituentDatum {
            perp_market_index: datum.perp_market_index,
            constituent_index: datum.constituent_index,
            weight: datum.weight,
            last_slot: Clock::get()?.slot,
            ..AmmConstituentDatum::default()
        };

        msg!(
            "Updated AmmConstituentDatum for perp_market_index {} and constituent_index {} to {}",
            datum.perp_market_index,
            datum.constituent_index,
            datum.weight
        );
    }

    Ok(())
}

pub fn handle_remove_amm_constituent_mapping_data<'info>(
    ctx: Context<RemoveAmmConstituentMappingData>,
    perp_market_index: u16,
    constituent_index: u16,
) -> Result<()> {
    let amm_mapping = &mut ctx.accounts.amm_constituent_mapping;

    let position = amm_mapping.weights.iter().position(|existing_datum| {
        existing_datum.perp_market_index == perp_market_index
            && existing_datum.constituent_index == constituent_index
    });

    if position.is_none() {
        msg!(
            "Not found for perp_market_index {} and constituent_index {}",
            perp_market_index,
            constituent_index
        );
        return Err(ErrorCode::InvalidAmmConstituentMappingArgument.into());
    }

    amm_mapping.weights.remove(position.unwrap());
    amm_mapping.weights.shrink_to_fit();

    Ok(())
}

pub fn handle_add_amm_constituent_data<'info>(
    ctx: Context<AddAmmConstituentMappingData>,
    init_amm_constituent_mapping_data: Vec<AddAmmConstituentMappingDatum>,
) -> Result<()> {
    let amm_mapping = &mut ctx.accounts.amm_constituent_mapping;
    let constituent_target_base = &ctx.accounts.constituent_target_base;
    let state = &ctx.accounts.state;
    let mut current_len = amm_mapping.weights.len();

    for init_datum in init_amm_constituent_mapping_data {
        let perp_market_index = init_datum.perp_market_index;

        validate!(
            perp_market_index < state.number_of_markets,
            ErrorCode::InvalidAmmConstituentMappingArgument,
            "perp_market_index too large compared to number of markets"
        )?;

        validate!(
            (init_datum.constituent_index as usize) < constituent_target_base.targets.len(),
            ErrorCode::InvalidAmmConstituentMappingArgument,
            "constituent_index too large compared to number of constituents in target weights"
        )?;

        let constituent_index = init_datum.constituent_index;
        let mut datum = AmmConstituentDatum::default();
        datum.perp_market_index = perp_market_index;
        datum.constituent_index = constituent_index;
        datum.weight = init_datum.weight;
        datum.last_slot = Clock::get()?.slot;

        // Check if the datum already exists
        let exists = amm_mapping.weights.iter().any(|d| {
            d.perp_market_index == perp_market_index && d.constituent_index == constituent_index
        });

        validate!(
            !exists,
            ErrorCode::InvalidAmmConstituentMappingArgument,
            "AmmConstituentDatum already exists for perp_market_index {} and constituent_index {}",
            perp_market_index,
            constituent_index
        )?;

        // Add the new datum to the mapping
        current_len += 1;
        amm_mapping.weights.resize(current_len, datum);
    }

    Ok(())
}

pub fn handle_update_constituent_correlation_data<'info>(
    ctx: Context<UpdateConstituentCorrelation>,
    index1: u16,
    index2: u16,
    corr: i64,
) -> Result<()> {
    let constituent_correlations = &mut ctx.accounts.constituent_correlations;
    constituent_correlations.set_correlation(index1, index2, corr)?;

    msg!(
        "Updated correlation between constituent {} and {} to {}",
        index1,
        index2,
        corr
    );

    constituent_correlations.validate()?;

    Ok(())
}

pub fn handle_begin_lp_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LPTakerSwap<'info>>,
    in_market_index: u16,
    out_market_index: u16,
    amount_in: u64,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let ixs = ctx.accounts.instructions.as_ref();
    let current_index = instructions::load_current_index_checked(ixs)? as usize;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mint = get_token_mint(remaining_accounts_iter)?;
    validate!(
        mint.is_some(),
        ErrorCode::InvalidSwap,
        "BeginLpSwap must have a mint for in token passed in"
    )?;
    let mint = mint.unwrap();

    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;
    let mut out_constituent = ctx.accounts.out_constituent.load_mut()?;

    let current_ix = instructions::load_instruction_at_checked(current_index, ixs)?;
    validate!(
        current_ix.program_id == *ctx.program_id,
        ErrorCode::InvalidSwap,
        "SwapBegin must be a top-level instruction (cant be cpi)"
    )?;

    validate!(
        in_market_index != out_market_index,
        ErrorCode::InvalidSwap,
        "in and out market the same"
    )?;

    validate!(
        amount_in != 0,
        ErrorCode::InvalidSwap,
        "amount_in cannot be zero"
    )?;

    // Validate that the passed mint is accpetable
    let mint_key = mint.key();
    validate!(
        mint_key == ctx.accounts.constituent_in_token_account.mint,
        ErrorCode::InvalidSwap,
        "mint passed to SwapBegin does not match the mint constituent in token account"
    )?;

    // Make sure we have enough balance to do the swap
    let constituent_in_token_account = &ctx.accounts.constituent_in_token_account;

    msg!("amount_in: {}", amount_in);
    msg!(
        "constituent_in_token_account.amount: {}",
        constituent_in_token_account.amount
    );
    validate!(
        amount_in <= constituent_in_token_account.amount,
        ErrorCode::InvalidSwap,
        "trying to swap more than the balance of the constituent in token account"
    )?;

    validate!(
        out_constituent.flash_loan_initial_token_amount == 0,
        ErrorCode::InvalidSwap,
        "begin_lp_swap ended in invalid state"
    )?;

    in_constituent.flash_loan_initial_token_amount = ctx.accounts.signer_in_token_account.amount;
    out_constituent.flash_loan_initial_token_amount = ctx.accounts.signer_out_token_account.amount;

    drop(in_constituent);
    drop(out_constituent);

    send_from_program_vault(
        &ctx.accounts.token_program,
        constituent_in_token_account,
        &ctx.accounts.signer_in_token_account,
        &ctx.accounts.drift_signer.to_account_info(),
        state.signer_nonce,
        amount_in,
        &Some(mint),
        Some(remaining_accounts_iter),
    )?;

    // The only other drift program allowed is SwapEnd
    let mut index = current_index + 1;
    let mut found_end = false;
    loop {
        let ix = match instructions::load_instruction_at_checked(index, ixs) {
            Ok(ix) => ix,
            Err(ProgramError::InvalidArgument) => break,
            Err(e) => return Err(e.into()),
        };

        // Check that the drift program key is not used
        if ix.program_id == crate::id() {
            // must be the last ix -- this could possibly be relaxed
            validate!(
                !found_end,
                ErrorCode::InvalidSwap,
                "the transaction must not contain a Drift instruction after FlashLoanEnd"
            )?;
            found_end = true;

            // must be the SwapEnd instruction
            let discriminator = crate::instruction::EndLpSwap::discriminator();
            validate!(
                ix.data[0..8] == discriminator,
                ErrorCode::InvalidSwap,
                "last drift ix must be end of swap"
            )?;

            validate!(
                ctx.accounts.signer_out_token_account.key() == ix.accounts[2].pubkey,
                ErrorCode::InvalidSwap,
                "the out_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.signer_in_token_account.key() == ix.accounts[3].pubkey,
                ErrorCode::InvalidSwap,
                "the in_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.constituent_out_token_account.key() == ix.accounts[4].pubkey,
                ErrorCode::InvalidSwap,
                "the constituent out_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.constituent_in_token_account.key() == ix.accounts[5].pubkey,
                ErrorCode::InvalidSwap,
                "the constituent in token account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.out_constituent.key() == ix.accounts[6].pubkey,
                ErrorCode::InvalidSwap,
                "the out constituent passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.in_constituent.key() == ix.accounts[7].pubkey,
                ErrorCode::InvalidSwap,
                "the in constituent passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.lp_pool.key() == ix.accounts[8].pubkey,
                ErrorCode::InvalidSwap,
                "the lp pool passed to SwapBegin and End must match"
            )?;
        } else {
            if found_end {
                if ix.program_id == lighthouse::ID {
                    continue;
                }

                for meta in ix.accounts.iter() {
                    validate!(
                        meta.is_writable == false,
                        ErrorCode::InvalidSwap,
                        "instructions after swap end must not have writable accounts"
                    )?;
                }
            } else {
                let mut whitelisted_programs = vec![
                    serum_program::id(),
                    AssociatedToken::id(),
                    jupiter_mainnet_3::ID,
                    jupiter_mainnet_4::ID,
                    jupiter_mainnet_6::ID,
                ];
                whitelisted_programs.push(Token::id());
                whitelisted_programs.push(Token2022::id());
                whitelisted_programs.push(marinade_mainnet::ID);

                validate!(
                    whitelisted_programs.contains(&ix.program_id),
                    ErrorCode::InvalidSwap,
                    "only allowed to pass in ixs to token, openbook, and Jupiter v3/v4/v6 programs"
                )?;

                for meta in ix.accounts.iter() {
                    validate!(
                        meta.pubkey != crate::id(),
                        ErrorCode::InvalidSwap,
                        "instructions between begin and end must not be drift instructions"
                    )?;
                }
            }
        }

        index += 1;
    }

    validate!(
        found_end,
        ErrorCode::InvalidSwap,
        "found no SwapEnd instruction in transaction"
    )?;

    Ok(())
}

pub fn handle_end_lp_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LPTakerSwap<'info>>,
) -> Result<()> {
    let signer_in_token_account = &ctx.accounts.signer_in_token_account;
    let signer_out_token_account = &ctx.accounts.signer_out_token_account;

    let admin_account_info = ctx.accounts.admin.to_account_info();

    let constituent_in_token_account = &mut ctx.accounts.constituent_in_token_account;
    let constituent_out_token_account = &mut ctx.accounts.constituent_out_token_account;

    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;
    let mut out_constituent = ctx.accounts.out_constituent.load_mut()?;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();
    let out_token_program = get_token_interface(remaining_accounts)?;

    let in_mint = get_token_mint(remaining_accounts)?;
    let out_mint = get_token_mint(remaining_accounts)?;

    validate!(
        in_mint.is_some(),
        ErrorCode::InvalidSwap,
        "EndLpSwap must have a mint for in token passed in"
    )?;

    validate!(
        out_mint.is_some(),
        ErrorCode::InvalidSwap,
        "EndLpSwap must have a mint for out token passed in"
    )?;

    let in_mint = in_mint.unwrap();
    let out_mint = out_mint.unwrap();

    // Validate that the passed mint is accpetable
    let mint_key = out_mint.key();
    validate!(
        mint_key == constituent_out_token_account.mint,
        ErrorCode::InvalidSwap,
        "mint passed to EndLpSwap does not match the mint constituent out token account"
    )?;

    let mint_key = in_mint.key();
    validate!(
        mint_key == constituent_in_token_account.mint,
        ErrorCode::InvalidSwap,
        "mint passed to EndLpSwap does not match the mint constituent in token account"
    )?;

    // Residual of what wasnt swapped
    if signer_in_token_account.amount > in_constituent.flash_loan_initial_token_amount {
        let residual = signer_in_token_account
            .amount
            .safe_sub(in_constituent.flash_loan_initial_token_amount)?;

        controller::token::receive(
            &ctx.accounts.token_program,
            signer_in_token_account,
            constituent_in_token_account,
            &admin_account_info,
            residual,
            &Some(in_mint),
            Some(remaining_accounts),
        )?;
    }

    // Whatever was swapped
    if signer_out_token_account.amount > out_constituent.flash_loan_initial_token_amount {
        let residual = signer_out_token_account
            .amount
            .safe_sub(out_constituent.flash_loan_initial_token_amount)?;

        if let Some(token_interface) = out_token_program {
            receive(
                &token_interface,
                signer_out_token_account,
                constituent_out_token_account,
                &admin_account_info,
                residual,
                &Some(out_mint),
                Some(remaining_accounts),
            )?;
        } else {
            receive(
                &ctx.accounts.token_program,
                signer_out_token_account,
                constituent_out_token_account,
                &admin_account_info,
                residual,
                &Some(out_mint),
                Some(remaining_accounts),
            )?;
        }
    }

    // Update the balance on the token accounts for after swap
    constituent_out_token_account.reload()?;
    constituent_in_token_account.reload()?;
    out_constituent.sync_token_balance(constituent_out_token_account.amount);
    in_constituent.sync_token_balance(constituent_in_token_account.amount);

    out_constituent.flash_loan_initial_token_amount = 0;
    in_constituent.flash_loan_initial_token_amount = 0;

    Ok(())
}

#[derive(Accounts)]
#[instruction(
    name: [u8; 32],
)]
pub struct InitializeLpPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"lp_pool", name.as_ref()],
        space = LPPool::SIZE,
        bump,
        payer = admin
    )]
    pub lp_pool: AccountLoader<'info, LPPool>,
    pub mint: Account<'info, anchor_spl::token::Mint>,

    #[account(
        init,
        seeds = [b"LP_POOL_TOKEN_VAULT".as_ref(), lp_pool.key().as_ref()],
        bump,
        payer = admin,
        token::mint = mint,
        token::authority = drift_signer
    )]
    pub lp_pool_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        seeds = [AMM_MAP_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
        space = AmmConstituentMapping::space(0 as usize),
        payer = admin,
    )]
    pub amm_constituent_mapping: Box<Account<'info, AmmConstituentMapping>>,

    #[account(
        init,
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
        space = ConstituentTargetBase::space(0 as usize),
        payer = admin,
    )]
    pub constituent_target_base: Box<Account<'info, ConstituentTargetBase>>,

    #[account(
        init,
        seeds = [CONSTITUENT_CORRELATIONS_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
        space = ConstituentCorrelations::space(0 as usize),
        payer = admin,
    )]
    pub constituent_correlations: Box<Account<'info, ConstituentCorrelations>>,

    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    spot_market_index: u16,
)]
pub struct InitializeConstituent<'info> {
    #[account()]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub lp_pool: AccountLoader<'info, LPPool>,

    #[account(
        mut,
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump = constituent_target_base.bump,
        realloc = ConstituentTargetBase::space(constituent_target_base.targets.len() + 1 as usize),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub constituent_target_base: Box<Account<'info, ConstituentTargetBase>>,

    #[account(
        mut,
        seeds = [CONSTITUENT_CORRELATIONS_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump = constituent_correlations.bump,
        realloc = ConstituentCorrelations::space(constituent_target_base.targets.len() + 1 as usize),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub constituent_correlations: Box<Account<'info, ConstituentCorrelations>>,

    #[account(
        init,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), spot_market_index.to_le_bytes().as_ref()],
        bump,
        space = Constituent::SIZE,
        payer = admin,
    )]
    pub constituent: AccountLoader<'info, Constituent>,
    #[account(
        seeds = [b"spot_market", spot_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        address = spot_market.load()?.mint
    )]
    pub spot_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        seeds = [CONSTITUENT_VAULT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), spot_market_index.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = drift_signer
    )]
    pub constituent_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateConstituentParams<'info> {
    pub lp_pool: AccountLoader<'info, LPPool>,
    #[account(
        mut,
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump = constituent_target_base.bump,
        constraint = constituent.load()?.lp_pool == lp_pool.key()
    )]
    pub constituent_target_base: Box<Account<'info, ConstituentTargetBase>>,
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub constituent: AccountLoader<'info, Constituent>,
}

#[derive(Accounts)]
pub struct UpdateLpPoolParams<'info> {
    #[account(mut)]
    pub lp_pool: AccountLoader<'info, LPPool>,
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
    pub state: Box<Account<'info, State>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AddAmmConstituentMappingDatum {
    pub constituent_index: u16,
    pub perp_market_index: u16,
    pub weight: i64,
}

#[derive(Accounts)]
#[instruction(
    amm_constituent_mapping_data:  Vec<AddAmmConstituentMappingDatum>,
)]
pub struct AddAmmConstituentMappingData<'info> {
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    #[account(
        mut,
        seeds = [AMM_MAP_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
        realloc = AmmConstituentMapping::space(amm_constituent_mapping.weights.len() + amm_constituent_mapping_data.len()),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub amm_constituent_mapping: Box<Account<'info, AmmConstituentMapping>>,
    #[account(
        mut,
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
        realloc = ConstituentTargetBase::space(constituent_target_base.targets.len() + 1 as usize),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub constituent_target_base: Box<Account<'info, ConstituentTargetBase>>,
    pub state: Box<Account<'info, State>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    amm_constituent_mapping_data:  Vec<AddAmmConstituentMappingDatum>,
)]
pub struct UpdateAmmConstituentMappingData<'info> {
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    #[account(
        mut,
        seeds = [AMM_MAP_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    pub amm_constituent_mapping: Box<Account<'info, AmmConstituentMapping>>,
    pub system_program: Program<'info, System>,
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
pub struct RemoveAmmConstituentMappingData<'info> {
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    #[account(
        mut,
        seeds = [AMM_MAP_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
        realloc = AmmConstituentMapping::space(amm_constituent_mapping.weights.len() - 1),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub amm_constituent_mapping: Box<Account<'info, AmmConstituentMapping>>,
    pub system_program: Program<'info, System>,
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
pub struct UpdateConstituentCorrelation<'info> {
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    #[account(
        mut,
        seeds = [CONSTITUENT_CORRELATIONS_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump = constituent_correlations.bump,
    )]
    pub constituent_correlations: Box<Account<'info, ConstituentCorrelations>>,
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
    out_market_index: u16,
)]
pub struct LPTakerSwap<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,

    /// Signer token accounts
    #[account(
        mut,
        constraint = &constituent_out_token_account.mint.eq(&signer_out_token_account.mint),
        token::authority = admin
    )]
    pub signer_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &constituent_in_token_account.mint.eq(&signer_in_token_account.mint),
        token::authority = admin
    )]
    pub signer_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Constituent token accounts
    #[account(
        mut,
        address = out_constituent.load()?.vault,
    )]
    pub constituent_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = in_constituent.load()?.vault,
    )]
    pub constituent_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Constituents
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump = out_constituent.load()?.bump,
    )]
    pub out_constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump = in_constituent.load()?.bump,
    )]
    pub in_constituent: AccountLoader<'info, Constituent>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    /// Instructions Sysvar for instruction introspection
    /// CHECK: fixed instructions sysvar account
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
}
