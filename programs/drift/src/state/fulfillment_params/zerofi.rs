#![allow(unused)] // unused when target_os is not solana
use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::instructions::SpotFulfillmentType;
use crate::math::casting::Cast;
use crate::math::constants::PRICE_TO_QUOTE_PRECISION_RATIO;
use crate::math::safe_math::SafeMath;
use crate::math::serum::{
    calculate_price_from_serum_limit_price, calculate_serum_limit_price,
    calculate_serum_max_coin_qty,
};
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::signer::get_signer_seeds;
use crate::state::events::OrderActionExplanation;
use crate::state::load_ref::load_ref;
use crate::state::spot_fulfillment_params::{ExternalSpotFill, SpotFulfillmentParams};
use crate::state::spot_market::{SpotBalanceType, SpotFulfillmentConfigStatus, SpotMarket};
use crate::state::state::State;
use crate::state::traits::Size;
use crate::{load, load_mut, validate};
use anchor_lang::prelude::*;
use anchor_lang::prelude::{Account, Program, System};
use anchor_lang::{account, Discriminator, InstructionData, Key};
use anchor_spl::token::{Token, TokenAccount};
use arrayref::array_ref;
use solana_program::account_info::AccountInfo;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::program::invoke_signed_unchecked;
use solana_program::pubkey::Pubkey;
use std::cell::Ref;
use std::convert::TryFrom;

pub mod zerofi_program_id {
    anchor_lang::declare_id!("ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY");
}

#[account(zero_copy(unsafe))]
#[derive(Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct ZerofiFulfillmentConfig {
    pub pubkey: Pubkey,                        // 32
    pub zerofi_program_id: Pubkey,             // 64
    pub zerofi_market: Pubkey,                 // 96
    pub zerofi_vault_base: Pubkey,             // 128
    pub zerofi_vault_base_info: Pubkey,        // 160
    pub zerofi_vault_quote: Pubkey,            // 192
    pub zerofi_vault_quote_info: Pubkey,       // 224
    pub market_index: u16,                     // 256
    pub fulfillment_type: SpotFulfillmentType, // 258
    pub status: SpotFulfillmentConfigStatus,   // 259
    pub padding: [u8; 4],                      // 260
}

impl Size for ZerofiFulfillmentConfig {
    const SIZE: usize = 264;
}

pub struct ZerofiContext<'a, 'b> {
    pub zerofi_program: &'a AccountInfo<'b>,
    pub zerofi_market: &'a AccountInfo<'b>,
}

#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct Market {
    pub discriminator: u64,
    pub _config_authority: Pubkey,
    pub _update_authority: Pubkey,
    pub mint_base: Pubkey,
    pub mint_quote: Pubkey,
    pub vault_base: Pubkey,
    pub vault_base_info: Pubkey,
    pub vault_quote: Pubkey,
    pub vault_quote_info: Pubkey,
}

impl Market {
    pub fn load_ref<'a>(account_info: &'a AccountInfo) -> Result<Ref<'a, Self>> {
        use anchor_lang::error::ErrorCode;
        let data = account_info.try_borrow_data()?;
        let market: Ref<Market> = Ref::map(data, |data| {
            bytemuck::from_bytes(&data[..std::mem::size_of::<Market>()])
        });
        if market.discriminator != 4 {
            return Err(ErrorCode::AccountDiscriminatorMismatch.into());
        }
        Ok(market)
    }
}

