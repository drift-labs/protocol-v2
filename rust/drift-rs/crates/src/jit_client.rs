//! JIT proxy client
//!
//! Routes JIT maker orders via onchain jit-proxy program
use std::borrow::Cow;

use crate::solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    signature::Signature,
};
use anchor_lang::{AnchorDeserialize, AnchorSerialize, InstructionData};
use solana_rpc_client_api::config::RpcSendTransactionConfig;

use crate::{
    accounts::User,
    build_accounts,
    constants::{self, derive_revenue_share_escrow, state_account, JIT_PROXY_ID},
    swift_order_subscriber::SignedOrderInfo,
    types::{OrderExt, PositionDirection},
    DriftClient, MarketId, MarketType, PostOnlyParam, ReferrerInfo, SdkError, SdkResult,
    TransactionBuilder, Wallet,
};

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub enum PriceType {
    Limit,
    Oracle,
}

/// Taker account parameters for JIT tx building
pub struct JitTakerParams {
    taker: User,
    taker_key: Pubkey,
    taker_stats_key: Pubkey,
    taker_referrer_info: Option<ReferrerInfo>,
}

impl JitTakerParams {
    pub fn new(
        taker_key: Pubkey,
        taker_stats_key: Pubkey,
        taker: User,
        taker_referrer_info: Option<ReferrerInfo>,
    ) -> Self {
        Self {
            taker_key,
            taker_stats_key,
            taker,
            taker_referrer_info,
        }
    }
}

#[derive(Copy, Clone, Debug)]
/// Parameters for building a jit maker order
pub struct JitIxParams {
    pub max_position: i64,
    pub min_position: i64,
    pub bid: i64,
    pub ask: i64,
    pub price_type: PriceType,
    pub post_only: Option<PostOnlyParam>,
}

impl JitIxParams {
    pub fn new(
        max_position: i64,
        min_position: i64,
        bid: i64,
        ask: i64,
        price_type: PriceType,
        post_only: Option<PostOnlyParam>,
    ) -> Self {
        Self {
            max_position,
            min_position,
            bid,
            ask,
            price_type,
            post_only,
        }
    }
}

#[derive(Clone)]
pub struct JitProxyClient {
    drift_client: DriftClient,
    config: RpcSendTransactionConfig,
    cu_params: Option<ComputeBudgetParams>,
}

impl JitProxyClient {
    pub fn new(
        drift_client: DriftClient,
        config: Option<RpcSendTransactionConfig>,
        cu_params: Option<ComputeBudgetParams>,
    ) -> Self {
        Self {
            drift_client,
            config: config.unwrap_or_default(),
            cu_params,
        }
    }

    pub fn update_config(&mut self, config: RpcSendTransactionConfig) {
        self.config = config;
    }

    pub fn update_cu_params(&mut self, cu_params: ComputeBudgetParams) {
        self.cu_params = Some(cu_params);
    }

