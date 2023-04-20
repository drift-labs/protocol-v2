use anchor_lang::{prelude::*, ToAccountInfo};
use anchor_spl::token::{Token, TokenAccount};
use arrayref::array_ref;
use phoenix::{
    program::{
        create_new_order_instruction_with_custom_token_accounts, load_with_dispatch, MarketHeader,
    },
    quantities::{BaseLots, QuoteLots, Ticks, WrapperU64},
    state::{OrderPacket, Side},
};
use solana_program::{msg, program::invoke_signed_unchecked};
use std::{cell::Ref, convert::TryInto, mem::size_of, ops::Deref};

use crate::{
    controller::position::PositionDirection,
    error::{DriftResult, ErrorCode},
    instructions::SpotFulfillmentType,
    load,
    math::{casting::Cast, safe_math::SafeMath, spot_withdraw::validate_spot_market_vault_amount},
    signer::get_signer_seeds,
    state::{
        events::OrderActionExplanation,
        spot_fulfillment_params::{ExternalSpotFill, SpotFulfillmentParams},
        spot_market::{SpotBalanceType, SpotFulfillmentConfigStatus, SpotMarket},
        state::State,
        traits::Size,
    },
    validate,
};

pub const PHOENIX_MARKET_DISCRIMINANT: u64 = 8167313896524341111;

pub fn taker_price_to_phoenix_price_in_ticks_rounded_down(
    taker_price: u64,
    tick_size: u64,
    header: &MarketHeader,
) -> DriftResult<Ticks> {
    taker_price
        .safe_mul(header.raw_base_units_per_base_unit as u64)?
        .safe_div((header.get_quote_lot_size().as_u64().safe_mul(tick_size))?)
        .map(Ticks::new)
}

pub fn taker_price_to_phoenix_price_in_ticks_rounded_up(
    taker_price: u64,
    tick_size: u64,
    header: &MarketHeader,
) -> DriftResult<Ticks> {
    taker_price
        .safe_mul(header.raw_base_units_per_base_unit as u64)?
        .safe_div_ceil((header.get_quote_lot_size().as_u64().safe_mul(tick_size))?)
        .map(Ticks::new)
}

pub fn phoenix_price_in_ticks_to_taker_price(
    price_in_ticks: u64,
    tick_size: u64,
    header: &MarketHeader,
) -> DriftResult<u64> {
    price_in_ticks
        .safe_mul(tick_size)?
        .safe_mul(header.get_quote_lot_size().as_u64())?
        .safe_div(header.raw_base_units_per_base_unit as u64)
}

pub fn compute_base_lot_size(
    taker_base_asset_amount: u64,
    taker_max_quote_asset_amount: u64,
    taker_price: u64,
    header: &MarketHeader,
) -> DriftResult<BaseLots> {
    Ok(taker_base_asset_amount
        .safe_div(header.get_base_lot_size().as_u64())
        .map(BaseLots::new)?
        .min(
            // Conversion:
            //     taker_max_quote_asset_amount (QA) * base_atoms_per_raw_base_unit (BA/rBU) / taker_price (QA/rBU) / base_lot_size (BA/BL)
            // Yields: num_base_lots (BL)
            taker_max_quote_asset_amount
                .cast::<u128>()?
                .safe_mul(10_u128.pow(header.base_params.decimals))?
                .safe_div(
                    taker_price
                        .cast::<u128>()?
                        .safe_mul(header.get_base_lot_size().as_u128())?,
                )?
                .cast::<u64>()
                .map(BaseLots::new)?,
        ))
}

#[account(zero_copy)]
#[derive(Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct PhoenixV1FulfillmentConfig {
    pub pubkey: Pubkey,
    pub phoenix_program_id: Pubkey,
    pub phoenix_log_authority: Pubkey,
    pub phoenix_market: Pubkey,
    pub phoenix_base_vault: Pubkey,
    pub phoenix_quote_vault: Pubkey,
    pub market_index: u16,
    pub fulfillment_type: SpotFulfillmentType,
    pub status: SpotFulfillmentConfigStatus,
    pub padding: [u8; 4],
}

