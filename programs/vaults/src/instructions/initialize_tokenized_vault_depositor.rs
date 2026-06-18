use crate::constraints::is_manager_for_vault;
use crate::{Size, TokenizedVaultDepositor, Vault};
use anchor_lang::prelude::*;
use anchor_spl::{
    metadata::{
        create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
        Metadata,
    },
    token::{Mint, Token},
};

pub fn initialize_tokenized_vault_depositor(
    ctx: Context<InitializeTokenizedVaultDepositor>,
    params: InitializeTokenizedVaultDepositorParams,
) -> Result<()> {
    let vault = ctx.accounts.vault.load()?;
    let mut tokenized_vault_depositor = ctx.accounts.vault_depositor.load_init()?;
    *tokenized_vault_depositor = TokenizedVaultDepositor::new(
        ctx.accounts.vault.key(),
        ctx.accounts.vault_depositor.key(),
        ctx.accounts.mint_account.key(),
        vault.shares_base,
        ctx.bumps.vault_depositor,
        Clock::get()?.unix_timestamp,
    );

    let signature_seeds = Vault::get_vault_signer_seeds(vault.name.as_ref(), &vault.bump);
    let signers = &[&signature_seeds[..]];

    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.key(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata_account.to_account_info(),
                mint: ctx.accounts.mint_account.to_account_info(),
                mint_authority: ctx.accounts.vault.to_account_info(),
                update_authority: ctx.accounts.vault.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            signers,
        ),
        DataV2 {
            name: params.token_name,
            symbol: params.token_symbol,
            uri: params.token_uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        false, // Is mutable
        true,  // Update authority is signer
        None,  // Collection details
    )?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(params: InitializeTokenizedVaultDepositorParams)]
pub struct InitializeTokenizedVaultDepositor<'info> {
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        init,
        seeds = [b"tokenized_vault_depositor", vault.key().as_ref(), vault.load()?.shares_base.to_string().as_bytes()],
        space = TokenizedVaultDepositor::SIZE,
        bump,
        payer = payer
    )]
    pub vault_depositor: AccountLoader<'info, TokenizedVaultDepositor>,
    #[account(
        init,
        seeds = [b"mint", vault.key().as_ref(), vault.load()?.shares_base.to_string().as_bytes()],
        bump,
        payer = payer,
        mint::decimals = params.decimals,
        mint::authority = vault.key(),
        mint::freeze_authority = vault.key(),
    )]
    pub mint_account: Account<'info, Mint>,
    /// CHECK: Validate address by deriving pda
    #[account(
		mut,
		seeds = [b"metadata", token_metadata_program.key().as_ref(), mint_account.key().as_ref()],
		bump,
		seeds::program = token_metadata_program.key(),
	)]
    pub metadata_account: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &payer)?,
    )]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Debug, Clone, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct InitializeTokenizedVaultDepositorParams {
    pub token_name: String,
    pub token_symbol: String,
    pub token_uri: String,
    pub decimals: u8,
}
