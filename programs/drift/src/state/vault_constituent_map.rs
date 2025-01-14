use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::{Discriminator, Key};
use anchor_lang::prelude::{AccountInfo, Pubkey};
use arrayref::array_ref;
use std::collections::{BTreeMap, BTreeSet};
use std::iter::Peekable;
use std::panic::Location;
use std::cell::{Ref, RefMut};
use std::slice::Iter;

use solana_program::msg;

use crate::error::{DriftResult, ErrorCode};
use crate::state::vault_constituent::Constituent;
use crate::state::vault::Vault;
use crate::state::traits::Size;

pub struct VaultConstituentMap<'a>(pub BTreeMap<Pubkey, AccountLoader<'a, Constituent>>);

impl<'a> VaultConstituentMap<'a> {
    #[track_caller]
    #[inline(always)]
    pub fn get_ref(&self, key: &Pubkey) -> DriftResult<Ref<Constituent>> {
        let loader = match self.0.get(key) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find constituent {} at {}:{}",
                    key,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::ConstituentNotFound);
            }
        };

        match loader.load() {
            Ok(constituent) => Ok(constituent),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not load constituent {} at {}:{}",
                    key,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToLoadConstituent)
            }
        }
    }

    pub fn load<'b, 'c>(
		vault: &Vault,
        writable_constituents: &'b ConstituentSet,
        account_info_iter: &'c mut Peekable<Iter<'a, AccountInfo<'a>>>,
    ) -> DriftResult<VaultConstituentMap<'a>> {
        let mut vault_constituent_map = VaultConstituentMap(BTreeMap::new());

        let constituent_discriminator: [u8; 8] = Constituent::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::UnableToLoadConstituent))?;

			msg!("loading constituent {}", account_info.key());

            let expected_data_len = Constituent::SIZE;
            if data.len() < expected_data_len {
                break;
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &constituent_discriminator {
                break;
            }

			if !vault.constituents.contains(&account_info.key()) {
				break;
			}

			let is_writable = account_info.is_writable;
			if writable_constituents.contains(&account_info.key()) && !is_writable {
				return Err(ErrorCode::ConstituentWrongMutability);
			}

			if vault_constituent_map.0.contains_key(&account_info.key()) {
				msg!("Can not include same constituent twice {}", account_info.key());
				return Err(ErrorCode::UnableToLoadConstituent);
			}

			let account_loader: AccountLoader<Constituent> =
				AccountLoader::try_from(account_info).or(Err(ErrorCode::UnableToLoadConstituent))?;
			msg!("Loaded constituent {}", account_info.key());

			vault_constituent_map.0.insert(account_info.key(), account_loader);
        }

		Ok(vault_constituent_map)
    }
}

#[cfg(test)]
impl<'a> VaultConstituentMap<'a> {
	pub fn load_multiple<'c: 'a>(
        account_info: Vec<&'c AccountInfo<'a>>,
	) -> DriftResult<VaultConstituentMap<'a>> {
        let mut vault_constituent_map = VaultConstituentMap(BTreeMap::new());

        let constituent_discriminator: [u8; 8] = Constituent::discriminator();
        let account_info_iter = account_info.into_iter();
        for account_info in account_info_iter {
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::UnableToLoadConstituent))?;

			let expected_data_len = Constituent::SIZE;
			if data.len() < expected_data_len {
				break;
			}

			let account_discriminator = array_ref![data, 0, 8];
			if account_discriminator != &constituent_discriminator {
				break;
			}

			let account_loader: AccountLoader<Constituent> =
				AccountLoader::try_from(account_info).or(Err(ErrorCode::UnableToLoadConstituent))?;

			vault_constituent_map.0.insert(account_info.key(), account_loader);
		}

		Ok(vault_constituent_map)
	}
}

pub(crate) type ConstituentSet = BTreeSet<Pubkey>;

pub fn get_writable_constituent_set(constituent_index: Pubkey) -> ConstituentSet {
    let mut writable_constituents = ConstituentSet::new();
    writable_constituents.insert(constituent_index);
    writable_constituents
}

pub fn get_writable_constituent_set_from_vec(constituent_indexes: &[Pubkey]) -> ConstituentSet {
    let mut writable_constituents = ConstituentSet::new();
    for constituent_index in constituent_indexes.iter() {
        writable_constituents.insert(*constituent_index);
    }
    writable_constituents
}
