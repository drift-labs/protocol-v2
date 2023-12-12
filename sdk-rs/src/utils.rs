//! SDK utility functions

use solana_sdk::{bs58, signature::Keypair};

// kudos @wphan
/// Try to parse secret `key` string
///
/// Returns error if the key cannot be parsed
pub fn read_keypair_str_multi_format(key: &str) -> Result<Keypair, ()> {
    // strip out any white spaces and new line/carriage return characters
    let key = key.replace([' ', '\n', '\r', '[', ']'], "");

    // first try to decode as a byte array
    if key.contains(',') {
        // decode the numbers array into json string
        let bytes: Result<Vec<u8>, _> = key.split(',').map(|x| x.parse::<u8>()).collect();
        if let Ok(bytes) = bytes {
            return Keypair::from_bytes(&bytes).map_err(|_| ());
        } else {
            return Err(());
        }
    }

    // try to decode as base58 string
    let bytes = bs58::decode(key).into_vec().map_err(|_| ())?;
    Keypair::from_bytes(&bytes).map_err(|_| ())
}

/// Try load a `Keypair` from a file path or given string, supports json format and base58 format.
pub fn load_keypair_multi_format(path_or_key: &str) -> Result<Keypair, ()> {
    if let Ok(data) = std::fs::read_to_string(path_or_key) {
        read_keypair_str_multi_format(data.as_str())
    } else {
        read_keypair_str_multi_format(path_or_key)
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
}
