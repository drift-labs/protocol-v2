use crate::error::ClearingHouseResult;

pub fn get_signer_seeds<'a>(nonce: &'a u8) -> [&'a [u8]; 2] {
    [b"clearing_house_signer".as_ref(), bytemuck::bytes_of(nonce)]
}
