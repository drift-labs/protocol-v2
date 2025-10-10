use crate::*;

use crate::Pubkey;
use crate::solana_program::instruction::{Instruction, AccountMeta};
use anchor_client::solana_sdk::address_lookup_table::state::AddressLookupTable;
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use anchor_client::solana_sdk::address_lookup_table::AddressLookupTableAccount;
use crate::solana_program::hash::Hash;
use anchor_client::solana_sdk::compute_budget::ComputeBudgetInstruction;
use anchor_client::solana_sdk::signer::Signer;
use anchor_client::solana_sdk::transaction::VersionedTransaction;
use tokio::sync::RwLockReadGuard;
use std::ops::Deref;
use std::sync::Arc;
use anchor_client::solana_sdk::transaction::Transaction;
pub use anchor_client::solana_sdk::signer::keypair::Keypair;

/// A trait for types that can act as signers for transactions.
pub trait AsSigner: Send + Sync {
    /// Returns a reference to the signer.
    fn as_signer(&self) -> &dyn Signer;

    fn signer_pubkey(&self) -> Pubkey {
        let anchor_pubkey = self.as_signer().pubkey();
        Pubkey::new_from_array(anchor_pubkey.to_bytes())
    }
}

pub trait ToKeypair: Send + Sync {
    fn keypair(&self) -> &Keypair;
}

// Implement AsSigner for any type that implements ToKeypair
impl<T> AsSigner for T
where
    T: ToKeypair,
{
    fn as_signer(&self) -> &dyn Signer {
        // Use the keypair method from the ToKeypair trait to get the Keypair
        // and then return a reference to it as a &dyn Signer.
        // The Keypair struct already implements the Signer trait.
        self.keypair()
    }
}

// Implementations

impl ToKeypair for Keypair {
    fn keypair(&self) -> &Keypair {
        self
    }
}
impl<'a> ToKeypair for &'a Keypair {
    fn keypair(&self) -> &'a Keypair {
        self
    }
}

// Arc

impl ToKeypair for Arc<Keypair> {
    fn keypair(&self) -> &Keypair {
        self.as_ref()
    }
}
impl AsSigner for Arc<&Keypair> {
    fn as_signer(&self) -> &dyn Signer {
        *self.as_ref()
    }
}
impl ToKeypair for &Arc<Keypair> {
    fn keypair(&self) -> &Keypair {
        self.as_ref()
    }
}
impl ToKeypair for Arc<Arc<Keypair>> {
    fn keypair(&self) -> &Keypair {
        self
    }
}
impl ToKeypair for Arc<Arc<Arc<Keypair>>> {
    fn keypair(&self) -> &Keypair {
        self
    }
}

// Box

impl<T> ToKeypair for Box<T>
where
    T: ToKeypair + ?Sized,
{
    fn keypair(&self) -> &Keypair {
        self.as_ref().keypair()
    }
}

// Tokio RwLock

impl<'a, T> ToKeypair for RwLockReadGuard<'a, T>
where
    T: ToKeypair + ?Sized,
{
    fn keypair(&self) -> &Keypair {
        self.deref().keypair()
    }
}

impl<'a, T> ToKeypair for Arc<RwLockReadGuard<'a, T>>
where
    T: ToKeypair + ?Sized,
{
    fn keypair(&self) -> &Keypair {
        self.as_ref().keypair()
    }
}

impl<'a> AsSigner for &RwLockReadGuard<'a, Keypair> {
    fn as_signer(&self) -> &dyn Signer {
        (*self).deref()
    }
}
impl<'a> AsSigner for &Arc<RwLockReadGuard<'a, Keypair>> {
    fn as_signer(&self) -> &dyn Signer {
        self.as_ref().deref()
    }
}