    /// Build a jit tx
    ///
    /// `taker_params` JIT taker account params
    /// `taker_order_id` order Id of the JIT order
    /// `jit_ix_params` bounds for the JIT fill
    /// `maker_params` tuple (pubkey, data) of maker's sub-account
    pub async fn build_jit_tx(
        &self,
        taker_order_id: u32,
        taker_params: &JitTakerParams,
        jit_ix_params: JitIxParams,
        maker_params: (&Pubkey, &User),
    ) -> SdkResult<VersionedMessage> {
        let order = taker_params
            .taker
            .orders
            .iter()
            .find(|order| order.order_id == taker_order_id)
            .ok_or(SdkError::JitOrderNotFound)?;

        let tx_builder = TransactionBuilder::new(
            self.drift_client.program_data(),
            *maker_params.0,
            Cow::Borrowed(maker_params.1),
            false,
        );

        let program_data = tx_builder.program_data();
        let account_data = tx_builder.account_data();

        let writable_markets = match order.market_type {
            MarketType::Perp => {
                vec![MarketId::perp(order.market_index)]
            }
            MarketType::Spot => {
                vec![MarketId::spot(order.market_index), MarketId::QUOTE_SPOT]
            }
        };

        let maker_authority = maker_params.1.authority;
        let mut accounts = build_accounts(
            program_data,
            self::accounts::Jit {
                state: *state_account(),
                user: *maker_params.0,
                user_stats: Wallet::derive_stats_account(&maker_authority),
                taker: taker_params.taker_key,
                taker_stats: taker_params.taker_stats_key,
                authority: maker_authority,
                drift_program: constants::PROGRAM_ID,
            },
            [&taker_params.taker, account_data].into_iter(),
            std::iter::empty(),
            writable_markets.iter(),
        );

        if order.has_builder() {
            accounts.push(AccountMeta::new(
                derive_revenue_share_escrow(&taker_params.taker.authority),
                false,
            ))
        }

        if let Some(referrer_info) = taker_params.taker_referrer_info {
            accounts.push(AccountMeta::new(referrer_info.referrer(), false));
            accounts.push(AccountMeta::new(referrer_info.referrer_stats(), false));
        }

        if order.market_type == MarketType::Spot {
            let spot_market_vault = self
                .drift_client
                .try_get_spot_market_account(order.market_index)?
                .vault;
            let quote_spot_market_vault = self
                .drift_client
                .try_get_spot_market_account(MarketId::QUOTE_SPOT.index())?
                .vault;
            accounts.push(AccountMeta::new_readonly(spot_market_vault, false));
            accounts.push(AccountMeta::new_readonly(quote_spot_market_vault, false));
        }

        let jit_params = self::instruction::JitParams {
            taker_order_id,
            max_position: jit_ix_params.max_position,
            min_position: jit_ix_params.min_position,
            bid: jit_ix_params.bid,
            ask: jit_ix_params.ask,
            price_type: jit_ix_params.price_type,
            post_only: jit_ix_params.post_only,
        };

        let ix = Instruction {
            program_id: JIT_PROXY_ID,
            accounts,
            data: instruction::Jit { params: jit_params }.data(),
        };

        let mut ixs = Vec::with_capacity(3);
        if let Some(cu_params) = self.cu_params {
            let cu_limit_ix =
                ComputeBudgetInstruction::set_compute_unit_price(cu_params.microlamports_per_cu());
            let cu_price_ix =
                ComputeBudgetInstruction::set_compute_unit_limit(cu_params.cu_limit());

            ixs.push(cu_limit_ix);
            ixs.push(cu_price_ix);
        }
        ixs.push(ix);

        let luts = program_data.lookup_tables;

        let message =
            v0::Message::try_compile(&maker_authority, ixs.as_slice(), luts, Default::default())
                .expect("failed to compile message");

        Ok(VersionedMessage::V0(message))
    }

    /// Build a swift fill tx against a taker order given by `taker_params`
    ///
    /// `signed_order_info` Fastlane (order) message to place-and-make against
    /// `taker_params` taker account params
    /// `jit_params` config for the JIT proxy
    /// `maker_pubkey` address of the maker's subaccount
    /// `maker_account_data` Maker's (User) account data corresponding with the `maker_pubkey`
    ///
    /// Returns a Solana `VersionedMessage` ready for signing
    pub async fn build_swift_ix(
        &self,
        signed_order_info: &SignedOrderInfo,
        taker_params: &JitTakerParams,
        jit_ix_params: &JitIxParams,
        maker_pubkey: &Pubkey,
        maker_account_data: &User,
    ) -> SdkResult<VersionedMessage> {
        let maker_authority = maker_account_data.authority;
        let program_data = self.drift_client.program_data();
        let signed_order_info_params = signed_order_info.order_params();
        let account_data = maker_account_data;
        let market_index = signed_order_info_params.market_index;
        let market_type = signed_order_info_params.market_type;

        let writable_markets = match market_type {
            MarketType::Perp => {
                vec![MarketId::perp(market_index)]
            }
            MarketType::Spot => {
                vec![MarketId::spot(market_index), MarketId::QUOTE_SPOT]
            }
        };

        let mut accounts = build_accounts(
            program_data,
            self::accounts::JitSignedMsg {
                state: *state_account(),
                authority: maker_authority,
                user: *maker_pubkey,
                user_stats: Wallet::derive_stats_account(&maker_authority),
                taker: taker_params.taker_key,
                taker_stats: taker_params.taker_stats_key,
                taker_signed_msg_user_orders: Wallet::derive_swift_order_account(
                    &taker_params.taker.authority,
                ),
                drift_program: constants::PROGRAM_ID,
            },
            [&taker_params.taker, account_data].into_iter(),
            std::iter::empty(),
            writable_markets.iter(),
        );

        if let Some(referrer_info) = taker_params.taker_referrer_info {
            accounts.push(AccountMeta::new(referrer_info.referrer(), false));
            accounts.push(AccountMeta::new(referrer_info.referrer_stats(), false));
        }

        if market_type == MarketType::Spot {
            let spot_market_vault = self
                .drift_client
                .try_get_spot_market_account(market_index)?
                .vault;
            let quote_spot_market_vault = self
                .drift_client
                .try_get_spot_market_account(MarketId::QUOTE_SPOT.index())?
                .vault;
            accounts.push(AccountMeta::new_readonly(spot_market_vault, false));
            accounts.push(AccountMeta::new_readonly(quote_spot_market_vault, false));
        }

        let jit_params = self::instruction::JitSignedMsgParams {
            signed_order_info_uuid: signed_order_info.order_uuid(),
            max_position: jit_ix_params.max_position,
            min_position: jit_ix_params.min_position,
            bid: jit_ix_params.bid,
            ask: jit_ix_params.ask,
            price_type: jit_ix_params.price_type,
            post_only: jit_ix_params.post_only,
        };

        let fill_ix = Instruction {
            program_id: JIT_PROXY_ID,
            accounts,
            data: instruction::JitSignedMsg { params: jit_params }.data(),
        };

        let message = TransactionBuilder::new(
            self.drift_client.program_data(),
            *maker_pubkey,
            Cow::Borrowed(maker_account_data),
            false,
        )
        .place_swift_order(signed_order_info, &taker_params.taker)
        .add_ix(fill_ix)
        .build();

        Ok(message)
    }