impl Size for PhoenixV1FulfillmentConfig {
    const SIZE: usize = 208;
}

#[derive(Clone)]
pub struct PhoenixMarketContext<'a, 'b> {
    pub phoenix_market: &'a AccountInfo<'b>,
    pub header: MarketHeader,
}

impl<'a, 'b> PhoenixMarketContext<'a, 'b> {
    pub fn new(info: &'a AccountInfo<'b>) -> DriftResult<PhoenixMarketContext<'a, 'b>> {
        validate!(
            info.owner == &phoenix::id(),
            ErrorCode::InvalidPhoenixProgram,
            "Market must be owned by the Phoenix program",
        )?;
        let data = info.data.borrow();
        let header = bytemuck::try_from_bytes::<MarketHeader>(&data[..size_of::<MarketHeader>()])
            .map_err(|_| {
            msg!("Failed to parse Phoenix market header");
            ErrorCode::FailedToDeserializePhoenixMarket
        })?;
        validate!(
            header.discriminant == PHOENIX_MARKET_DISCRIMINANT,
            ErrorCode::InvalidPhoenixProgram,
            "Invalid market discriminant",
        )?;
        Ok(PhoenixMarketContext {
            phoenix_market: info,
            header: *header,
        })
    }

    pub fn to_phoenix_v1_fulfillment_config(
        &self,
        config_key: &Pubkey,
        market_index: u16,
    ) -> PhoenixV1FulfillmentConfig {
        PhoenixV1FulfillmentConfig {
            pubkey: *config_key,
            phoenix_program_id: phoenix::id(),
            phoenix_log_authority: phoenix::phoenix_log_authority::id(),
            phoenix_market: *self.phoenix_market.key,
            phoenix_base_vault: self.header.base_params.vault_key,
            phoenix_quote_vault: self.header.quote_params.vault_key,
            market_index,
            fulfillment_type: SpotFulfillmentType::PhoenixV1,
            status: SpotFulfillmentConfigStatus::Enabled,
            padding: [0; 4],
        }
    }
}

impl<'a, 'b> Deref for PhoenixMarketContext<'a, 'b> {
    type Target = AccountInfo<'b>;

    fn deref(&self) -> &Self::Target {
        self.phoenix_market
    }
}

#[derive(Clone)]
pub struct PhoenixFulfillmentParams<'a, 'b> {
    pub phoenix_program: &'a AccountInfo<'b>,
    pub phoenix_log_authority: &'a AccountInfo<'b>,
    pub phoenix_market: PhoenixMarketContext<'a, 'b>,
    pub drift_signer: &'a AccountInfo<'b>,
    pub phoenix_base_vault: &'a AccountInfo<'b>,
    pub phoenix_quote_vault: &'a AccountInfo<'b>,
    pub base_market_vault: Box<Account<'b, TokenAccount>>,
    pub quote_market_vault: Box<Account<'b, TokenAccount>>,
    pub token_program: Program<'b, Token>,
    pub signer_nonce: u8,
}

