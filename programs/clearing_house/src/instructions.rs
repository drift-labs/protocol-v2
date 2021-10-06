use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::history::deposit::DepositHistory;
use crate::state::history::liquidation::LiquidationHistory;
use crate::state::history::{funding_payment::FundingPaymentHistory, trade::TradeHistory};
use crate::state::market::Markets;
use crate::state::state::State;
use crate::state::user::{User, UserPositions};

#[derive(Accounts)]
#[instruction(
    clearing_house_nonce: u8,
    collateral_vault_nonce: u8,
    insurance_vault_nonce: u8
)]
pub struct Initialize<'info> {
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"clearing_house".as_ref()],
        bump = clearing_house_nonce,
        payer = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        seeds = [b"collateral_vault".as_ref()],
        bump = collateral_vault_nonce,
        payer = admin,
        token::mint = collateral_mint,
        token::authority = collateral_vault_authority
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        init,
        seeds = [b"insurance_vault".as_ref()],
        bump = insurance_vault_nonce,
        payer = admin,
        token::mint = collateral_mint,
        token::authority = insurance_vault_authority
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(zero)]
    pub markets: Loader<'info, Markets>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeHistory<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(zero)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
    #[account(zero)]
    pub trade_history: Loader<'info, TradeHistory>,
    #[account(zero)]
    pub liquidation_history: Loader<'info, LiquidationHistory>,
    #[account(zero)]
    pub deposit_history: Loader<'info, DepositHistory>,
}

#[derive(Accounts)]
#[instruction(user_nonce: u8)]
pub struct InitializeUser<'info> {
    #[account(
        init,
        seeds = [b"user", authority.key.as_ref()],
        bump = user_nonce,
        payer = authority
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        init,
        payer = authority,
    )]
    pub user_positions: Loader<'info, UserPositions>,
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(mut, has_one = authority)]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_collateral_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
    #[account(mut)]
    pub deposit_history: Loader<'info, DepositHistory>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(mut, has_one = authority)]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub user_collateral_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
    #[account(mut)]
    pub deposit_history: Loader<'info, DepositHistory>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub recipient: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawFromInsuranceVault<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub recipient: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub trade_history: Loader<'info, TradeHistory>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(mut, has_one = authority)]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub trade_history: Loader<'info, TradeHistory>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub state: Box<Account<'info, State>>,
    pub liquidator: Signer<'info>,
    #[account(mut)]
    pub user: Box<Account<'info, User>>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub liquidator_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub trade_history: Loader<'info, TradeHistory>,
    #[account(mut)]
    pub liquidation_history: Loader<'info, LiquidationHistory>,
}

#[derive(Accounts)]
pub struct SettleFunding<'info> {
    #[account(mut)]
    pub user: Box<Account<'info, User>>,
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct UpdateFundingRate<'info> {
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RepegCurve<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MoveAMMPrice<'info> {
    #[account(
        has_one = admin,
        constraint = state.admin_controls_prices == true
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
}

#[derive(Accounts)]
pub struct AdminUpdateState<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
pub struct AdminUpdateK<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
}
