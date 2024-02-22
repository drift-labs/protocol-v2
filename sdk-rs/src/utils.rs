//! SDK utility functions

use anchor_lang::AccountDeserialize;
use serde_json::json;
use solana_account_decoder::UiAccountData;
use solana_sdk::{
    account::Account, address_lookup_table_account::AddressLookupTableAccount, bs58,
    pubkey::Pubkey, signature::Keypair,
};

use crate::types::{SdkError, SdkResult};

// kudos @wphan
/// Try to parse secret `key` string
///
/// Returns error if the key cannot be parsed
pub fn read_keypair_str_multi_format(key: &str) -> SdkResult<Keypair> {
    // strip out any white spaces and new line/carriage return characters
    let key = key.replace([' ', '\n', '\r', '[', ']'], "");

    // first try to decode as a byte array
    if key.contains(',') {
        // decode the numbers array into json string
        let bytes: Result<Vec<u8>, _> = key.split(',').map(|x| x.parse::<u8>()).collect();
        if let Ok(bytes) = bytes {
            return Keypair::from_bytes(&bytes).map_err(|_| SdkError::InvalidSeed);
        } else {
            return Err(SdkError::InvalidSeed);
        }
    }

    // try to decode as base58 string
    if let Ok(bytes) = bs58::decode(key.as_bytes()).into_vec() {
        return Keypair::from_bytes(&bytes).map_err(|_| SdkError::InvalidSeed);
    }

    // try to decode as base64 string
    if let Ok(bytes) = base64::decode(key.as_bytes()) {
        return Keypair::from_bytes(&bytes).map_err(|_| SdkError::InvalidSeed);
    }

    Err(SdkError::InvalidSeed)
}

/// Try load a `Keypair` from a file path or given string, supports json format and base58 format.
pub fn load_keypair_multi_format(path_or_key: &str) -> SdkResult<Keypair> {
    if let Ok(data) = std::fs::read_to_string(path_or_key) {
        read_keypair_str_multi_format(data.as_str())
    } else {
        read_keypair_str_multi_format(path_or_key)
    }
}

const LOOKUP_TABLE_META_SIZE: usize = 56;

/// modified from sdk.1.17.x
/// https://docs.rs/solana-program/latest/src/solana_program/address_lookup_table/state.rs.html#192
pub fn deserialize_alt(address: Pubkey, account: &Account) -> SdkResult<AddressLookupTableAccount> {
    let raw_addresses_data: &[u8] = account.data.get(LOOKUP_TABLE_META_SIZE..).ok_or({
        // Should be impossible because table accounts must
        // always be LOOKUP_TABLE_META_SIZE in length
        SdkError::InvalidAccount
    })?;
    let addresses = bytemuck::try_cast_slice(raw_addresses_data).map_err(|_| {
        // Should be impossible because raw address data
        // should be aligned and sized in multiples of 32 bytes
        SdkError::InvalidAccount
    })?;

    Ok(AddressLookupTableAccount {
        key: address,
        addresses: addresses.to_vec(),
    })
}

pub fn http_to_ws(url: &str) -> Result<String, &'static str> {
    let base_url = if url.starts_with("http://") {
        url.replacen("http://", "ws://", 1)
    } else if url.starts_with("https://") {
        url.replacen("https://", "wss://", 1)
    } else {
        return Err("Invalid URL scheme");
    };

    Ok(format!("{}/ws", base_url.trim_end_matches('/')))
}

pub fn dlob_subscribe_ws_json(market: &str) -> String {
    json!({
        "type": "subscribe",
        "marketType": if market.ends_with("perp") {
            "perp"
        } else {
            "spot"
        },
        "channel": "orderbook",
        "market": market,
    })
    .to_string()
}

#[inline(always)]
pub fn decode<T>(data: UiAccountData) -> SdkResult<T>
where
    T: AccountDeserialize,
{
    let data_str = match data {
        UiAccountData::Binary(encoded, _) => encoded,
        _ => return Err(SdkError::UnsupportedAccountData),
    };

    let decoded_data = base64::decode(data_str)?;
    let mut decoded_data_slice = decoded_data.as_slice();

    T::try_deserialize(&mut decoded_data_slice).map_err(|err| SdkError::Anchor(Box::new(err)))
}

#[cfg(any(test, test_utils))]
pub mod envs {
    //! test env vars
    use solana_sdk::signature::Keypair;

    /// solana mainnet endpoint
    pub fn mainnet_endpoint() -> String {
        std::env::var("TEST_MAINNET_ENDPOINT").expect("TEST_MAINNET_ENDPOINT set")
    }
    /// keypair for integration tests
    pub fn test_keypair() -> Keypair {
        let private_key = std::env::var("TEST_PRIVATE_KEY").expect("TEST_PRIVATE_KEY set");
        Keypair::from_base58_string(private_key.as_str())
    }
}

#[cfg(test)]
mod tests {
    use solana_sdk::signer::Signer;

    use super::*;

    #[test]
    fn test_keypair_from_json_numbers_array() {
        let keypair_data = "[17,188,105,73,182,3,56,125,157,20,12,82,88,197,181,202,251,248,97,103,215,165,233,145,114,254,20,89,100,79,207,168,206,103,77,58,215,94,196,155,224,116,73,74,62,200,30,248,101,102,164,126,6,170,77,190,186,142,107,222,3,242,143,155]";

        let keypair = read_keypair_str_multi_format(keypair_data).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }

    #[test]
    fn test_keypair_from_json_comma_separated_numbers() {
        let keypair_data = "17,188,105,73,182,3,56,125,157,20,12,82,88,197,181,202,251,248,97,103,215,165,233,145,114,254,20,89,100,79,207,168,206,103,77,58,215,94,196,155,224,116,73,74,62,200,30,248,101,102,164,126,6,170,77,190,186,142,107,222,3,242,143,155";

        let keypair = read_keypair_str_multi_format(keypair_data).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }

    #[test]
    fn test_keypair_from_base58_string() {
        let keypair_data = "MZsY4Vme2Xa417rhh1MUGCru9oYNDxCjH1TZRWJPNSzRmZmodjczVaGuWKgzBsoKxx2ZLQZjUWTkLu44jE5DhSJ";

        let keypair = read_keypair_str_multi_format(keypair_data).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }

    #[test]
    fn test_keypair_from_base64_string() {
        let keypair_data = "EbxpSbYDOH2dFAxSWMW1yvv4YWfXpemRcv4UWWRPz6jOZ006117Em+B0SUo+yB74ZWakfgaqTb66jmveA/KPmw==";

        let keypair = read_keypair_str_multi_format(keypair_data).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }

    #[test]
    fn test_https_to_ws() {
        let https_url = "https://dlob.drift.trade";
        assert!(http_to_ws(https_url).unwrap() == "wss://dlob.drift.trade/ws");
        let http_url = "http://dlob.drift.trade";
        assert!(http_to_ws(http_url).unwrap() == "ws://dlob.drift.trade/ws")
    }
}