/// Constructor for PhoenixFulfillmentParams
impl<'a, 'b> PhoenixFulfillmentParams<'a, 'b> {
    #[allow(clippy::type_complexity)]
    pub fn new<'c>(
        account_info_iter: &'a mut std::iter::Peekable<std::slice::Iter<'c, AccountInfo<'b>>>,
        state: &State,
        base_market: &SpotMarket,
        quote_market: &SpotMarket,
    ) -> DriftResult<Self> {
        let account_info_vec = account_info_iter.collect::<Vec<_>>();
        let account_infos = array_ref![account_info_vec, 0, 10];
        let [phoenix_fulfillment_config, phoenix_program, phoenix_log_authority, phoenix_market, drift_signer, phoenix_base_vault, phoenix_quote_vault, base_market_vault, quote_market_vault, token_program] =
            account_infos;

        let phoenix_fulfillment_config_loader: AccountLoader<PhoenixV1FulfillmentConfig> =
            AccountLoader::try_from(phoenix_fulfillment_config).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?;
        let phoenix_fulfillment_config = load!(phoenix_fulfillment_config_loader)?;

        validate!(
            &phoenix_fulfillment_config.phoenix_program_id == phoenix_program.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            phoenix_log_authority.key == &phoenix::phoenix_log_authority::id(),
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            phoenix_fulfillment_config.status == SpotFulfillmentConfigStatus::Enabled,
            ErrorCode::SpotFulfillmentConfigDisabled
        )?;

        validate!(
            &state.signer == drift_signer.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            phoenix_fulfillment_config.market_index == base_market.market_index,
            ErrorCode::InvalidFulfillmentConfig,
            "config market index {} does not equal base asset index {}",
            phoenix_fulfillment_config.market_index,
            base_market.market_index
        )?;

        validate!(
            &base_market.vault == base_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &quote_market.vault == quote_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        let phoenix_market_context = PhoenixMarketContext::new(phoenix_market)?;

        validate!(
            &phoenix_fulfillment_config.phoenix_base_vault == phoenix_base_vault.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Phoenix base vault key does not match market header"
        )?;

        validate!(
            &phoenix_fulfillment_config.phoenix_quote_vault == phoenix_quote_vault.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Phoenix quote vault key does not match market header"
        )?;

        validate!(
            &phoenix_fulfillment_config.phoenix_market == phoenix_market.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        let base_market_vault: Box<Account<TokenAccount>> =
            Box::new(Account::try_from(base_market_vault).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?);
        let quote_market_vault: Box<Account<TokenAccount>> =
            Box::new(Account::try_from(quote_market_vault).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?);

        let token_program: Program<Token> = Program::try_from(token_program).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidFulfillmentConfig
        })?;

        Ok(PhoenixFulfillmentParams {
            drift_signer,
            phoenix_program,
            phoenix_market: phoenix_market_context,
            phoenix_log_authority,
            phoenix_base_vault,
            phoenix_quote_vault,
            token_program,
            base_market_vault,
            quote_market_vault,
            signer_nonce: state.signer_nonce,
        })
    }
}

impl<'a, 'b> PhoenixFulfillmentParams<'a, 'b> {
    pub fn to_account_infos(&self) -> [AccountInfo<'b>; 9] {
        [
            self.phoenix_program.clone(),
            self.phoenix_log_authority.clone(),
            self.phoenix_market.to_account_info(),
            self.drift_signer.clone(),
            self.base_market_vault.to_account_info(),
            self.quote_market_vault.to_account_info(),
            self.phoenix_base_vault.to_account_info(),
            self.phoenix_quote_vault.to_account_info(),
            self.token_program.to_account_info(),
        ]
    }
}

impl<'a, 'b> PhoenixFulfillmentParams<'a, 'b> {
    pub fn invoke_new_order(&self, order_packet: OrderPacket) -> DriftResult {
        let base_mint = self.phoenix_market.header.base_params.mint_key;
        let quote_mint = self.phoenix_market.header.quote_params.mint_key;

        let new_order_instruction = create_new_order_instruction_with_custom_token_accounts(
            self.phoenix_market.key,
            self.drift_signer.key,
            &self.base_market_vault.key(),
            &self.quote_market_vault.key(),
            &base_mint,
            &quote_mint,
            &order_packet,
        );

        let signer_seeds = get_signer_seeds(&self.signer_nonce);
        let signers_seeds = &[&signer_seeds[..]];

        invoke_signed_unchecked(
            &new_order_instruction,
            &self.to_account_infos(),
            signers_seeds,
        )
        .map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::FailedPhoenixCPI
        })?;

        Ok(())
    }
}

impl<'a, 'b> SpotFulfillmentParams for PhoenixFulfillmentParams<'a, 'b> {
    fn is_external(&self) -> bool {
        true
    }