    /// Send a jit tx with given params
    ///
    /// `taker_order_id` Id of the order to take against
    /// `taker_params` taker account data for the tx
    /// `jit_params` bounds for the JIT fill
    /// `maker_authority` the maker's authority key
    /// `sub_account_id` the maker's sub-account for the fill
    pub async fn jit(
        &self,
        taker_order_id: u32,
        taker_params: &JitTakerParams,
        jit_params: JitIxParams,
        maker_authority: &Pubkey,
        sub_account_id: Option<u16>,
    ) -> SdkResult<Signature> {
        let sub_account =
            Wallet::derive_user_account(maker_authority, sub_account_id.unwrap_or_default());
        let sub_account_data = self.drift_client.get_user_account(&sub_account).await?;
        let tx = self
            .build_jit_tx(
                taker_order_id,
                taker_params,
                jit_params,
                (&sub_account, &sub_account_data),
            )
            .await?;
        self.drift_client
            .sign_and_send_with_config(tx, None, self.config)
            .await
    }

    /// Try fill against a swift order with JIT-proxy protection
    ///
    /// `signed_order_info` the swift order info
    /// `taker_params` taker account data for the tx
    /// `jit_params` bounds for the JIT fill
    /// `maker_authority` the maker's authority key
    /// `sub_account_id` the maker's sub-account for the fill
    pub async fn try_swift_fill(
        &self,
        signed_order_info: &SignedOrderInfo,
        taker_params: &JitTakerParams,
        jit_params: &JitIxParams,
        maker_authority: &Pubkey,
        sub_account_id: Option<u16>,
    ) -> SdkResult<Signature> {
        let sub_account =
            Wallet::derive_user_account(maker_authority, sub_account_id.unwrap_or_default());
        let sub_account_data = self.drift_client.get_user_account(&sub_account).await?;
        let tx = self
            .build_swift_ix(
                signed_order_info,
                taker_params,
                jit_params,
                &sub_account,
                &sub_account_data,
            )
            .await?;
        self.drift_client
            .sign_and_send_with_config(tx, None, self.config)
            .await
    }
}

#[derive(Clone, Copy)]
pub struct ComputeBudgetParams {
    microlamports_per_cu: u64,
    cu_limit: u32,
}

impl ComputeBudgetParams {
    pub fn new(microlamports_per_cu: u64, cu_limit: u32) -> Self {
        Self {
            microlamports_per_cu,
            cu_limit,
        }
    }

    pub fn microlamports_per_cu(&self) -> u64 {
        self.microlamports_per_cu
    }

    pub fn cu_limit(&self) -> u32 {
        self.cu_limit
    }
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq)]
pub struct JitSwiftParams {
    pub signed_order_info_uuid: [u8; 8],
    pub max_position: i64,
    pub min_position: i64,
    pub bid: i64,
    pub ask: i64,
    pub price_type: PriceType,
    pub post_only: Option<PostOnlyParam>,
}