/// Represents a transaction object used for building Solana transactions.
///
/// The `TransactionBuilder` struct provides methods for constructing and manipulating Solana transactions.
/// It allows setting the payer, adding instructions, signers, and other transaction parameters.
/// The transaction can be converted to a legacy transaction format or executed directly using the Solana RPC client.
///
/// # Examples
///
/// Creating a new transaction object with a payer:
///
/// ```rust
/// use anchor_client::solana_sdk::pubkey::Pubkey;
/// use anchor_client::solana_sdk::instruction::Instruction;
/// use std::sync::Arc;
///
/// let payer = Pubkey::new_unique();
/// let transaction = TransactionBuilder::new(payer);
/// ```
///
/// Adding an instruction to the transaction:
///
/// ```rust
/// use anchor_client::solana_sdk::pubkey::Pubkey;
/// use anchor_client::solana_sdk::instruction::Instruction;
/// use std::sync::Arc;
///
/// let payer = Pubkey::new_unique();
/// let instruction = Instruction::new_with_bincode(program_id, data);
/// let transaction = TransactionBuilder::new(payer)
///     .add_ix(instruction);
/// ```
///
/// Converting the transaction object to a legacy transaction:
///
/// ```rust
/// use anchor_client::solana_sdk::pubkey::Pubkey;
/// use anchor_client::solana_sdk::instruction::Instruction;
/// use std::sync::Arc;
///
/// let payer = Pubkey::new_unique();
/// let instruction = Instruction::new_with_bincode(program_id, data);
/// let transaction = TransactionBuilder::new(payer)
///     .add_ix(instruction)
///     .to_legacy_tx();
/// ```
#[derive(Default, Clone)]
pub struct TransactionBuilder {
    payer: Pubkey,
    ixs: Vec<Instruction>,
    compute_units: Option<u32>,
    priority_fees: Option<u64>,
    recent_blockhash: Option<Hash>,
    min_context_slot: Option<u64>,
    address_lookup_tables: Vec<AddressLookupTableAccount>,
    signers: Vec<Arc<dyn AsSigner>>,
}
impl TransactionBuilder {
    pub fn new(payer: Pubkey) -> Self {
        Self {
            payer,
            ..Default::default()
        }
    }
    pub fn new_with_payer(payer: Arc<dyn AsSigner>) -> Self {
        Self {
            payer: payer.signer_pubkey(),
            signers: vec![Arc::clone(&payer)],
            ..Default::default()
        }
    }

    pub fn new_with_ixs(payer: Pubkey, ixs: impl IntoIterator<Item = Instruction>) -> Self {
        Self {
            payer,
            ixs: ixs.into_iter().collect::<Vec<Instruction>>(),
            ..Default::default()
        }
    }
    pub fn new_with_payer_and_ixs(
        payer: Arc<dyn AsSigner>,
        ixs: impl IntoIterator<Item = Instruction>,
    ) -> Self {
        Self {
            payer: payer.signer_pubkey(),
            signers: vec![Arc::clone(&payer)],
            ixs: ixs.into_iter().collect::<Vec<Instruction>>(),
            ..Default::default()
        }
    }

    // Builder methods, consumes self and returns self
    pub fn set_compute_units(mut self, compute_units: u32) -> Self {
        self.compute_units = Some(compute_units);
        self
    }
    pub fn set_priority_fees(mut self, priority_fees: u64) -> Self {
        self.priority_fees = Some(priority_fees);
        self
    }
    pub fn add_ix(mut self, ix: Instruction) -> Self {
        self.ixs.push(ix);
        self
    }
    pub fn has_signer(&self, signer: Pubkey) -> bool {
        self.signers
            .iter()
            .any(|s| s.as_signer().pubkey().to_bytes() == signer.to_bytes())
    }
    pub fn has_payer(&self) -> bool {
        self.has_signer(self.payer)
    }
    pub fn add_signer(mut self, signer: Arc<dyn AsSigner>) -> TransactionBuilder {
        let signer_key = signer.as_signer().pubkey();
        if !self
            .signers
            .iter().any(|s| s.as_signer().pubkey() == signer_key)
        {
            self.signers.push(Arc::clone(&signer));
        }

        self
    }
    pub fn add_signers(mut self, signers: Vec<Arc<dyn AsSigner>>) -> TransactionBuilder {
        for signer in signers {
            let signer_key = signer.as_signer().pubkey();
            if !self
                .signers
                .iter().any(|s| s.as_signer().pubkey() == signer_key)
            {
                self.signers.push(Arc::clone(&signer));
            }
        }

        self
    }
    pub fn set_recent_blockhash(mut self, blockhash: Hash) -> Self {
        self.recent_blockhash = Some(blockhash);
        self
    }
    pub fn set_min_context_slot(mut self, min_context_slot: u64) -> Self {
        self.min_context_slot = Some(min_context_slot);
        self
    }

