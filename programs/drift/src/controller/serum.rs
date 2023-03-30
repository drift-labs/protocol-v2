use crate::error::{DriftResult, ErrorCode};
use crate::signer::get_signer_seeds;
use anchor_lang::accounts::account::Account;
use anchor_lang::prelude::{AccountInfo, Program, Pubkey, Rent, Sysvar};
use anchor_lang::ToAccountInfo;
use anchor_spl::token::{Token, TokenAccount};
use serum_dex::instruction::NewOrderInstructionV3;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::msg;

pub fn invoke_init_open_orders<'a>(
    serum_program: &AccountInfo<'a>,
    open_orders: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    market: &AccountInfo<'a>,
    rent: &Sysvar<'a, Rent>,
    nonce: u8,
) -> DriftResult {
    let signer_seeds = get_signer_seeds(&nonce);
    let signers_seeds = &[&signer_seeds[..]];

    let data = serum_dex::instruction::MarketInstruction::InitOpenOrders.pack();
    let instruction = Instruction {
        program_id: *serum_program.key,
        data,
        accounts: vec![
            AccountMeta::new(*open_orders.key, false),
            AccountMeta::new_readonly(*authority.key, true),
            AccountMeta::new_readonly(*market.key, false),
            AccountMeta::new_readonly(*rent.to_account_info().key, false),
        ],
    };

    let account_infos = [
        serum_program.clone(),
        open_orders.clone(),
        authority.clone(),
        market.clone(),
        rent.to_account_info().clone(),
    ];
    solana_program::program::invoke_signed(&instruction, &account_infos, signers_seeds).map_err(
        |e| {
            msg!("{:?}", e);
            ErrorCode::FailedSerumCPI
        },
    )
}

pub enum FulfillmentParams<'a, 'b> {
    SerumFulfillmentParams(SerumFulfillmentParams<'a, 'b>),
}

pub struct SerumFulfillmentParams<'a, 'b> {
    pub drift_signer: &'a AccountInfo<'b>,
    pub serum_program_id: &'a AccountInfo<'b>,
    pub serum_market: &'a AccountInfo<'b>,
    pub serum_request_queue: &'a AccountInfo<'b>,
    pub serum_event_queue: &'a AccountInfo<'b>,
    pub serum_bids: &'a AccountInfo<'b>,
    pub serum_asks: &'a AccountInfo<'b>,
    pub serum_base_vault: &'a AccountInfo<'b>,
    pub serum_quote_vault: &'a AccountInfo<'b>,
    pub serum_open_orders: &'a AccountInfo<'b>,
    pub token_program: Program<'b, Token>,
    pub base_market_vault: Box<Account<'b, TokenAccount>>,
    pub quote_market_vault: Box<Account<'b, TokenAccount>>,
    pub srm_vault: &'a AccountInfo<'b>,
    pub serum_signer: &'a AccountInfo<'b>,
    pub signer_nonce: u8,
}

