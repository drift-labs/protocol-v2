use anchor_lang::prelude::{AccountInfo, Pubkey};

pub fn create_account_info<'a>(
    key: &'a Pubkey,
    is_writable: bool,
    lamports: &'a mut u64,
    bytes: &'a mut [u8],
    owner: &'a Pubkey,
) -> AccountInfo<'a> {
    AccountInfo::new(key, false, is_writable, lamports, bytes, owner, false)
}

#[macro_export]
macro_rules! create_account_info {
    ($account:expr, $owner:expr, $name: ident) => {
        let key = Pubkey::default();
        let mut lamports = 0;
        let mut data = get_account_bytes(&mut $account);
        let owner = $type::owner();
        let $name = create_account_info(&key, true, &mut lamports, &mut data[..], $owner);
    };
    ($account:expr, $pubkey:expr, $owner:expr, $name: ident) => {
        let mut lamports = 0;
        let mut data = get_account_bytes(&mut $account);
        let $name = create_account_info($pubkey, true, &mut lamports, &mut data[..], $owner);
    };
}
