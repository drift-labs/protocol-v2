use std::error::Error;

use anchor_client::{
    anchor_lang::__private::base64,
    solana_sdk::{bs58, signature::Keypair},
};

pub fn http_to_ws_url(url: &str) -> String {
    if url.starts_with("https") {
        return url.replace("https", "wss");
    }
    url.replace("http", "ws")
}

pub fn read_keypair_str_multi_format(data: String) -> Result<Keypair, Box<dyn Error>> {
    // strip out any white spaces and new line/carriage return characters
    let data = data.replace([' ', '\n', '\r'], "");

    // first try to decode as json numbers array
    if data.starts_with('[') && data.ends_with(']') {
        // decode the numbers array into json string
        let bytes: Vec<u8> = serde_json::from_str(data.as_str())?;
        let dalek_keypair = Keypair::from_bytes(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        return Ok(dalek_keypair);
    }

    // then try to decode as normal numbers array, without square brackets
    if data.contains(',') {
        // decode the numbers array into json string
        let bytes: Vec<u8> = serde_json::from_str(format!("[{}]", data).as_str())?;
        let dalek_keypair = Keypair::from_bytes(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        return Ok(dalek_keypair);
    }

    // try to decode as base58 string
    if let Ok(bytes) = bs58::decode(data.as_str()).into_vec() {
        let dalek_keypair = Keypair::from_bytes(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        return Ok(dalek_keypair);
    };

    // try to decode as base64 string
    if let Ok(bytes) = base64::decode(data.as_str()) {
        let dalek_keypair = Keypair::from_bytes(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        return Ok(dalek_keypair);
    };

    Err(Box::new(std::io::Error::new(
        std::io::ErrorKind::Other,
        "failed to decode keypair",
    )))
}

/// Reads a `Keypair` from a file, supports json format and base58 format.
pub fn read_keypair_file_multi_format(path: &str) -> Result<Keypair, Box<dyn Error>> {
    let data = std::fs::read_to_string(path)?;
    read_keypair_str_multi_format(data)
}

#[cfg(test)]
mod tests {
    use anchor_client::solana_sdk::signer::Signer;

    use super::*;

    #[test]
    fn test_keypair_from_json_numbers_array() {
        let keypair_data = "[17,188,105,73,182,3,56,125,157,20,12,82,88,197,181,202,251,248,97,103,215,165,233,145,114,254,20,89,100,79,207,168,206,103,77,58,215,94,196,155,224,116,73,74,62,200,30,248,101,102,164,126,6,170,77,190,186,142,107,222,3,242,143,155]";

        let keypair = read_keypair_str_multi_format(keypair_data.to_string()).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }

    #[test]
    fn test_keypair_from_json_comma_seperated_numbers() {
        let keypair_data = "17,188,105,73,182,3,56,125,157,20,12,82,88,197,181,202,251,248,97,103,215,165,233,145,114,254,20,89,100,79,207,168,206,103,77,58,215,94,196,155,224,116,73,74,62,200,30,248,101,102,164,126,6,170,77,190,186,142,107,222,3,242,143,155";

        let keypair = read_keypair_str_multi_format(keypair_data.to_string()).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }

    #[test]
    fn test_keypair_from_base58_string() {
        let keypair_data = "MZsY4Vme2Xa417rhh1MUGCru9oYNDxCjH1TZRWJPNSzRmZmodjczVaGuWKgzBsoKxx2ZLQZjUWTkLu44jE5DhSJ";

        let keypair = read_keypair_str_multi_format(keypair_data.to_string()).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }

    #[test]
    fn test_keypair_from_base64_string() {
        let keypair_data = "EbxpSbYDOH2dFAxSWMW1yvv4YWfXpemRcv4UWWRPz6jOZ006117Em+B0SUo+yB74ZWakfgaqTb66jmveA/KPmw==";

        let keypair = read_keypair_str_multi_format(keypair_data.to_string()).unwrap();
        assert!(keypair.pubkey().to_string() == "EtiM5qwcrrawQP9FfRErBatNvDgEU656tk5aA8iTgqri");
    }
}