    fn get_best_bid_and_ask(&self) -> DriftResult<(Option<u64>, Option<u64>)> {
        let market_data = self.phoenix_market.data.borrow();
        let (_, market_bytes) = market_data.split_at(size_of::<MarketHeader>());
        let header = &self.phoenix_market.header;
        if header.quote_params.decimals != 6 {
            msg!("Quote decimals must be 6");
            return Err(ErrorCode::InvalidPricePrecision);
        }

        let market = load_with_dispatch(&header.market_size_params, market_bytes)
            .map_err(|_| {
                msg!("Failed to deserialize market");
                ErrorCode::FailedToDeserializePhoenixMarket
            })?
            .inner;

        // Conversion: price_in_ticks (T) * tick_size (QL/(BU * T)) * quote_lot_size (QA/QL) / raw_base_units_per_base_unit (rBU/BU)
        // Yields: price (QA/rBU)
        let best_bid = market.get_book(Side::Bid).iter().next().and_then(|(o, _)| {
            phoenix_price_in_ticks_to_taker_price(
                o.price_in_ticks.as_u64(),
                market.get_tick_size().as_u64(),
                header,
            )
            .ok()
        });
        let best_ask = market.get_book(Side::Ask).iter().next().and_then(|(o, _)| {
            phoenix_price_in_ticks_to_taker_price(
                o.price_in_ticks.as_u64(),
                market.get_tick_size().as_u64(),
                header,
            )
            .ok()
        });
        Ok((best_bid, best_ask))
    }