pub fn invoke_new_order<'a>(
    serum_program: &AccountInfo<'a>, // Have to add account of the program id
    serum_market: &AccountInfo<'a>,
    serum_open_markets: &AccountInfo<'a>,
    serum_request_queue: &AccountInfo<'a>,
    serum_event_queue: &AccountInfo<'a>,
    serum_bids: &AccountInfo<'a>,
    serum_asks: &AccountInfo<'a>,
    drift_vault: &AccountInfo<'a>,
    drift_signer: &AccountInfo<'a>,
    serum_base_vault: &AccountInfo<'a>,
    serum_quote_vault: &AccountInfo<'a>,
    srm_vault: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    order: NewOrderInstructionV3,
    nonce: u8,
) -> DriftResult {
    let data = serum_dex::instruction::MarketInstruction::NewOrderV3(order).pack();
    let mut instruction = Instruction {
        program_id: *serum_program.key,
        data,
        accounts: vec![
            AccountMeta::new(*serum_market.key, false),
            AccountMeta::new(*serum_open_markets.key, false),
            AccountMeta::new(*serum_request_queue.key, false),
            AccountMeta::new(*serum_event_queue.key, false),
            AccountMeta::new(*serum_bids.key, false),
            AccountMeta::new(*serum_asks.key, false),
            AccountMeta::new(*drift_vault.key, false),
            AccountMeta::new_readonly(*drift_signer.key, true),
            AccountMeta::new(*serum_base_vault.key, false),
            AccountMeta::new(*serum_quote_vault.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*drift_signer.key, false),
        ],
    };

    if srm_vault.key != &Pubkey::default() {
        instruction
            .accounts
            .push(AccountMeta::new_readonly(*srm_vault.key, false));

        let account_infos = [
            serum_program.clone(), // Have to add account of the program id
            serum_market.clone(),
            serum_open_markets.clone(),
            serum_request_queue.clone(),
            serum_event_queue.clone(),
            serum_bids.clone(),
            serum_asks.clone(),
            drift_vault.clone(),
            drift_signer.clone(),
            serum_base_vault.clone(),
            serum_quote_vault.clone(),
            token_program.clone(),
            drift_signer.clone(),
            srm_vault.clone(),
        ];

        let signer_seeds = get_signer_seeds(&nonce);
        let signers_seeds = &[&signer_seeds[..]];

        solana_program::program::invoke_signed_unchecked(
            &instruction,
            &account_infos,
            signers_seeds,
        )
        .map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::FailedSerumCPI
        })
    } else {
        let account_infos = [
            serum_program.clone(), // Have to add account of the program id
            serum_market.clone(),
            serum_open_markets.clone(),
            serum_request_queue.clone(),
            serum_event_queue.clone(),
            serum_bids.clone(),
            serum_asks.clone(),
            drift_vault.clone(),
            drift_signer.clone(),
            serum_base_vault.clone(),
            serum_quote_vault.clone(),
            token_program.clone(),
            drift_signer.clone(),
        ];

        let signer_seeds = get_signer_seeds(&nonce);
        let signers_seeds = &[&signer_seeds[..]];

        solana_program::program::invoke_signed_unchecked(
            &instruction,
            &account_infos,
            signers_seeds,
        )
        .map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::FailedSerumCPI
        })
    }
}

pub fn invoke_settle_funds<'a>(
    serum_program: &AccountInfo<'a>,
    serum_market: &AccountInfo<'a>,
    serum_open_orders: &AccountInfo<'a>,
    drift_signer: &AccountInfo<'a>,
    serum_base_vault: &AccountInfo<'a>,
    serum_quote_vault: &AccountInfo<'a>,
    drift_base_vault: &AccountInfo<'a>,
    drift_quote_vault: &AccountInfo<'a>,
    serum_signer: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    nonce: u8,
) -> DriftResult {
    let data = serum_dex::instruction::MarketInstruction::SettleFunds.pack();
    let instruction = Instruction {
        program_id: *serum_program.key,
        data,
        accounts: vec![
            AccountMeta::new(*serum_market.key, false),
            AccountMeta::new(*serum_open_orders.key, false),
            AccountMeta::new_readonly(*drift_signer.key, true),
            AccountMeta::new(*serum_base_vault.key, false),
            AccountMeta::new(*serum_quote_vault.key, false),
            AccountMeta::new(*drift_base_vault.key, false),
            AccountMeta::new(*drift_quote_vault.key, false),
            AccountMeta::new_readonly(*serum_signer.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new(*drift_quote_vault.key, false),
        ],
    };

    let account_infos = [
        serum_program.clone(),
        serum_market.clone(),
        serum_open_orders.clone(),
        drift_signer.clone(),
        serum_base_vault.clone(),
        serum_quote_vault.clone(),
        drift_base_vault.clone(),
        drift_quote_vault.clone(),
        serum_signer.clone(),
        token_program.clone(),
        drift_quote_vault.clone(),
    ];

    let signer_seeds = get_signer_seeds(&nonce);
    let signers_seeds = &[&signer_seeds[..]];

    solana_program::program::invoke_signed_unchecked(&instruction, &account_infos, signers_seeds)
        .map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::FailedSerumCPI
        })
}
