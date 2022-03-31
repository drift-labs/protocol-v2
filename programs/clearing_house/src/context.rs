use anchor_lang::{prelude::*, AnchorDeserialize, AnchorSerialize};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::controller::position::PositionDirection;
use crate::state::history::curve::{CurveHistory, ExtendedCurveHistory};
use crate::state::history::deposit::DepositHistory;
use crate::state::history::funding_rate::FundingRateHistory;
use crate::state::history::liquidation::LiquidationHistory;
use crate::state::history::order_history::OrderHistory;
use crate::state::history::{funding_payment::FundingPaymentHistory, trade::TradeHistory};
use crate::state::market::Markets;
use crate::state::order_state::OrderState;
use crate::state::state::State;
use crate::state::user::{User, UserPositions};
use crate::state::user_orders::{OrderTriggerCondition, OrderType, UserOrders};

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
    pub markets: AccountLoader<'info, Markets>,
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
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(zero)]
    pub trade_history: AccountLoader<'info, TradeHistory>,
    #[account(zero)]
    pub liquidation_history: AccountLoader<'info, LiquidationHistory>,
    #[account(zero)]
    pub deposit_history: AccountLoader<'info, DepositHistory>,
    #[account(zero)]
    pub funding_rate_history: AccountLoader<'info, FundingRateHistory>,
    #[account(zero)]
    pub curve_history: AccountLoader<'info, ExtendedCurveHistory>,
}

#[derive(Accounts)]
#[instruction(
    order_house_nonce: u8,
)]
pub struct InitializeOrderState<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        init,
        seeds = [b"order_state".as_ref()],
        bump = order_house_nonce,
        payer = admin
    )]
    pub order_state: Box<Account<'info, OrderState>>,
    #[account(zero)]
    pub order_history: AccountLoader<'info, OrderHistory>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
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
    pub state: Box<Account<'info, State>>,
    #[account(
        init,
        payer = authority,
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_nonce: u8)]
pub struct InitializeUserWithExplicitPayer<'info> {
    #[account(
        init,
        seeds = [b"user", authority.key.as_ref()],
        bump = user_nonce,
        payer = payer
    )]
    pub user: Box<Account<'info, User>>,
    pub state: Box<Account<'info, State>>,
    #[account(
        init,
        payer = payer,
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_orders_nonce: u8)]
pub struct InitializeUserOrders<'info> {
    #[account(
        has_one = authority,
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        init,
        seeds = [b"user_orders", user.key().as_ref()],
        bump = user_orders_nonce,
        payer = authority
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_orders_nonce: u8)]
pub struct InitializeUserOrdersWithExplicitPayer<'info> {
    #[account(
        has_one = authority,
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        init,
        seeds = [b"user_orders", user.key().as_ref()],
        bump = user_orders_nonce,
        payer = payer
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeleteUser<'info> {
    #[account(
        mut,
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key()),
        close = authority
    )]
    pub user: Account<'info, User>,
    #[account(
        mut,
        has_one = user,
        close = authority
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        has_one = user,
        close = authority
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    pub authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct InitializeUserOptionalAccounts {
    pub whitelist_token: bool,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key())
    )]
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
    #[account(
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &state.deposit_history.eq(&deposit_history.key())
    )]
    pub deposit_history: AccountLoader<'info, DepositHistory>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = &state.collateral_vault_authority.eq(&collateral_vault_authority.key())
    )]
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = &state.insurance_vault_authority.eq(&insurance_vault_authority.key())
    )]
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub user_collateral_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &state.deposit_history.eq(&deposit_history.key())
    )]
    pub deposit_history: AccountLoader<'info, DepositHistory>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = &state.collateral_vault_authority.eq(&collateral_vault_authority.key())
    )]
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(mut)]
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
    #[account(
        constraint = &state.insurance_vault_authority.eq(&insurance_vault_authority.key())
    )]
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(mut)]
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
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = &state.insurance_vault_authority.eq(&insurance_vault_authority.key())
    )]
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ManagePositionOptionalAccounts {
    pub discount_token: bool,
    pub referrer: bool,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        constraint = &state.trade_history.eq(&trade_history.key())
    )]
    pub trade_history: AccountLoader<'info, TradeHistory>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &state.funding_rate_history.eq(&funding_rate_history.key())
    )]
    pub funding_rate_history: AccountLoader<'info, FundingRateHistory>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        constraint = &state.order_state.eq(&order_state.key())
    )]
    pub order_state: Box<Account<'info, OrderState>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority
    )]
    pub filler: Box<Account<'info, User>>,
    #[account(
        mut,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    #[account(
        mut,
        constraint = &state.trade_history.eq(&trade_history.key())
    )]
    pub trade_history: AccountLoader<'info, TradeHistory>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &state.funding_rate_history.eq(&funding_rate_history.key())
    )]
    pub funding_rate_history: AccountLoader<'info, FundingRateHistory>,
    #[account(
        mut,
        constraint = &order_state.order_history.eq(&order_history.key())
    )]
    pub order_history: AccountLoader<'info, OrderHistory>,
    #[account(
        mut,
        constraint = &state.extended_curve_history.eq(&extended_curve_history.key())
    )]
    pub extended_curve_history: AccountLoader<'info, ExtendedCurveHistory>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        constraint = &state.order_state.eq(&order_state.key())
    )]
    pub order_state: Box<Account<'info, OrderState>>,
    #[account(
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &order_state.order_history.eq(&order_history.key())
    )]
    pub order_history: AccountLoader<'info, OrderHistory>,
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
pub struct PlaceAndFillOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        constraint = &state.order_state.eq(&order_state.key())
    )]
    pub order_state: Box<Account<'info, OrderState>>,
    #[account(
        mut,
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &state.trade_history.eq(&trade_history.key())
    )]
    pub trade_history: AccountLoader<'info, TradeHistory>,
    #[account(
        mut,
        constraint = &state.funding_rate_history.eq(&funding_rate_history.key())
    )]
    pub funding_rate_history: AccountLoader<'info, FundingRateHistory>,
    #[account(
        mut,
        constraint = &order_state.order_history.eq(&order_history.key())
    )]
    pub order_history: AccountLoader<'info, OrderHistory>,
    #[account(
        mut,
        constraint = &state.extended_curve_history.eq(&extended_curve_history.key())
    )]
    pub extended_curve_history: AccountLoader<'info, ExtendedCurveHistory>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        constraint = &state.order_state.eq(&order_state.key())
    )]
    pub order_state: Box<Account<'info, OrderState>>,
    #[account(
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &order_state.order_history.eq(&order_history.key())
    )]
    pub order_history: AccountLoader<'info, OrderHistory>,
}

