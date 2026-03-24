use anchor_lang::prelude::*;

pub const PROP_AMM_REGISTRY_SEED: &[u8] = b"prop_amm_registry";
pub const PROP_AMM_REGISTRY_VERSION: u8 = 1;
pub const PROP_AMM_STATUS_DISABLED: u8 = 0;
pub const PROP_AMM_STATUS_ACTIVE: u8 = 1;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord,
)]
pub struct PropAmmKey {
    pub market_index: u16,
    pub maker_subaccount: Pubkey,
    pub propamm_program: Pubkey,
    pub propamm_account: Pubkey,
}

impl PropAmmKey {
    pub const SPACE: usize = 2 + 32 + 32 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PropAmmApprovalParams {
    pub market_index: u16,
    pub maker_subaccount: Pubkey,
    pub propamm_program: Pubkey,
    pub propamm_account: Pubkey,
}

impl PropAmmApprovalParams {
    pub fn key(&self) -> PropAmmKey {
        PropAmmKey {
            market_index: self.market_index,
            maker_subaccount: self.maker_subaccount,
            propamm_program: self.propamm_program,
            propamm_account: self.propamm_account,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PropAmmRegistryEntry {
    pub status: u8,
    pub market_index: u16,
    pub maker_subaccount: Pubkey,
    pub propamm_program: Pubkey,
    pub propamm_account: Pubkey,
}

impl PropAmmRegistryEntry {
    pub const SPACE: usize = 1 + PropAmmKey::SPACE;

    pub fn key(&self) -> PropAmmKey {
        PropAmmKey {
            market_index: self.market_index,
            maker_subaccount: self.maker_subaccount,
            propamm_program: self.propamm_program,
            propamm_account: self.propamm_account,
        }
    }

    pub fn is_active(&self) -> bool {
        self.status == PROP_AMM_STATUS_ACTIVE
    }

    pub fn from_approval(params: &PropAmmApprovalParams) -> Self {
        Self {
            status: PROP_AMM_STATUS_ACTIVE,
            market_index: params.market_index,
            maker_subaccount: params.maker_subaccount,
            propamm_program: params.propamm_program,
            propamm_account: params.propamm_account,
        }
    }
}

#[account]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct PropAmmRegistry {
    pub version: u8,
    pub entries: Vec<PropAmmRegistryEntry>,
}

impl PropAmmRegistry {
    pub fn new() -> Self {
        Self {
            version: PROP_AMM_REGISTRY_VERSION,
            entries: Vec::new(),
        }
    }

    pub fn space(num_entries: usize) -> usize {
        8 + 1 + 4 + (num_entries * PropAmmRegistryEntry::SPACE)
    }

    pub fn upsert(&mut self, approval: &PropAmmApprovalParams) {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.key() == approval.key())
        {
            entry.status = PROP_AMM_STATUS_ACTIVE;
            return;
        }

        self.entries
            .push(PropAmmRegistryEntry::from_approval(approval));
    }

    pub fn disable(&mut self, key: &PropAmmKey) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.key() == *key) {
            entry.status = PROP_AMM_STATUS_DISABLED;
        }
    }

    pub fn remove(&mut self, key: &PropAmmKey) {
        if let Some(index) = self.entries.iter().position(|entry| entry.key() == *key) {
            self.entries.swap_remove(index);
        }
    }

    /// Returns true if any active entry lists the given program as its `propamm_program`.
    pub fn has_active_program(&self, program_id: &Pubkey) -> bool {
        self.entries
            .iter()
            .any(|e| e.is_active() && e.propamm_program == *program_id)
    }

    /// Look up an active entry by its `propamm_account` key.
    pub fn find_active_entry(&self, propamm_account: &Pubkey) -> Option<&PropAmmRegistryEntry> {
        self.entries
            .iter()
            .find(|e| e.is_active() && e.propamm_account == *propamm_account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(
        market_index: u16,
        maker_byte: u8,
        program_byte: u8,
        account_byte: u8,
    ) -> PropAmmApprovalParams {
        PropAmmApprovalParams {
            market_index,
            maker_subaccount: Pubkey::new_from_array([maker_byte; 32]),
            propamm_program: Pubkey::new_from_array([program_byte; 32]),
            propamm_account: Pubkey::new_from_array([account_byte; 32]),
        }
    }

    #[test]
    fn upsert_inserts_and_reactivates() {
        let mut registry = PropAmmRegistry::new();
        let first = approval(1, 1, 2, 3);

        registry.upsert(&first);
        assert_eq!(registry.entries.len(), 1);
        assert!(registry.entries[0].is_active());

        registry.disable(&first.key());
        assert!(!registry.entries[0].is_active());

        registry.upsert(&first);
        assert_eq!(registry.entries.len(), 1);
        assert!(registry.entries[0].is_active());
    }

    #[test]
    fn remove_is_idempotent() {
        let mut registry = PropAmmRegistry::new();
        let first = approval(1, 1, 2, 3);
        let second = approval(2, 4, 5, 6);

        registry.upsert(&first);
        registry.upsert(&second);
        registry.remove(&first.key());
        assert_eq!(registry.entries.len(), 1);
        assert_eq!(registry.entries[0].key(), second.key());

        registry.remove(&first.key());
        assert_eq!(registry.entries.len(), 1);
    }

    #[test]
    fn space_scales_with_entries() {
        assert_eq!(PropAmmRegistry::space(0), 13);
        assert_eq!(
            PropAmmRegistry::space(2),
            13 + 2 * PropAmmRegistryEntry::SPACE
        );
    }
}