    pub fn add_address_lookup_account(
        mut self,
        address_lookup_table: AddressLookupTableAccount,
    ) -> Self {
        self.address_lookup_tables.push(address_lookup_table);
        self
    }
    pub fn add_address_lookup_accounts(
        mut self,
        address_lookup_tables: &mut Vec<AddressLookupTableAccount>,
    ) -> Self {
        self.address_lookup_tables
            .append(address_lookup_tables);
        self
    }
    pub async fn add_address_lookup_table(
        mut self,
        rpc: &RpcClient,
        address_lookup_table_pubkey: Pubkey,
    ) -> Self {
        if let Ok(address_lookup_table) =
            TransactionBuilder::fetch_address_lookup_account(rpc, address_lookup_table_pubkey).await
        {
            self = self.add_address_lookup_account(address_lookup_table);
        }

        self
    }
    pub async fn add_address_lookup_tables(
        mut self,
        rpc: &RpcClient,
        address_lookup_table_pubkeys: Vec<Pubkey>,
    ) -> Self {
        if let Ok(mut address_lookup_tables) =
            TransactionBuilder::fetch_multiple_address_lookup_accounts(
                rpc,
                address_lookup_table_pubkeys,
            )
            .await
        {
            self = self.add_address_lookup_accounts(&mut address_lookup_tables);
        }

        self
    }

    // Getters
    pub fn payer(&self) -> Pubkey {
        self.payer
    }

    /// Return a vec of all of the required signers for the transaction.
    pub fn required_signers(&self) -> Vec<Pubkey> {
        let mut signers_required: Vec<Pubkey> = vec![];
        for ixn in self.ixs.clone() {
            for account in ixn.accounts {
                if account.is_signer && !signers_required.contains(&account.pubkey) {
                    signers_required.push(account.pubkey);
                }
            }
        }
        signers_required
    }