#[derive(Accounts)]
pub struct ExpireOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        constraint = &state.order_state.eq(&order_state.key())
    )]
    pub order_state: Box<Account<'info, OrderState>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority
    )]
    pub filler: Box<Account<'info, User>>,
    #[account(
        mut,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_orders: AccountLoader<'info, UserOrders>,
    #[account(
        mut,
        constraint = &order_state.order_history.eq(&order_history.key())
    )]
    pub order_history: AccountLoader<'info, OrderHistory>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        constraint = &state.trade_history.eq(&trade_history.key())
    )]
    pub trade_history: AccountLoader<'info, TradeHistory>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
    #[account(
        mut,
        constraint = &state.funding_rate_history.eq(&funding_rate_history.key())
    )]
    pub funding_rate_history: AccountLoader<'info, FundingRateHistory>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority
    )]
    pub liquidator: Box<Account<'info, User>>,
    #[account(
        mut,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = &state.collateral_vault_authority.eq(&collateral_vault_authority.key())
    )]
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = &state.insurance_vault_authority.eq(&insurance_vault_authority.key())
    )]
    pub insurance_vault_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        constraint = &state.trade_history.eq(&trade_history.key())
    )]
    pub trade_history: AccountLoader<'info, TradeHistory>,
    #[account(
        mut,
        constraint = &state.liquidation_history.eq(&liquidation_history.key())
    )]
    pub liquidation_history: AccountLoader<'info, LiquidationHistory>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct SettleFunding<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = &user.positions.eq(&user_positions.key())
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: AccountLoader<'info, UserPositions>,
    #[account(
        mut,
        constraint = &state.funding_payment_history.eq(&funding_payment_history.key())
    )]
    pub funding_payment_history: AccountLoader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct UpdateFundingRate<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.funding_rate_history.eq(&funding_rate_history.key())
    )]
    pub funding_rate_history: AccountLoader<'info, FundingRateHistory>,
}

#[derive(Accounts)]
pub struct RepegCurve<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.extended_curve_history.eq(&curve_history.key())
    )]
    pub curve_history: AccountLoader<'info, ExtendedCurveHistory>,
}

#[derive(Accounts)]
pub struct MoveAMMPrice<'info> {
    #[account(
        has_one = admin,
        constraint = state.admin_controls_prices
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
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
pub struct AdminUpdateOrderState<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = &state.order_state.eq(&order_state.key())
    )]
    pub order_state: Box<Account<'info, OrderState>>,
}

#[derive(Accounts)]
pub struct AdminUpdateK<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.extended_curve_history.eq(&curve_history.key())
    )]
    pub curve_history: AccountLoader<'info, ExtendedCurveHistory>,
}

#[derive(Accounts)]
pub struct AdminUpdateMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = &state.markets.eq(&markets.key())
    )]
    pub markets: AccountLoader<'info, Markets>,
}

#[derive(Accounts)]
pub struct UpdateCurveHistory<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(zero)]
    pub extended_curve_history: AccountLoader<'info, ExtendedCurveHistory>,
    #[account(
        constraint = &state.curve_history.eq(&curve_history.key())
    )]
    pub curve_history: AccountLoader<'info, CurveHistory>,
}
