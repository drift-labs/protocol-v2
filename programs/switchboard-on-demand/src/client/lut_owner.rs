#[allow(unused_imports)]
use crate::*;
use anyhow::anyhow;
use anyhow::Error as AnyhowError;
use crate::solana_compat::solana_client::nonblocking::rpc_client::RpcClient;
use anchor_client::solana_sdk::address_lookup_table::instruction::derive_lookup_table_address;
use anchor_client::solana_sdk::address_lookup_table::state::AddressLookupTable;
use anchor_client::solana_sdk::address_lookup_table::AddressLookupTableAccount;
use crate::Pubkey;

pub trait LutOwner {
    fn lut_slot(&self) -> u64;
}

pub async fn load_lookup_table<T: LutOwner + bytemuck::Pod>(
    client: &RpcClient,
    self_key: Pubkey,
) -> Result<AddressLookupTableAccount, AnyhowError> {
    let account = client
        .get_account_data(&self_key.to_bytes().into())
        .await
        .map_err(|_| anyhow!("LutOwner.load_lookup_table: Oracle not found"))?;
    let account = account[8..].to_vec();
    let data = bytemuck::try_from_bytes::<T>(&account)
        .map_err(|_| anyhow!("LutOwner.load_lookup_table: Invalid data"))?;
    let lut_slot = data.lut_slot();
    let lut_signer: Pubkey = find_lut_signer(&self_key);
    let lut_key: anchor_client::solana_sdk::pubkey::Pubkey = derive_lookup_table_address(&lut_signer.to_bytes().into(), lut_slot).0;
    let lut_account = client
        .get_account_data(&lut_key.to_bytes().into())
        .await
        .map_err(|_| anyhow!("LutOwner.load_lookup_table: LUT not found"))?;
    let parsed_lut = AddressLookupTable::deserialize(&lut_account)
        .map_err(|_| anyhow!("LutOwner.load_lookup_table: Invalid LUT data"))?;
    Ok(AddressLookupTableAccount {
        addresses: parsed_lut.addresses.to_vec(),
        key: lut_key,
    })
}

pub async fn load_lookup_tables<T: LutOwner + bytemuck::Pod>(
    client: &RpcClient,
    keys: &[Pubkey],
) -> Result<Vec<AddressLookupTableAccount>, AnyhowError> {
    // Account data uses v3 Pubkey, but RpcClient expects v2 Pubkey
    let keys_v2: Vec<_> = keys.iter().map(|k| k.to_bytes().into()).collect();
    let accounts_data = client
        .get_multiple_accounts(&keys_v2)
        .await?
        .into_iter()
        .map(|acct| match acct {
            Some(account) => account.data.get(8..).unwrap_or(&[]).to_vec(),
            None => vec![],
        })
        .collect::<Vec<_>>();
    let mut lut_keys = Vec::new();
    let mut out = Vec::new();
    for (idx, account) in accounts_data.iter().enumerate() {
        let data = bytemuck::try_from_bytes::<T>(account);
        if data.is_err() {
            continue;
        }
        let lut_slot = data.unwrap().lut_slot();
        let lut_signer = find_lut_signer(&keys[idx]);
        let lut_key = derive_lookup_table_address(&lut_signer, lut_slot).0;
        lut_keys.push(lut_key.to_bytes().into());
    }
    let lut_datas = client
        .get_multiple_accounts(lut_keys.as_slice())
        .await?
        .into_iter()
        .map(|data| data.unwrap_or_default().data.to_vec())
        .collect::<Vec<Vec<u8>>>();
    for (idx, lut_data) in lut_datas.iter().enumerate() {
        let parsed_lut = AddressLookupTable::deserialize(lut_data);
        if let Ok(parsed_lut) = parsed_lut {
            out.push(AddressLookupTableAccount {
                addresses: parsed_lut.addresses.to_vec(),
                key: lut_keys[idx].to_bytes().into(),
            });
        }
    }
    Ok(out)
}