    /// Returns the stored signers for the transaction, removing any un-needed signers using the provided ixn's AccountMeta's.
    pub fn signers(&self) -> Result<Vec<&dyn Signer>, OnDemandError> {
        let mut signers: Vec<&dyn Signer> = vec![];
        for required_signer in self.required_signers().iter() {
            let mut found = false;

            for signer in &self.signers {
                let signer_key = signer.as_signer().pubkey();
                if signer_key.to_bytes() == required_signer.to_bytes() {
                    found = true;
                    signers.push(signer.as_signer());
                    break;
                }
            }
            if !found {
                return Err(OnDemandError::SolanaMissingSigner);
            }
        }

        Ok(signers)
    }
    fn signers_with_payer<'a, T: AsSigner>(
        &'a self,
        payer: &'a T,
    ) -> Result<Vec<&'a dyn Signer>, OnDemandError> {
        let payer_signer = payer.as_signer();

        if payer_signer.pubkey().to_bytes() != self.payer.to_bytes() {
            return Err(OnDemandError::SolanaPayerMismatch);
        }

        let mut signers: Vec<&dyn Signer> = vec![];
        for required_signer in self.required_signers().iter() {
            if required_signer == &self.payer {
                signers.push(payer_signer);
                continue;
            }

            let mut found = false;

            for signer in self.signers.iter() {
                let signer_key = signer.as_signer().pubkey();
                if signer_key.to_bytes() == required_signer.to_bytes() {
                    found = true;
                    signers.push(signer.as_signer());
                    break;
                }
            }
            if !found {
                return Err(OnDemandError::SolanaMissingSigner);
            }
        }

        Ok(signers)
    }
    pub fn ixs(&self) -> Result<Vec<Instruction>, OnDemandError> {
        if self.ixs.is_empty() {
            return Err(OnDemandError::SolanaInstructionsEmpty);
        }

        let mut pre_ixs = vec![];

        if let Some(compute_units) = self.compute_units {
            pre_ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(
                compute_units.clamp(200_000, 1_400_000),
            ));
        }
        // want this first so we unshift last
        if let Some(priority_fees) = self.priority_fees {
            pre_ixs.push(ComputeBudgetInstruction::set_compute_unit_price(
                std::cmp::min(10_000, priority_fees),
            ));
        }

        // Convert pre_ixs to compatible type
        let converted_pre_ixs: Vec<Instruction> = pre_ixs.iter().map(|ix| {
            Instruction {
                program_id: ix.program_id.to_bytes().into(),
                accounts: ix.accounts.iter().map(|acc| AccountMeta {
                    pubkey: acc.pubkey.to_bytes().into(),
                    is_signer: acc.is_signer,
                    is_writable: acc.is_writable,
                }).collect(),
                data: ix.data.clone(),
            }
        }).collect();

        let ixs = [converted_pre_ixs, self.ixs.clone()].concat();

        if ixs.len() > 10 {
            return Err(OnDemandError::SolanaInstructionOverflow);
        }

        Ok(ixs)
    }
    pub fn build_legacy_tx(
        payer: Pubkey,
        ixs: Vec<Instruction>,
        signers: Vec<&dyn Signer>,
        recent_blockhash: Hash,
    ) -> Result<Transaction, OnDemandError> {
        // Convert to anchor-client types
        let converted_ixs: Vec<anchor_client::solana_sdk::instruction::Instruction> = ixs.iter().map(|ix| {
            anchor_client::solana_sdk::instruction::Instruction {
                program_id: ix.program_id.to_bytes().into(),
                accounts: ix.accounts.iter().map(|acc| anchor_client::solana_sdk::instruction::AccountMeta {
                    pubkey: acc.pubkey.to_bytes().into(),
                    is_signer: acc.is_signer,
                    is_writable: acc.is_writable,
                }).collect(),
                data: ix.data.clone(),
            }
        }).collect();
        let converted_payer: anchor_client::solana_sdk::pubkey::Pubkey = payer.to_bytes().into();
        let converted_blockhash: anchor_client::solana_sdk::hash::Hash = recent_blockhash.to_bytes().into();

        let mut tx = Transaction::new_with_payer(&converted_ixs, Some(&converted_payer));
        tx.try_sign(&signers, converted_blockhash).map_err(|_| OnDemandError::SolanaSignError)?;
        Ok(tx)
    }
    pub fn to_legacy_tx(&self) -> Result<Transaction, OnDemandError> {
        if !self.has_payer() {
            return Err(OnDemandError::SolanaPayerSignerMissing);
        }

        TransactionBuilder::build_legacy_tx(
            self.payer,
            self.ixs()?,
            self.signers()?,
            self.recent_blockhash.unwrap_or_default(),
        )
    }
    pub fn to_legacy_tx_with_payer<T: AsSigner + Send + Sync>(
        &self,
        payer: T,
    ) -> Result<Transaction, OnDemandError> {
        if payer.as_signer().pubkey().to_bytes() != self.payer.to_bytes() {
            return Err(OnDemandError::SolanaPayerMismatch);
        }

        TransactionBuilder::build_legacy_tx(
            self.payer,
            self.ixs()?,
            self.signers_with_payer(&payer)?,
            self.recent_blockhash.unwrap_or_default(),
        )
    }
    pub fn to_legacy_tx_with_payer_and_blockhash<T: AsSigner + Send + Sync>(
        &self,
        payer: T,
        recent_blockhash: Option<Hash>,
    ) -> Result<Transaction, OnDemandError> {
        if payer.as_signer().pubkey().to_bytes() != self.payer.to_bytes() {
            return Err(OnDemandError::SolanaPayerMismatch);
        }

        TransactionBuilder::build_legacy_tx(
            self.payer,
            self.ixs()?,
            self.signers_with_payer(&payer)?,
            recent_blockhash.unwrap_or(self.recent_blockhash.unwrap_or_default()),
        )
    }
    pub fn to_legacy_tx_with_blockhash(
        &self,
        recent_blockhash: Option<Hash>,
    ) -> Result<Transaction, OnDemandError> {
        TransactionBuilder::build_legacy_tx(
            self.payer,
            self.ixs()?,
            self.signers()?,
            self.recent_blockhash
                .unwrap_or(recent_blockhash.unwrap_or_default()),
        )
    }

    pub async fn fetch_address_lookup_account(
        rpc: &RpcClient,
        address_lookup_table_pubkey: Pubkey,
    ) -> Result<AddressLookupTableAccount, OnDemandError> {
        let converted_pubkey: anchor_client::solana_sdk::pubkey::Pubkey = address_lookup_table_pubkey.to_bytes().into();
        let account = rpc
            .get_account(&converted_pubkey)
            .await
            .map_err(|_e| OnDemandError::NetworkError)?;
        let address_lookup_table =
            AddressLookupTable::deserialize(&account.data).map_err(|_| OnDemandError::AccountDeserializeError)?;
        let address_lookup_table_account = AddressLookupTableAccount {
            key: address_lookup_table_pubkey.to_bytes().into(),
            addresses: address_lookup_table.addresses.to_vec(),
        };
        Ok(address_lookup_table_account)
    }

    pub async fn fetch_multiple_address_lookup_accounts(
        rpc: &RpcClient,
        address_lookup_pubkeys: Vec<Pubkey>,
    ) -> Result<Vec<AddressLookupTableAccount>, OnDemandError> {
        let address_lookup_accounts: Vec<AddressLookupTableAccount> =
            if address_lookup_pubkeys.is_empty() {
                vec![]
            } else {
                let converted_pubkeys: Vec<anchor_client::solana_sdk::pubkey::Pubkey> = address_lookup_pubkeys.iter().map(|pk| pk.to_bytes().into()).collect();
                let accounts = rpc
                    .get_multiple_accounts(&converted_pubkeys)
                    .await
                    .map_err(|_| OnDemandError::NetworkError)?;

                let mut address_lookup_accounts: Vec<AddressLookupTableAccount> = vec![];
                for (i, account) in accounts.iter().enumerate() {
                    let account = account.as_ref().ok_or(OnDemandError::AccountNotFound)?;
                    let address_lookup_table = AddressLookupTable::deserialize(&account.data)
                        .map_err(|_| OnDemandError::AccountDeserializeError)?;
                    let address_lookup_table_account = AddressLookupTableAccount {
                        key: address_lookup_pubkeys[i].to_bytes().into(),
                        addresses: address_lookup_table.addresses.to_vec(),
                    };
                    address_lookup_accounts.push(address_lookup_table_account);
                }

                address_lookup_accounts
            };

        Ok(address_lookup_accounts)
    }

    pub fn build_v0_tx(
        payer: Pubkey,
        ixs: Vec<Instruction>,
        signers: Vec<&dyn Signer>,
        address_lookup_accounts: Vec<AddressLookupTableAccount>,
        recent_blockhash: Hash,
    ) -> Result<VersionedTransaction, OnDemandError> {
        // Convert types directly for solana_sdk compatibility
        let converted_payer: anchor_client::solana_sdk::pubkey::Pubkey = payer.to_bytes().into();
        let converted_ixs: Vec<anchor_client::solana_sdk::instruction::Instruction> = ixs.iter().map(|ix| {
            anchor_client::solana_sdk::instruction::Instruction {
                program_id: ix.program_id.to_bytes().into(),
                accounts: ix.accounts.iter().map(|acc| anchor_client::solana_sdk::instruction::AccountMeta {
                    pubkey: acc.pubkey.to_bytes().into(),
                    is_signer: acc.is_signer,
                    is_writable: acc.is_writable,
                }).collect(),
                data: ix.data.clone(),
            }
        }).collect();
        let converted_lookup_accounts: Vec<anchor_client::solana_sdk::message::AddressLookupTableAccount> = address_lookup_accounts.iter().map(|lut| {
            anchor_client::solana_sdk::message::AddressLookupTableAccount {
                key: lut.key.to_bytes().into(),
                addresses: lut.addresses.iter().map(|addr| addr.to_bytes().into()).collect(),
            }
        }).collect();
        let converted_blockhash: anchor_client::solana_sdk::hash::Hash = anchor_client::solana_sdk::hash::Hash::new_from_array(recent_blockhash.to_bytes());

        let v0_message = anchor_client::solana_sdk::message::v0::Message::try_compile(
            &converted_payer,
            &converted_ixs,
            &converted_lookup_accounts,
            converted_blockhash
        ).unwrap();

        let v0_tx = VersionedTransaction::try_new(anchor_client::solana_sdk::message::VersionedMessage::V0(v0_message), &signers)
            .unwrap();

        Ok(v0_tx)
    }

    pub fn to_v0_tx(&self) -> Result<VersionedTransaction, OnDemandError> {
        TransactionBuilder::build_v0_tx(
            self.payer,
            self.ixs()?,
            self.signers()?,
            self.address_lookup_tables.clone(),
            self.recent_blockhash.unwrap_or_default(),
        )
    }

    pub fn to_v0_tx_with_payer<T: AsSigner + Send + Sync>(
        &self,
        payer: T,
    ) -> Result<VersionedTransaction, OnDemandError> {
        if payer.as_signer().pubkey().to_bytes() != self.payer.to_bytes() {
            return Err(OnDemandError::SolanaPayerMismatch);
        }

        TransactionBuilder::build_v0_tx(
            self.payer,
            self.ixs()?,
            self.signers_with_payer(&payer)?,
            self.address_lookup_tables.clone(),
            self.recent_blockhash.unwrap_or_default(),
        )
    }
}

