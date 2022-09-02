use crate::error::{ClearingHouseResult, ErrorCode};
use crate::signer::get_signer_seeds;
use anchor_lang::accounts::account::Account;
use anchor_lang::prelude::{AccountInfo, Program, Rent, Sysvar};
use anchor_lang::ToAccountInfo;
use anchor_spl::token::{Token, TokenAccount};
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::msg;

pub fn init_open_orders<'a>(
    serum_program: &AccountInfo<'a>,
    open_orders: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    market: &AccountInfo<'a>,
    rent: &Sysvar<'a, Rent>,
    nonce: u8,
) -> ClearingHouseResult {
    let signature_seeds = get_signer_seeds(&nonce);
    let signers = &[&signature_seeds[..]];

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
    solana_program::program::invoke_signed(&instruction, &account_infos, signers).map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::FailedSerumCPI
    })
}

pub struct SerumNewOrderAccounts<'a, 'info> {
    pub clearing_house_signer: &'a AccountInfo<'info>,
    pub serum_program_id: &'a AccountInfo<'info>,
    pub serum_market: &'a AccountInfo<'info>,
    pub serum_request_queue: &'a AccountInfo<'info>,
    pub serum_event_queue: &'a AccountInfo<'info>,
    pub serum_bids: &'a AccountInfo<'info>,
    pub serum_asks: &'a AccountInfo<'info>,
    pub serum_base_vault: &'a AccountInfo<'info>,
    pub serum_quote_vault: &'a AccountInfo<'info>,
    pub serum_open_orders: &'a AccountInfo<'info>,
    pub token_program: &'a Program<'info, Token>,
    pub base_bank_vault: &'a Box<Account<'info, TokenAccount>>,
    pub quote_bank_vault: &'a Box<Account<'info, TokenAccount>>,
}