impl<'a, 'b> ZerofiContext<'a, 'b> {
    pub fn load_zerofi_market(&self) -> DriftResult<Ref<'a, Market>> {
        let market =
            Market::load_ref(self.zerofi_market).map_err(|_| ErrorCode::FailedZerofiCPI)?;
        Ok(market)
    }

    pub fn to_zerofi_fulfillment_config(
        &self,
        zerofi_fulfillment_config_key: &Pubkey,
        market_index: u16,
    ) -> DriftResult<ZerofiFulfillmentConfig> {
        let market = self
            .load_zerofi_market()
            .map_err(|_| ErrorCode::FailedZerofiCPI)?;
        Ok(ZerofiFulfillmentConfig {
            pubkey: *zerofi_fulfillment_config_key,
            zerofi_program_id: *self.zerofi_program.key,
            zerofi_market: *self.zerofi_market.key,
            zerofi_vault_base: market.vault_base,
            zerofi_vault_base_info: market.vault_base_info,
            zerofi_vault_quote: market.vault_quote,
            zerofi_vault_quote_info: market.vault_quote_info,
            market_index,
            fulfillment_type: SpotFulfillmentType::Zerofi,
            status: SpotFulfillmentConfigStatus::Enabled,
            padding: [0; 4],
        })
    }
}

pub struct ZerofiFulfillmentParams<'a, 'b> {
    pub drift_signer: &'a AccountInfo<'b>, // same as penalty payer
    pub zerofi_context: ZerofiContext<'a, 'b>,
    pub zerofi_vault_base: &'a AccountInfo<'b>,
    pub zerofi_vault_base_info: &'a AccountInfo<'b>,
    pub zerofi_vault_quote: &'a AccountInfo<'b>,
    pub zerofi_vault_quote_info: &'a AccountInfo<'b>,
    pub base_market_vault: Box<Account<'b, TokenAccount>>,
    pub quote_market_vault: Box<Account<'b, TokenAccount>>,
    pub token_program: Program<'b, Token>,
    pub instructions_sysvar: &'a AccountInfo<'b>,
    pub signer_nonce: u8,
    pub now: i64,
    pub base_precision: u64,
}

