use anchor_lang::{prelude::*, AnchorDeserialize, AnchorSerialize};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::controller::position::PositionDirection;
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::market::PerpMarket;
use crate::state::spot_market::{SerumV3FulfillmentConfig, SpotMarket};
use crate::state::state::State;
use crate::state::user::{MarketType, OrderTriggerCondition, OrderType, User, UserStats};

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
        token::authority = clearing_house_signer
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked in `initialize`
    pub clearing_house_signer: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeSpotMarket<'info> {
    #[account(
        init,
        seeds = [b"spot_market", state.number_of_spot_markets.to_le_bytes().as_ref()],
        space = std::mem::size_of::<SpotMarket>() + 8,
        bump,
        payer = admin
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    pub spot_market_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        seeds = [b"spot_market_vault".as_ref(), state.number_of_spot_markets.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = clearing_house_signer
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        seeds = [b"insurance_fund_vault".as_ref(), state.number_of_spot_markets.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = clearing_house_signer
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: program signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    /// CHECK: checked in `initialize_spot_market`
    pub oracle: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u64)]
pub struct InitializeSerumFulfillmentConfig<'info> {
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub base_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        seeds = [b"spot_market", 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub quote_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    /// CHECK: checked in ix
    pub serum_program: AccountInfo<'info>,
    /// CHECK: checked in ix
    pub serum_market: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"serum_open_orders".as_ref(), serum_market.key.as_ref()],
        bump,
    )]
    /// CHECK: checked in ix
    pub serum_open_orders: AccountInfo<'info>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: program signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        init,
        seeds = [b"serum_fulfillment_config".as_ref(), serum_market.key.as_ref()],
        space = std::mem::size_of::<SerumV3FulfillmentConfig>() + 8,
        bump,
        payer = admin,
    )]
    pub serum_fulfillment_config: AccountLoader<'info, SerumV3FulfillmentConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeUserStats<'info> {
    #[account(
        init,
        seeds = [b"user_stats", authority.key.as_ref()],
        space = std::mem::size_of::<UserStats>() + 8,
        bump,
        payer = payer
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
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
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    user_id: u8,
)]
pub struct UpdateUser<'info> {
    #[account(
        mut,
        seeds = [b"user", authority.key.as_ref(), user_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
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
        space = std::mem::size_of::<PerpMarket>() + 8,
        bump,
        payer = admin
    )]
    pub market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `initialize_market`
    pub oracle: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_index: u64,)]
pub struct Deposit<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &spot_market_vault.mint.eq(&user_token_account.mint),
        token::authority = authority
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u64,)]
pub struct Withdraw<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &spot_market_vault.mint.eq(&user_token_account.mint)
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
#[instruction(market_index: u64,)]
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
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
pub struct UpdateSpotMarketCumulativeInterest<'info> {
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
}

#[derive(Accounts)]
pub struct WithdrawFromMarketToInsuranceVault<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        seeds = [b"spot_market", 0_u64.to_le_bytes().as_ref()],
        bump,
        mut
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: program signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    #[account(
        mut,
        token::mint = spot_market_vault.mint
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
    #[account(
    constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: withdraw fails if this isn't vault owner
    pub clearing_house_signer: AccountInfo<'info>,
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
    pub market: AccountLoader<'info, PerpMarket>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: withdraw fails if this isn't vault owner
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"spot_market", 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub quote_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), 0_u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleLP<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct AddRemoveLiquidity<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&filler, &authority)?
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&filler, &filler_stats)?
    )]
    pub filler_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub enum SpotFulfillmentType {
    SerumV3,
    None,
}

impl Default for SpotFulfillmentType {
    fn default() -> Self {
        SpotFulfillmentType::SerumV3
    }
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OrderParams {
    pub order_type: OrderType,
    pub market_type: MarketType,
    pub direction: PositionDirection,
    pub user_order_id: u8,
    pub base_asset_amount: u128,
    pub price: u128,
    pub market_index: u64,
    pub reduce_only: bool,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
    pub trigger_price: u128,
    pub trigger_condition: OrderTriggerCondition,
    pub oracle_price_offset: i128,
    pub auction_duration: Option<u8>,
    pub time_in_force: Option<u8>,
    pub auction_start_price: Option<u128>,
}

impl Default for OrderType {
    fn default() -> Self {
        OrderType::Limit
    }
}

#[derive(Accounts)]
pub struct PlaceAndTake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceAndMake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub taker: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&taker, &taker_stats)?
    )]
    pub taker_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelAllOrders<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
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
        constraint = can_sign_for_user(&filler, &authority)?
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct LiquidatePerp<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&liquidator, &liquidator_stats)?
    )]
    pub liquidator_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct LiquidateBorrow<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct LiquidateBorrowForPerpPnl<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct LiquidatePerpPnlForDeposit<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
#[instruction(spot_market_index: u64,)]
pub struct ResolveBankruptcy<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()], // todo: market_index=0 hardcode for perps?
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(spot_market_index: u64,)]
pub struct ResolvePerpPnlDeficit<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()], // todo: market_index=0 hardcode for perps?
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
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
    pub market: AccountLoader<'info, PerpMarket>,
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
    pub market: AccountLoader<'info, PerpMarket>,
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
    pub perp_market: AccountLoader<'info, PerpMarket>,
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
    pub market: AccountLoader<'info, PerpMarket>,
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
    pub market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct AdminUpdateSpotMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
}

#[derive(Accounts)]
#[instruction(
    market_index: u64,
)]
pub struct InitializeInsuranceFundStake<'info> {
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        init,
        seeds = [b"insurance_fund_stake", authority.key.as_ref(), market_index.to_le_bytes().as_ref()],
        space = std::mem::size_of::<InsuranceFundStake>() + 8,
        bump,
        payer = payer
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_index: u64,)]
pub struct SettleRevenueToInsuranceFund<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u64)]
pub struct AddInsuranceFundStake<'info> {
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = insurance_fund_vault.mint,
        token::authority = authority
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u64,)]
pub struct RequestRemoveInsuranceFundStake<'info> {
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
#[instruction(market_index: u64,)]
pub struct RemoveInsuranceFundStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = insurance_fund_vault.mint,
        token::authority = authority
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateUserQuoteAssetInsuranceStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        seeds = [b"spot_market", 0_u64.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), 0_u64.to_le_bytes().as_ref()],
    bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
}

fn can_sign_for_user(user: &AccountLoader<User>, signer: &Signer) -> Result<bool> {
    user.load().map(|user| {
        user.authority.eq(signer.key)
            || (user.delegate.eq(signer.key) && !user.delegate.eq(&Pubkey::default()))
    })
}

fn is_stats_for_user(
    user: &AccountLoader<User>,
    user_stats: &AccountLoader<UserStats>,
) -> Result<bool> {
    let user = user.load()?;
    let user_stats = user_stats.load()?;
    Ok(user_stats.authority.eq(&user.authority))
}