    fn fulfill_order(
        &mut self,
        taker_direction: PositionDirection,
        taker_price: u64,
        taker_base_asset_amount: u64,
        taker_max_quote_asset_amount: u64,
    ) -> DriftResult<ExternalSpotFill> {
        let market_data = self.phoenix_market.data.borrow();
        let (_, market_bytes) = market_data.split_at(size_of::<MarketHeader>());
        let header = &self.phoenix_market.header;
        let market_size_params = header.market_size_params;
        let market = load_with_dispatch(&market_size_params, market_bytes)
            .map_err(|_| {
                msg!("Failed to deserialize market");
                ErrorCode::FailedToDeserializePhoenixMarket
            })?
            .inner;

        // The price in ticks is rounded down for longs and rounded up for shorts
        let (side, price_in_ticks) = match taker_direction {
            PositionDirection::Long => (
                phoenix::state::Side::Bid,
                taker_price_to_phoenix_price_in_ticks_rounded_down(
                    taker_price,
                    market.get_tick_size().as_u64(),
                    header,
                )?,
            ),
            PositionDirection::Short => (
                phoenix::state::Side::Ask,
                taker_price_to_phoenix_price_in_ticks_rounded_up(
                    taker_price,
                    market.get_tick_size().as_u64(),
                    header,
                )?,
            ),
        };

        if price_in_ticks == Ticks::ZERO {
            msg!("Price is too low");
            return Ok(ExternalSpotFill::empty());
        }

        // This takes the minimum of
        // 1. The number of base lots equivalent to the given base asset amount.
        // 2. The number of base lots that can be bought with the max quote asset amount at the given taker price.
        let num_base_lots = compute_base_lot_size(
            taker_base_asset_amount,
            taker_max_quote_asset_amount,
            taker_price,
            header,
        )?;

        if num_base_lots == 0 {
            msg!("No base lots to fill");
            return Ok(ExternalSpotFill::empty());
        }

        let phoenix_order = OrderPacket::ImmediateOrCancel {
            side,
            price_in_ticks: Some(price_in_ticks),
            num_base_lots,
            num_quote_lots: QuoteLots::ZERO,
            min_base_lots_to_fill: BaseLots::ZERO,
            min_quote_lots_to_fill: QuoteLots::ZERO,
            self_trade_behavior: phoenix::state::SelfTradeBehavior::Abort,
            match_limit: Some(64),
            client_order_id: u128::from_le_bytes(
                self.drift_signer.key.as_ref()[..16]
                    .try_into()
                    .map_err(|_| {
                        msg!("Failed to convert client order id");
                        ErrorCode::FailedPhoenixCPI
                    })?,
            ),
            use_only_deposited_funds: false,
            // TIF parameters
            last_valid_slot: None,
            last_valid_unix_timestamp_in_seconds: None,
        };

        let market_accrued_fees_before = market.get_uncollected_fee_amount().as_u64();
        let base_before = self.base_market_vault.amount;
        let quote_before = self.quote_market_vault.amount;

        drop(market_data);
        self.invoke_new_order(phoenix_order)?;

        // Reload market data
        let market_data = self.phoenix_market.data.borrow();
        let (_, market_bytes) = market_data.split_at(size_of::<MarketHeader>());

        self.base_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload base_market_vault");
            ErrorCode::FailedPhoenixCPI
        })?;
        self.quote_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload quote_market_vault");
            ErrorCode::FailedPhoenixCPI
        })?;

        let base_after = self.base_market_vault.amount;
        let quote_after = self.quote_market_vault.amount;
        let market_accrued_fees_after = load_with_dispatch(&market_size_params, market_bytes)
            .map_err(|_| {
                msg!("Failed to deserialize market");
                ErrorCode::FailedToDeserializePhoenixMarket
            })?
            .inner
            .get_uncollected_fee_amount()
            .as_u64();

        let (base_update_direction, base_asset_amount_filled) = if base_after > base_before {
            (SpotBalanceType::Deposit, base_after.safe_sub(base_before)?)
        } else {
            (SpotBalanceType::Borrow, base_before.safe_sub(base_after)?)
        };

        if base_asset_amount_filled == 0 {
            msg!("No base filled on serum");
            return Ok(ExternalSpotFill::empty());
        }

        let phoenix_fee = market_accrued_fees_after.safe_sub(market_accrued_fees_before)?;

        let (quote_update_direction, quote_asset_amount_filled) =
            if base_update_direction == SpotBalanceType::Borrow {
                let quote_asset_amount_delta = quote_after.safe_sub(quote_before)?;
                (
                    SpotBalanceType::Deposit,
                    quote_asset_amount_delta.safe_add(phoenix_fee)?,
                )
            } else {
                let quote_asset_amount_delta = quote_before.safe_sub(quote_after)?;
                (
                    SpotBalanceType::Borrow,
                    quote_asset_amount_delta.safe_sub(phoenix_fee)?,
                )
            };

        Ok(ExternalSpotFill {
            base_asset_amount_filled,
            quote_asset_amount_filled,
            base_update_direction,
            quote_update_direction,
            fee: phoenix_fee,
            unsettled_referrer_rebate: 0,
            settled_referrer_rebate: 0,
        })
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Ok(OrderActionExplanation::OrderFillWithPhoenix)
    }

    // Note: this trait method still feels a little out of place
    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult {
        validate_spot_market_vault_amount(base_market, self.base_market_vault.amount)?;
        validate_spot_market_vault_amount(quote_market, self.quote_market_vault.amount)?;
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use anchor_lang::prelude::Pubkey;
    use phoenix::{
        program::{MarketHeader, MarketSizeParams, TokenParams},
        quantities::{
            BaseAtomsPerBaseLot, QuoteAtomsPerBaseUnitPerTick, QuoteAtomsPerQuoteLot, Ticks,
            WrapperU64,
        },
    };

    use crate::state::fulfillment_params::phoenix::{
        compute_base_lot_size, phoenix_price_in_ticks_to_taker_price,
        taker_price_to_phoenix_price_in_ticks_rounded_down,
        taker_price_to_phoenix_price_in_ticks_rounded_up,
    };

    fn setup() -> MarketHeader {
        // Creates a market header with a similar configuration to the SOL/USDC mainnet-beta Phoenix market
        MarketHeader::new(
            MarketSizeParams {
                bids_size: 2048,
                asks_size: 2048,
                num_seats: 4097,
            },
            TokenParams {
                decimals: 9,
                vault_bump: 255,
                mint_key: Pubkey::new_unique(),
                vault_key: Pubkey::new_unique(),
            },
            BaseAtomsPerBaseLot::new(1_000_000),
            TokenParams {
                decimals: 6,
                vault_bump: 255,
                mint_key: Pubkey::new_unique(),
                vault_key: Pubkey::new_unique(),
            },
            QuoteAtomsPerQuoteLot::new(1),
            QuoteAtomsPerBaseUnitPerTick::new(1000),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            1,
        )
    }

    #[test]
    fn test_tick_price_to_quote_atoms_per_raw_base_unit() {
        let header = setup();
        let tick_size = header.get_tick_size_in_quote_atoms_per_base_unit().as_u64()
            / header.get_quote_lot_size().as_u64();

        // Tick is 0.001 USDC/SOL
        assert_eq!(tick_size, 1000);
        assert_eq!(
            tick_size as f64 * 10.0_f64.powf(-(header.quote_params.decimals as f64)),
            0.001
        );

        let target_price = 23.128;
        let target_price_in_quote_atoms_per_raw_base_unit =
            (target_price * 10.0_f64.powf(header.quote_params.decimals as f64)) as u64;

        assert_eq!(target_price_in_quote_atoms_per_raw_base_unit, 23128000);

        let target_price_in_ticks = target_price_in_quote_atoms_per_raw_base_unit / tick_size;

        let converted_price =
            phoenix_price_in_ticks_to_taker_price(target_price_in_ticks, tick_size, &header)
                .unwrap();

        assert_eq!(
            converted_price,
            target_price_in_quote_atoms_per_raw_base_unit
        );
    }

    #[test]
    fn test_price_in_quote_atoms_per_raw_base_unit_to_ticks() {
        let header = setup();
        let tick_size = header.get_tick_size_in_quote_atoms_per_base_unit().as_u64()
            / header.get_quote_lot_size().as_u64();

        let taker_price = 23809812;

        let sell_limit_price_in_ticks =
            taker_price_to_phoenix_price_in_ticks_rounded_up(taker_price, tick_size, &header)
                .unwrap();

        let buy_limit_price_in_ticks =
            taker_price_to_phoenix_price_in_ticks_rounded_down(taker_price, tick_size, &header)
                .unwrap();

        assert_eq!(
            sell_limit_price_in_ticks,
            buy_limit_price_in_ticks + Ticks::new(1)
        );
        assert_eq!(buy_limit_price_in_ticks, 23809);

        // If the price is a multiple of the tick size, the buy and sell limit prices should be the same
        let taker_price = 24123000;
        let sell_limit_price_in_ticks =
            taker_price_to_phoenix_price_in_ticks_rounded_up(taker_price, tick_size, &header)
                .unwrap();

        let buy_limit_price_in_ticks =
            taker_price_to_phoenix_price_in_ticks_rounded_down(taker_price, tick_size, &header)
                .unwrap();

        assert_eq!(sell_limit_price_in_ticks, buy_limit_price_in_ticks);
        assert_eq!(buy_limit_price_in_ticks, 24123);
    }

    #[test]
    fn test_compute_base_lots() {
        let header = setup();
        let taker_price = 23809000;

        // 55 SOL
        let taker_base_asset_amount = 55 * 1_000_000_000;
        let taker_max_quote_asset_amount = u64::MAX;

        let num_base_lots = compute_base_lot_size(
            taker_base_asset_amount,
            taker_max_quote_asset_amount,
            taker_price,
            &header,
        )
        .unwrap();
        assert_eq!(num_base_lots, 55000);
        assert_eq!(
            55000,
            55 * 10_u64.pow(header.base_params.decimals) / header.get_base_lot_size().as_u64(),
        );

        let taker_base_asset_amount = u64::MAX;

        // 2357.091 USDC
        let taker_max_quote_asset_amount = 2357091000_u64;

        let num_base_lots = compute_base_lot_size(
            taker_base_asset_amount,
            taker_max_quote_asset_amount,
            taker_price,
            &header,
        )
        .unwrap();

        assert_eq!(num_base_lots, 99000);
        assert_eq!(
            99000,
            99 * 10_u64.pow(header.base_params.decimals) / header.get_base_lot_size().as_u64(),
        );
    }
}
