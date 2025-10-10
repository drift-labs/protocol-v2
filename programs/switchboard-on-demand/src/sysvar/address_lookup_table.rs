use crate::Pubkey;

use crate::{cfg_client, utils, ON_DEMAND_DEVNET_PID, ON_DEMAND_MAINNET_PID};

const LUT_SIGNER_SEED: &[u8] = b"LutSigner";

/// Finds the address lookup table signer PDA for a given key
pub fn find_lut_signer<K: AsRef<[u8]>, P: From<[u8; 32]>>(k: &K) -> P {
    let pid = if utils::is_devnet() {
        ON_DEMAND_DEVNET_PID
    } else {
        ON_DEMAND_MAINNET_PID
    };
    let (pk, _) = Pubkey::find_program_address(&[LUT_SIGNER_SEED, k.as_ref()], &pid);
    P::from(pk.to_bytes())
}

cfg_client! {
    use crate::OnDemandError;
    use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
    use spl_associated_token_account::solana_program::address_lookup_table::state::AddressLookupTable;
    use spl_associated_token_account::solana_program::address_lookup_table::AddressLookupTableAccount;

    pub async fn fetch(client: &RpcClient, address: &Pubkey) -> Result<AddressLookupTableAccount, OnDemandError> {
        let converted_address: anchor_client::solana_sdk::pubkey::Pubkey = address.to_bytes().into();
        let account = client.get_account_data(&converted_address)
            .await
            .map_err(|_| OnDemandError::AddressLookupTableFetchError)?;
        let lut = AddressLookupTable::deserialize(&account)
            .map_err(|_| OnDemandError::AddressLookupTableDeserializeError)?;
        let out = AddressLookupTableAccount {
            key: address.to_bytes().into(),
            addresses: lut.addresses.iter().cloned().collect(),
        };
        Ok(out)
    }
}
