pub const QUOTE_DISCRIMINATOR: &[u8; 8] = b"SBOracle";

#[macro_export]
macro_rules! switchboard_anchor_bindings {
    () => {
        pub const __QUOTE_OWNER_PIDS: &[Pubkey] = &[
            switchboard_on_demand::QUOTE_PROGRAM_ID,
            crate::ID,
        ];

        /// Macro to generate Anchor bindings for Switchboard quote accounts
        #[derive(Debug, PartialEq, Eq, Clone, Copy, AnchorDeserialize, AnchorSerialize)]
        #[repr(C)]
        pub struct SwitchboardQuote {
            pub queue: [u8; 32],
            pub data: [u8; 1024],
        }

        unsafe impl bytemuck::Pod for SwitchboardQuote {}
        unsafe impl bytemuck::Zeroable for SwitchboardQuote {}

        impl Discriminator for SwitchboardQuote {
            const DISCRIMINATOR: &[u8] = switchboard_on_demand::quote_account::QUOTE_DISCRIMINATOR;
        }

        impl AccountSerialize for SwitchboardQuote {
            fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
                writer.write_all(Self::DISCRIMINATOR)?;
                writer.write_all(bytemuck::bytes_of(self))?;
                Ok(())
            }
        }

        impl AccountDeserialize for SwitchboardQuote {
            fn try_deserialize(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
                if buf.len() < Self::DISCRIMINATOR.len() {
                    return Err(anchor_lang::error::ErrorCode::AccountDiscriminatorNotFound.into());
                }
                let given_disc = &buf[..Self::DISCRIMINATOR.len()];
                if given_disc != Self::DISCRIMINATOR {
                    return Err(anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch.into());
                }
                *buf = &buf[Self::DISCRIMINATOR.len()..];
                Self::try_deserialize_unchecked(buf)
            }

            fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
                if buf.len() < std::mem::size_of::<Self>() {
                    return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                }
                let data = bytemuck::try_from_bytes(&buf[..std::mem::size_of::<Self>()])
                    .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;
                *buf = &buf[std::mem::size_of::<Self>()..];
                Ok(*data)
            }
        }

        impl SwitchboardQuote {
            pub const LEN: usize = 32 + 1024 + 8;

            /// Extracts feed information from the oracle quote data
            ///
            /// Parses the stored oracle quote data and returns a slice of PackedFeedInfo
            /// structures containing feed IDs, values, and minimum oracle samples.
            ///
            /// # Returns
            /// A slice of PackedFeedInfo structures, or an empty slice if no valid feeds are found
            ///
            /// # Example
            /// ```rust
            /// let feeds = quote.feeds();
            /// for feed in feeds {
            ///     println!("Feed {}: {}", feed.hex_id(), feed.value());
            /// }
            /// ```
            pub fn feeds(&self) -> &[switchboard_on_demand::on_demand::oracle_quote::feed_info::PackedFeedInfo] {
                use core::ptr::read_unaligned;

                // Check if we have enough data for length prefix
                if self.data.len() < 2 {
                    return &[];
                }

                unsafe {
                    // Read the length prefix (first 2 bytes)
                    let data_len = read_unaligned(self.data.as_ptr() as *const u16) as usize;

                    // Ensure we have enough data
                    if self.data.len() < data_len + 2 || data_len < 13 {
                        return &[];
                    }

                    // Skip the length prefix and parse the ED25519 instruction data
                    let instruction_data = &self.data[2..data_len + 2];

                    // Parse the instruction to extract feed information
                    match switchboard_on_demand::sysvar::ed25519_sysvar::Ed25519Sysvar::parse_instruction(instruction_data)
                    {
                        Ok((parsed_sigs, sig_count, _, _, _)) => {
                            if sig_count > 0 {
                                // Get feed info from the first signature
                                parsed_sigs[0].feed_infos()
                            } else {
                                &[]
                            }
                        }
                        Err(_) => &[],
                    }
                }
            }

            /// Get the canonical oracle account public key for the given feed IDs
            ///
            /// This method derives the canonical oracle account that the quote program
            /// creates and manages for storing verified oracle data.
            ///
            /// ## Parameters
            /// - `feed_ids`: Array of feed ID byte arrays (32 bytes each)
            /// - `program_id`: The quote program ID to use for derivation
            ///
            /// ## Returns
            /// The canonical oracle account public key
            ///
            /// ## Example
            /// ```rust
            /// let oracle_key = SwitchboardQuote::get_canonical_key(&queue_key, &[feed_id_bytes], &quote_program_id);
            /// ```
            pub fn get_canonical_key(queue_key: &Pubkey, feed_ids: &[&[u8; 32]], program_id: &Pubkey) -> Pubkey {
                let mut seeds: Vec<&[u8]> = Vec::with_capacity(feed_ids.len() + 1);
                seeds.push(queue_key.as_ref());
                for id in feed_ids {
                    seeds.push(id.as_slice());
                }
                let (oracle_account, _) = Pubkey::find_program_address(&seeds, program_id);
                oracle_account
            }

            /// Get the canonical oracle account for this quote's feeds
            ///
            /// Convenience method that extracts feed IDs from the current quote
            /// and derives the canonical oracle account using the provided owner.
            ///
            /// ## Parameters
            /// - `queue_key`: The queue public key to use as the first seed
            /// - `owner`: The program ID that owns this oracle account (usually the quote program)
            ///
            /// ## Returns
            /// The canonical oracle account public key for this quote's feeds
            ///
            /// ## Example
            /// ```rust
            /// let canonical_key = quote.canonical_key(&queue_key, &oracle_account.owner);
            /// ```
            pub fn canonical_key(&self, queue_key: &Pubkey, owner: &Pubkey) -> Pubkey {
                let feed_ids: Vec<&[u8; 32]> = self.feeds().iter().map(|feed| feed.feed_id()).collect();
                Self::get_canonical_key(queue_key, &feed_ids, owner)
            }
        }

        impl anchor_lang::Owner for SwitchboardQuote {
            fn owner() -> anchor_lang::solana_program::pubkey::Pubkey {
                crate::ID
            }
        }

        impl anchor_lang::ZeroCopy for SwitchboardQuote {}

        impl anchor_lang::Owners for SwitchboardQuote {
            fn owners() -> &'static [anchor_lang::solana_program::pubkey::Pubkey] {
                __QUOTE_OWNER_PIDS
            }
        }

        /// Extension trait to provide convenient methods for Anchor InterfaceAccount<SwitchboardQuote>
        pub trait SwitchboardQuoteExt<'a> {
            /// Get the canonical oracle account key for this quote's feeds
            fn canonical_key(&self, queue: &Pubkey) -> Pubkey;
            //
            // /// Get the canonical oracle account key for this quote's feeds with a specific owner
            // fn canonical_key_with_owner(&self, owner: &Pubkey) -> Pubkey;

            /// Get the owner of the account
            fn owner(&self) -> &Pubkey;

            /// Get feeds from the oracle quote
            fn feeds(&self) -> &[switchboard_on_demand::on_demand::oracle_quote::feed_info::PackedFeedInfo];

            /// Write oracle quote data from an ED25519 instruction with slot validation
            fn write_from_ix<'b, I>(&mut self, ix_sysvar: I, curr_slot: u64, instruction_index: usize)
            where
                I: AsRef<anchor_lang::prelude::AccountInfo<'b>>;

            /// Write oracle quote data from an ED25519 instruction without slot validation.
            ///
            /// # ⚠️ WARNING ⚠️
            /// **This method bypasses critical security validations. See [`OracleQuote::write_from_ix_unchecked`] for detailed security warnings.**
            ///
            /// [`OracleQuote::write_from_ix_unchecked`]: crate::on_demand::oracle_quote::OracleQuote::write_from_ix_unchecked
            fn write_from_ix_unchecked<'b, I>(&mut self, ix_sysvar: I, instruction_index: usize)
            where
                I: AsRef<anchor_lang::prelude::AccountInfo<'b>>;

            /// Check if the account is initialized by checking the last 4 bytes are SBOD
            fn is_initialized(&self) -> bool;

            /// if !is_initialized, return if the new quotes canonical key matches the account key
            /// else just check if the account key match the new quotes
            fn keys_match(&self, quote: &switchboard_on_demand::on_demand::oracle_quote::OracleQuote) -> bool;
        }

        impl<'info> SwitchboardQuoteExt<'info>
            for anchor_lang::prelude::InterfaceAccount<'info, SwitchboardQuote>
            {
                fn canonical_key(&self, queue: &Pubkey) -> Pubkey {
                    (**self).canonical_key(queue, self.to_account_info().owner)
                }

                fn owner(&self) -> &Pubkey {
                    self.to_account_info().owner
                }

                fn feeds(&self) -> &[switchboard_on_demand::on_demand::oracle_quote::feed_info::PackedFeedInfo] {
                    (**self).feeds()
                }

                fn write_from_ix<'b, I>(&mut self, ix_sysvar: I, curr_slot: u64, instruction_index: usize)
                where
                    I: AsRef<anchor_lang::prelude::AccountInfo<'b>>,
                {
                    let ix_sysvar = ix_sysvar.as_ref();
                    let data = switchboard_on_demand::Instructions::extract_ix_data(ix_sysvar, instruction_index);
                    switchboard_on_demand::on_demand::oracle_quote::OracleQuote::write(curr_slot, data, &self.queue, &self.to_account_info());
                }

                fn write_from_ix_unchecked<'b, I>(&mut self, ix_sysvar: I, instruction_index: usize)
                where
                    I: AsRef<anchor_lang::prelude::AccountInfo<'b>>,
                {
                    let ix_sysvar = ix_sysvar.as_ref();
                    let data = switchboard_on_demand::Instructions::extract_ix_data(ix_sysvar, instruction_index);
                    switchboard_on_demand::on_demand::oracle_quote::OracleQuote::write_unchecked(data, &self.queue, &self.to_account_info());
                }

                fn is_initialized(&self) -> bool {
                    static tail_discriminator: u32 = u32::from_le_bytes(*b"SBOD");
                    let account_info = self.to_account_info();
                    let data = account_info.data.borrow();
                    if data.len() < 4 {
                        return false;
                    }
                    if let Ok(last_four) = data[data.len() - 4..].try_into() {
                        let marker = u32::from_le_bytes(last_four);
                        marker == tail_discriminator
                    } else {
                        false
                    }
                }

                fn keys_match(&self, quote: &switchboard_on_demand::on_demand::oracle_quote::OracleQuote) -> bool {
                    if !self.is_initialized() {
                        return false;
                    }
                    let own_feeds = self.feeds();
                    let other_feeds = quote.feeds();
                    if own_feeds.len() != other_feeds.len() {
                        return false;
                    }
                    for i in 0..own_feeds.len() {
                        if !switchboard_on_demand::check_pubkey_eq(own_feeds[i].feed_id(), other_feeds[i].feed_id()) {
                            return false;
                        }
                    }
                    true
                }
            }
    };
}