impl TryFrom<TransactionBuilder> for Transaction {
    type Error = OnDemandError;

    fn try_from(builder: TransactionBuilder) -> Result<Self, Self::Error> {
        builder.to_legacy_tx()
    }
}

impl TryFrom<TransactionBuilder> for VersionedTransaction {
    type Error = OnDemandError;

    fn try_from(builder: TransactionBuilder) -> Result<Self, Self::Error> {
        builder.to_v0_tx()
    }
}
// Types for TypeState builder pattern

// #[derive(Default, Clone)]
// pub struct EmptyIxs;

// #[derive(Default, Clone)]
// pub struct TransactionIxs(Vec<Instruction>);

// #[derive(Default, Clone)]
// pub struct TransactionBuilderV0<U> {
//     payer: Pubkey,
//     ixs: U,
//     compute_units: Option<u32>,
//     priority_fees: Option<u64>,
//     recent_blockhash: Option<Hash>,
//     min_context_slot: Option<u64>,
//     address_lookup_tables: Vec<Pubkey>,
//     signers: Vec<Arc<dyn AsSigner + Send + Sync>>,
// }
// impl TransactionBuilderV0<EmptyIxs> {
//     pub fn new(payer: Pubkey) -> Self {
//         Self {
//             payer,
//             ..Default::default()
//         }
//     }

