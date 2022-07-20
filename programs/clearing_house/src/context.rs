use anchor_lang::{prelude::*, AnchorDeserialize, AnchorSerialize};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::controller::position::PositionDirection;
use crate::state::bank::Bank;
use crate::state::market::Market;
use crate::state::state::State;
use crate::state::user::{OrderTriggerCondition, OrderType, User};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"clearing_house".as_ref()],
        space = std::mem::size_of::<State>() + 8,
        bump,
        payer = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub quote_asset_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        seeds = [b"insurance_vault".as_ref()],
        bump,
        payer = admin,
        token::mint = quote_asset_mint,
        token::authority = insurance_vault_authority
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked in `initialize`
    pub insurance_vault_authority: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeBank<'info> {
    #[account(
        init,
        seeds = [b"bank", state.number_of_banks.to_le_bytes().as_ref()],
        space = std::mem::size_of::<Bank>() + 8,
        bump,
        payer = admin
    )]
    pub bank: AccountLoader<'info, Bank>,
    pub bank_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        seeds = [b"bank_vault".as_ref(), state.number_of_banks.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        token::mint = bank_mint,
        token::authority = bank_vault_authority
    )]
    pub bank_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        seeds = [b"bank_vault_authority".as_ref(), state.number_of_banks.to_le_bytes().as_ref()],
        bump,
    )]
    /// CHECK: this is the pda for the bank vault
    pub bank_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    /// CHECK: checked in `initialize_bank`
    pub oracle: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(
    user_id: u8,
)]
pub struct InitializeUser<'info> {
    #[account(
        init,
        seeds = [b"user", authority.key.as_ref(), user_id.to_le_bytes().as_ref()],
        space = std::mem::size_of::<User>() + 8,
        bump,
        payer = payer
    )]
    pub user: AccountLoader<'info, User>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        init,
        seeds = [b"market", state.number_of_markets.to_le_bytes().as_ref()],
        space = std::mem::size_of::<Market>() + 8,
        bump,
        payer = admin
    )]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: checked in `initialize_market`
    pub oracle: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bank_index: u64,)]
pub struct Deposit<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bank_vault".as_ref(), bank_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub bank_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &bank_vault.mint.eq(&user_token_account.mint)
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(bank_index: u64,)]
pub struct Withdraw<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bank_vault".as_ref(), bank_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub bank_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"bank_vault_authority".as_ref(), bank_index.to_le_bytes().as_ref()],
        bump,
    )]
    /// CHECK: this is the pda for the bank vault
    pub bank_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &bank_vault.mint.eq(&user_token_account.mint)
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettlePNL<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateAMM<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(bank_index: u64,)]
pub struct TransferDeposit<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub from_user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub to_user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
pub struct UpdateBankCumulativeInterest<'info> {
    #[account(mut)]
    pub bank: AccountLoader<'info, Bank>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        seeds = [b"bank", 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub bank: AccountLoader<'info, Bank>,
    #[account(
        mut,
        seeds = [b"bank_vault".as_ref(), 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub bank_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"bank_vault_authority".as_ref(), 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    /// CHECK: this is the pda for the bank vault
    pub bank_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub market: AccountLoader<'info, Market>,
    #[account(
        mut,
        token::mint = bank_vault.mint
    )]
    pub recipient: Box<Account<'info, TokenAccount>>,
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
    /// CHECK: withdraw fails if this isn't vault owner
    #[account(
        constraint = &state.insurance_vault_authority.eq(&insurance_vault_authority.key())
    )]
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = insurance_vault.mint
    )]
    pub recipient: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawFromInsuranceVaultToMarket<'info> {
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub market: AccountLoader<'info, Market>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: withdraw fails if this isn't vault owner
    #[account(
        constraint = &state.insurance_vault_authority.eq(&insurance_vault_authority.key())
    )]
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"bank_vault".as_ref(), 0_u64.to_le_bytes().as_ref()],
        bump,
        token::mint = insurance_vault.mint
    )]
    pub bank_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OrderParams {
    pub order_type: OrderType,
    pub direction: PositionDirection,
    pub user_order_id: u8,
    pub quote_asset_amount: u128,
    pub base_asset_amount: u128,
    pub price: u128,
    pub market_index: u64,
    pub reduce_only: bool,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
    pub trigger_price: u128,
    pub trigger_condition: OrderTriggerCondition,
    pub optional_accounts: OrderParamsOptionalAccounts,
    pub position_limit: u128,
    pub oracle_price_offset: i128,
    pub padding0: bool,
    pub padding1: bool,
}

impl Default for OrderType {
    // UpOnly
    fn default() -> Self {
        OrderType::Limit
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OrderParamsOptionalAccounts {
    pub discount_token: bool,
    pub referrer: bool,
}

#[derive(Accounts)]
pub struct PlaceAndTake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceAndMake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    pub taker: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelAllOrders<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct TriggerOrder<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        seeds = [b"bank_vault".as_ref(), 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub bank_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"bank_vault_authority".as_ref(), 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    /// CHECK: this is the pda for the bank vault
    pub bank_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleFunding<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct UpdateFundingRate<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: checked in `update_funding_rate` ix constraint
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RepegCurve<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: checked in `repeg_curve` ix constraint
    pub oracle: AccountInfo<'info>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MoveAMMPrice<'info> {
    #[account(
        has_one = admin,
        constraint = state.admin_controls_prices
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub market: AccountLoader<'info, Market>,
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
    pub market: AccountLoader<'info, Market>,
    /// CHECK: checked in `admin_update_k` ix constraint
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdateMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub market: AccountLoader<'info, Market>,
}