impl<'a, 'b> ZerofiFulfillmentParams<'a, 'b> {
    #[allow(clippy::type_complexity)]
    pub fn new<'c: 'b>(
        account_info_iter: &'a mut std::iter::Peekable<std::slice::Iter<'c, AccountInfo<'b>>>,
        state: &State,
        base_market: &SpotMarket,
        quote_market: &SpotMarket,
        now: i64,
    ) -> DriftResult<Self> {
        let account_info_vec = account_info_iter.collect::<Vec<_>>();
        let account_infos = array_ref![account_info_vec, 0, 12];
        let [zerofi_fulfillment_config, drift_signer, zerofi_program, zerofi_market, zerofi_vault_base_info, zerofi_vault_quote_info, zerofi_vault_base, zerofi_vault_quote, base_market_vault, quote_market_vault, token_program, instructions_sysvar] =
            account_infos;

        validate!(
            &state.signer == drift_signer.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;
        validate!(
            &base_market.vault == base_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;
        validate!(
            &quote_market.vault == quote_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        let zerofi_fulfillment_config_loader: AccountLoader<ZerofiFulfillmentConfig> =
            AccountLoader::try_from(zerofi_fulfillment_config).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?;
        let zerofi_fulfillment_config = load!(zerofi_fulfillment_config_loader)?;

        validate!(
            zerofi_fulfillment_config.market_index == base_market.market_index,
            ErrorCode::InvalidFulfillmentConfig,
            "config market index {} does not equal base asset index {}",
            zerofi_fulfillment_config.market_index,
            base_market.market_index
        )?;

        validate!(
            zerofi_market.key == &zerofi_fulfillment_config.zerofi_market,
            ErrorCode::InvalidFulfillmentConfig,
            "Zerofi market key does not match"
        )?;

        // loading market data, validating discriminator
        let market = Market::load_ref(zerofi_market).map_err(|_| ErrorCode::FailedZerofiCPI)?;

        validate!(
            zerofi_fulfillment_config.status == SpotFulfillmentConfigStatus::Enabled,
            ErrorCode::SpotFulfillmentConfigDisabled
        )?;

        validate!(
            &zerofi_fulfillment_config.zerofi_program_id == zerofi_market.owner,
            ErrorCode::FailedZerofiCPI,
            "market owner {} needs to be equal to {}!",
            zerofi_market.owner,
            zerofi_fulfillment_config.zerofi_program_id
        );
        validate!(
            &zerofi_fulfillment_config.zerofi_program_id == zerofi_program.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &market.vault_base_info == zerofi_vault_base_info.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Zerofi vault info base key does not match"
        )?;

        validate!(
            &market.vault_quote_info == zerofi_vault_quote_info.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Zerofi vault info quote key does not match"
        )?;

        validate!(
            &market.vault_base == zerofi_vault_base.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Zerofi quote vault key does not match"
        )?;

        validate!(
            &market.vault_quote == zerofi_vault_quote.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Zerofi quote vault key does not match"
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

        validate!(
            market.mint_quote == quote_market_vault.mint,
            ErrorCode::InvalidFulfillmentConfig
        )?;
        validate!(
            market.mint_base == base_market_vault.mint,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        let token_program: Program<Token> = Program::try_from(*token_program).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidFulfillmentConfig
        })?;
        validate!(
            instructions_sysvar.key == &solana_program::sysvar::instructions::ID,
            ErrorCode::InvalidFulfillmentConfig
        )?;
        Ok(ZerofiFulfillmentParams {
            drift_signer,
            zerofi_context: ZerofiContext {
                zerofi_program,
                zerofi_market,
            },
            zerofi_vault_base_info,
            zerofi_vault_quote_info,
            zerofi_vault_base,
            zerofi_vault_quote,
            base_market_vault,
            quote_market_vault,
            token_program,
            instructions_sysvar,
            signer_nonce: state.signer_nonce,
            now,
            base_precision: base_market.get_precision(),
        })
    }
}

impl<'a, 'b> ZerofiFulfillmentParams<'a, 'b> {
    pub fn invoke_swap(&self, is_base_to_quote: bool, data: Vec<u8>) -> DriftResult {
        let ctx = &self.zerofi_context;
        let accounts = if is_base_to_quote {
            vec![
                AccountMeta::new(*ctx.zerofi_market.key, false),
                AccountMeta::new(*self.zerofi_vault_base_info.key, false),
                AccountMeta::new(*self.zerofi_vault_base.key, false),
                AccountMeta::new(*self.zerofi_vault_quote_info.key, false),
                AccountMeta::new(*self.zerofi_vault_quote.key, false),
                AccountMeta::new(self.base_market_vault.key(), false),
                AccountMeta::new(self.quote_market_vault.key(), false),
                AccountMeta::new(*self.drift_signer.key, true),
                AccountMeta::new_readonly(*self.token_program.key, false),
                AccountMeta::new_readonly(*self.instructions_sysvar.key, false),
            ]
        } else {
            vec![
                AccountMeta::new(*ctx.zerofi_market.key, false),
                AccountMeta::new(*self.zerofi_vault_quote_info.key, false),
                AccountMeta::new(*self.zerofi_vault_quote.key, false),
                AccountMeta::new(*self.zerofi_vault_base_info.key, false),
                AccountMeta::new(*self.zerofi_vault_base.key, false),
                AccountMeta::new(self.quote_market_vault.key(), false),
                AccountMeta::new(self.base_market_vault.key(), false),
                AccountMeta::new(*self.drift_signer.key, true),
                AccountMeta::new_readonly(*self.token_program.key, false),
                AccountMeta::new_readonly(*self.instructions_sysvar.key, false),
            ]
        };
        let account_infos = vec![
            ctx.zerofi_program.clone(),
            ctx.zerofi_market.clone(),
            self.zerofi_vault_base_info.clone(),
            self.zerofi_vault_base.clone(),
            self.zerofi_vault_quote_info.clone(),
            self.zerofi_vault_quote.clone(),
            self.base_market_vault.to_account_info(),
            self.quote_market_vault.to_account_info(),
            self.drift_signer.clone(),
            self.token_program.to_account_info(),
            self.instructions_sysvar.to_account_info(),
        ];
        let swap_instruction = Instruction {
            program_id: *ctx.zerofi_program.key,
            accounts,
            data,
        };
        let signer_seeds = get_signer_seeds(&self.signer_nonce);
        let signers_seeds = &[&signer_seeds[..]];

        invoke_signed_unchecked(&swap_instruction, &account_infos, signers_seeds).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::FailedZerofiCPI
        })?;

        Ok(())
    }
}

impl<'a, 'b> SpotFulfillmentParams for ZerofiFulfillmentParams<'a, 'b> {
    fn is_external(&self) -> bool {
        true
    }
    fn fulfill_order(
        &mut self,
        taker_direction: PositionDirection,
        taker_price: u64,
        taker_base_asset_amount: u64,
        taker_max_quote_asset_amount: u64,
    ) -> DriftResult<ExternalSpotFill> {
        let market = self.zerofi_context.load_zerofi_market()?;

        // According to calculate_fill_price(), this is how taker_price works
        let taker_quote_asset_amount: u64 = taker_price
            .cast::<u128>()?
            .safe_mul(taker_base_asset_amount.cast()?)?
            .safe_div(self.base_precision.cast()?)?
            .cast::<u64>()?;

        let is_base_to_quote = taker_direction == PositionDirection::Short;
        let (in_amount, out_amount) = if !is_base_to_quote {
            let max_quote_in = taker_quote_asset_amount.min(taker_max_quote_asset_amount);
            (max_quote_in, taker_base_asset_amount)
        } else {
            (taker_base_asset_amount, taker_quote_asset_amount)
        };

        let mut args = vec![0u8; 17];
        args[0] = 6;
        args[1..9].copy_from_slice(&in_amount.to_le_bytes());
        args[9..17].copy_from_slice(&out_amount.to_le_bytes());

        let base_before = self.base_market_vault.amount;
        let quote_before = self.quote_market_vault.amount;

        self.invoke_swap(is_base_to_quote, args)?;

        self.base_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload base_market_vault");
            ErrorCode::FailedZerofiCPI
        })?;
        self.quote_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload quote_market_vault");
            ErrorCode::FailedZerofiCPI
        })?;

        let base_after = self.base_market_vault.amount;
        let quote_after = self.quote_market_vault.amount;

        let (base_update_direction, base_asset_amount_filled) = if base_after > base_before {
            (SpotBalanceType::Deposit, base_after.safe_sub(base_before)?)
        } else {
            (SpotBalanceType::Borrow, base_before.safe_sub(base_after)?)
        };

        if base_asset_amount_filled == 0 {
            msg!("No base filled on zerofi");
            return Ok(ExternalSpotFill::empty());
        }

        let (quote_update_direction, quote_asset_amount_filled) =
            if base_update_direction == SpotBalanceType::Borrow {
                let quote_asset_amount_delta = quote_after.safe_sub(quote_before)?;
                (SpotBalanceType::Deposit, quote_asset_amount_delta)
            } else {
                let quote_asset_amount_delta = quote_before.safe_sub(quote_after)?;
                (SpotBalanceType::Borrow, quote_asset_amount_delta)
            };

        Ok(ExternalSpotFill {
            base_asset_amount_filled,
            quote_asset_amount_filled,
            base_update_direction,
            quote_update_direction,
            fee: 0,
            unsettled_referrer_rebate: 0,
            settled_referrer_rebate: 0,
        })
    }

    fn get_best_bid_and_ask(&self) -> DriftResult<(Option<u64>, Option<u64>)> {
        Ok((None, None))
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Ok(OrderActionExplanation::OrderFilledWithZerofi)
    }

    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult {
        validate_spot_market_vault_amount(base_market, self.base_market_vault.amount)?;
        validate_spot_market_vault_amount(quote_market, self.quote_market_vault.amount)?;
        Ok(())
    }

    fn validate_markets(
        &self,
        base_market: &SpotMarket,
        quote_market: &SpotMarket,
    ) -> DriftResult<()> {
        validate!(
            self.base_market_vault.mint == base_market.mint,
            ErrorCode::DefaultError,
            "base mints dont match"
        )?;

        validate!(
            self.quote_market_vault.mint == quote_market.mint,
            ErrorCode::DefaultError,
            "base mints dont match"
        )?;

        Ok(())
    }
}