//     pub fn add_ix(&self, ix: Instruction) -> TransactionBuilderV0<TransactionIxs> {
//         TransactionBuilderV0 {
//             payer: self.payer,
//             ixs: TransactionIxs(vec![ix]),
//             compute_units: self.compute_units,
//             priority_fees: self.priority_fees,
//             recent_blockhash: self.recent_blockhash,
//             min_context_slot: self.min_context_slot,
//             address_lookup_tables: self.address_lookup_tables.clone(),
//             signers: self.signers.clone(),
//         }
//     }
// }

#[cfg(test)]
mod tests {
    use super::*;
    use ::solana_program::instruction::AccountMeta;
    use anchor_client::solana_sdk::signer::keypair::Keypair;
    use tokio::sync::{OnceCell, RwLock};

    // #[test]
    // fn test_missing_signer() {
        // let program_id = Pubkey::new_unique();
        // let payer = Arc::new(Keypair::new());
        // let missing_signer = Arc::new(Keypair::new());
//
        // let ixn = Instruction::new_with_bytes(
            // program_id,
            // &vec![1u8, 2u8, 3u8, 4u8],
            // vec![
                // AccountMeta::new(payer.pubkey(), true),
                // AccountMeta::new_readonly(missing_signer.pubkey(), true), // missing signer here
                // AccountMeta::new_readonly(Pubkey::new_unique(), false),
            // ],
        // );
//
        // let mut tx = TransactionBuilder::new(payer.pubkey()).add_ix(ixn);
//
        // assert_eq!(tx.ixs().unwrap_or_default().len(), 1);
        // assert_eq!(tx.payer(), payer.pubkey());
        // assert!(!tx.has_payer());
//
        // // 1. Should fail with missing payer
        // let to_tx_result = tx.to_legacy_tx();
        // assert!(to_tx_result.is_err());
//
        // if let OnDemandError::SolanaPayerSignerMissing(expected_payer) =
            // to_tx_result.as_ref().unwrap_err()
        // {
            // if *expected_payer != payer.pubkey().to_string() {
                // panic!("Unexpected error message: {}", to_tx_result.unwrap_err())
            // }
        // } else {
            // panic!("Unexpected error: {:?}", to_tx_result.unwrap_err())
        // }
//
        // // 2. Should fail with missing signer
        // let to_tx_result = tx.to_legacy_tx_with_payer(payer.clone());
        // assert!(to_tx_result.is_err());
//
        // if let OnDemandError::SolanaMissingSigner(signer) = to_tx_result.as_ref().unwrap_err() {
            // if *signer != missing_signer.pubkey().to_string() {
                // panic!("Unexpected error message: {}", to_tx_result.unwrap_err())
            // }
        // } else {
            // panic!("Unexpected error: {:?}", to_tx_result.unwrap_err())
        // }
//
        // // 3. Should succeed with missing signer added
        // tx = tx.add_signer(missing_signer);
        // let to_tx_result = tx.to_legacy_tx_with_payer(payer.clone());
        // assert!(to_tx_result.is_ok());
    // }

