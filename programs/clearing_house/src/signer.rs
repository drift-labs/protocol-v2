pub fn get_signer_seeds(nonce: &u8) -> [&[u8]; 2] {
    [b"clearing_house_signer".as_ref(), bytemuck::bytes_of(nonce)]
}