impl Default for JitSwiftParams {
    fn default() -> Self {
        Self {
            signed_order_info_uuid: [0; 8],
            max_position: 0,
            min_position: 0,
            bid: 0,
            ask: 0,
            price_type: PriceType::Limit,
            post_only: None,
        }
    }
}

impl JitSwiftParams {
    pub fn get_worst_price(
        self,
        oracle_price: i64,
        taker_direction: PositionDirection,
    ) -> SdkResult<u64> {
        match (taker_direction, self.price_type) {
            (PositionDirection::Long, PriceType::Limit) => Ok(self.ask.unsigned_abs()),
            (PositionDirection::Short, PriceType::Limit) => Ok(self.bid.unsigned_abs()),
            (PositionDirection::Long, PriceType::Oracle) => {
                Ok(oracle_price.saturating_add(self.ask).unsigned_abs())
            }
            (PositionDirection::Short, PriceType::Oracle) => {
                Ok(oracle_price.saturating_add(self.bid).unsigned_abs())
            }
        }
    }
}

pub mod instruction {
    //! copied from jit-proxy program
    //! simplifies dependency graph, unlikely to change frequently
    use super::*;
    use crate::PostOnlyParam;
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Jit {
        pub params: JitParams,
    }
    impl anchor_lang::Discriminator for Jit {
        const DISCRIMINATOR: &[u8] = &[99, 42, 97, 140, 152, 62, 167, 234];
    }
    impl anchor_lang::InstructionData for Jit {}

    #[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize)]
    pub struct JitParams {
        pub taker_order_id: u32,
        pub max_position: i64,
        pub min_position: i64,
        pub bid: i64,
        pub ask: i64,
        pub price_type: PriceType,
        pub post_only: Option<PostOnlyParam>,
    }

    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct JitSignedMsg {
        pub params: JitSignedMsgParams,
    }
    impl anchor_lang::Discriminator for JitSignedMsg {
        const DISCRIMINATOR: &[u8] = &[134, 130, 156, 72, 37, 120, 153, 21];
    }
    impl anchor_lang::InstructionData for JitSignedMsg {}

    #[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize)]
    pub struct JitSignedMsgParams {
        pub signed_order_info_uuid: [u8; 8],
        pub max_position: i64,
        pub min_position: i64,
        pub bid: i64,
        pub ask: i64,
        pub price_type: PriceType,
        pub post_only: Option<PostOnlyParam>,
    }
}

pub mod accounts {
    //! copied from jit-proxy program
    //! simplifies dependency graph, unlikely to change frequently
    use crate::solana_sdk::instruction::AccountMeta;

    use super::*;

    /// this is generated from `#[derive(Accounts)]` from `__client_accounts_jit`
    #[derive(anchor_lang::AnchorSerialize)]
    pub struct Jit {
        pub state: Pubkey,
        pub user: Pubkey,
        pub user_stats: Pubkey,
        pub taker: Pubkey,
        pub taker_stats: Pubkey,
        pub authority: Pubkey,
        pub drift_program: Pubkey,
    }
    impl anchor_lang::ToAccountMetas for Jit {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                AccountMeta::new_readonly(self.state, false),
                AccountMeta::new(self.user, false),
                AccountMeta::new(self.user_stats, false),
                AccountMeta::new(self.taker, false),
                AccountMeta::new(self.taker_stats, false),
                AccountMeta::new_readonly(self.authority, true),
                AccountMeta::new_readonly(self.drift_program, false),
            ]
        }
    }

    pub struct JitSignedMsg {
        pub state: Pubkey,
        pub user: Pubkey,
        pub user_stats: Pubkey,
        pub taker: Pubkey,
        pub taker_stats: Pubkey,
        pub taker_signed_msg_user_orders: Pubkey,
        pub authority: Pubkey,
        pub drift_program: Pubkey,
    }
    impl anchor_lang::ToAccountMetas for JitSignedMsg {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                AccountMeta::new_readonly(self.state, false),
                AccountMeta::new(self.user, false),
                AccountMeta::new(self.user_stats, false),
                AccountMeta::new(self.taker, false),
                AccountMeta::new(self.taker_stats, false),
                AccountMeta::new(self.taker_signed_msg_user_orders, false),
                AccountMeta::new_readonly(self.authority, true),
                AccountMeta::new_readonly(self.drift_program, false),
            ]
        }
    }
}