    #[test]
    fn test_add_compute_budget_ixs() {
        let payer = Arc::new(Keypair::new());
        let payer_pubkey = payer.pubkey();
        let payer_pubkey_converted = ::solana_program::pubkey::Pubkey::new_from_array(payer_pubkey.to_bytes());

        let tx = TransactionBuilder::new_with_payer(payer.clone())
            .add_ix(Instruction::new_with_bytes(
                Pubkey::new_unique(),
                &vec![1u8, 2u8, 3u8, 4u8],
                vec![
                    AccountMeta::new(payer_pubkey_converted, true),
                    AccountMeta::new_readonly(Pubkey::new_unique(), false),
                ],
            ))
            .set_compute_units(750_000);
        assert_eq!(tx.ixs().unwrap_or_default().len(), 2);

        let tx = TransactionBuilder::new_with_payer(payer.clone())
            .add_ix(Instruction::new_with_bytes(
                Pubkey::new_unique(),
                &vec![1u8, 2u8, 3u8, 4u8],
                vec![
                    AccountMeta::new(payer_pubkey_converted, true),
                    AccountMeta::new_readonly(Pubkey::new_unique(), false),
                ],
            ))
            .set_priority_fees(500);
        assert_eq!(tx.ixs().unwrap_or_default().len(), 2);

        let tx = TransactionBuilder::new_with_payer(payer.clone())
            .add_ix(Instruction::new_with_bytes(
                Pubkey::new_unique(),
                &vec![1u8, 2u8, 3u8, 4u8],
                vec![
                    AccountMeta::new(payer_pubkey_converted, true),
                    AccountMeta::new_readonly(Pubkey::new_unique(), false),
                ],
            ))
            .set_compute_units(750_000)
            .set_priority_fees(500);
        assert_eq!(tx.ixs().unwrap_or_default().len(), 3);
    }

    #[test]
    fn test_transaction_builder_with_arc_payer() {
        let payer = Arc::new(Keypair::new());

        let tx = TransactionBuilder::new_with_payer(payer.clone())
            .add_ix(Instruction::new_with_bytes(
                Pubkey::new_unique(),
                &vec![1u8, 2u8, 3u8, 4u8],
                vec![
                    AccountMeta::new(payer.signer_pubkey(), true),
                    AccountMeta::new_readonly(Pubkey::new_unique(), false),
                ],
            ))
            .set_compute_units(750_000);

        assert_eq!(tx.payer.to_bytes(), payer.pubkey().to_bytes());
    }

    pub static PAYER_KEYPAIR: OnceCell<Arc<RwLock<Arc<Keypair>>>> = OnceCell::const_new();

    async fn get_payer_keypair() -> &'static Arc<RwLock<Arc<Keypair>>> {
        PAYER_KEYPAIR
            .get_or_init(|| async { Arc::new(RwLock::new(Arc::new(Keypair::new()))) })
            .await
    }

    #[tokio::test]
    async fn test_transaction_builder_with_rwlock_payer() {
        let payer = get_payer_keypair().await;
        let payer_arc = payer.read().await.clone();

        let tx = TransactionBuilder::new_with_payer(payer_arc.clone())
            .add_ix(Instruction::new_with_bytes(
                Pubkey::new_unique(),
                &vec![1u8, 2u8, 3u8, 4u8],
                vec![
                    AccountMeta::new(payer_arc.signer_pubkey(), true),
                    AccountMeta::new_readonly(Pubkey::new_unique(), false),
                ],
            ))
            .set_compute_units(750_000);

        assert_eq!(tx.payer.to_bytes(), payer_arc.pubkey().to_bytes());
    }

    #[tokio::test]
    async fn test_transaction_builder_with_arcswap_payer() {
        let payer = arc_swap::ArcSwap::new(Arc::new(Keypair::new()));
        let payer_arc = payer.load();

        let tx = TransactionBuilder::new_with_payer(payer_arc.clone())
            .add_ix(Instruction::new_with_bytes(
                Pubkey::new_unique(),
                &vec![1u8, 2u8, 3u8, 4u8],
                vec![
                    AccountMeta::new(payer_arc.signer_pubkey(), true),
                    AccountMeta::new_readonly(Pubkey::new_unique(), false),
                ],
            ))
            .set_compute_units(750_000);

        assert_eq!(tx.payer.to_bytes(), payer_arc.pubkey().to_bytes());
    }
}
