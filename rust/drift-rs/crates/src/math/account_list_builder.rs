use crate::solana_sdk::pubkey::Pubkey;
use ahash::{HashMap, HashMapExt};

use drift::sdk::{VelocityAccounts, OwnedAccount};

use crate::{
    constants::{self, oracle_source_to_owner},
    types::accounts::User,
    utils::zero_account_to_bytes,
    DriftClient, MarketId, SdkError, SdkResult,
};

/// Builds a list of users's associated spot, perp, and oracle accounts
///
/// Produces a `drift::sdk::VelocityAccounts` ready to pass into
/// `drift::sdk::calculate_margin` (or any other drift-sdk entry that takes
/// owned account data).
///
/// ```example(no_run)
/// let mut builder = AccountsListBuilder::default();
/// let accounts = builder.try_build(client, user, &[]).expect("build accounts");
/// let margin = drift::sdk::calculate_margin(user, &mut accounts, ctx);
/// ```
#[derive(Default)]
pub struct AccountsListBuilder {
    accounts: VelocityAccounts,
}

fn into_owned(owner: Pubkey, data: Vec<u8>) -> OwnedAccount {
    OwnedAccount {
        lamports: 0,
        data,
        owner,
        executable: false,
    }
}

impl AccountsListBuilder {
    /// Constructs an accounts list from `user` positions sync
    ///
    /// Relies on the `client` being subscribed to all the necessary markets
    /// and oracles — no network I/O.
    pub fn try_build(
        &mut self,
        client: &DriftClient,
        user: &User,
        force_markets: &[MarketId],
    ) -> SdkResult<&mut VelocityAccounts> {
        let mut oracle_markets = HashMap::<Pubkey, MarketId>::with_capacity(16);
        let drift_state_account = client.state_account()?;

        let force_spot_iter = force_markets
            .iter()
            .filter(|m| m.is_spot())
            .map(|m| m.index());

        let spot_market_idxs = ahash::HashSet::from_iter(
            user.spot_positions
                .iter()
                .filter(|p| !p.is_available())
                .map(|p| p.market_index)
                .chain(force_spot_iter)
                .chain(std::iter::once(MarketId::QUOTE_SPOT.index())),
        );

        for idx in spot_market_idxs {
            let market = client.try_get_spot_market_account(idx)?;
            oracle_markets.insert(market.oracle, MarketId::spot(market.market_index));
            let pubkey = market.pubkey;
            self.accounts.spot_markets.push((
                pubkey,
                into_owned(constants::PROGRAM_ID, zero_account_to_bytes(market)),
            ));
        }

        let force_perp_iter = force_markets
            .iter()
            .filter(|m| m.is_perp())
            .map(|m| m.index());
        let perp_market_idxs = ahash::HashSet::from_iter(
            user.perp_positions
                .iter()
                .filter(|p| !p.is_available())
                .map(|p| p.market_index)
                .chain(force_perp_iter),
        );

        for idx in perp_market_idxs {
            let market = client.try_get_perp_market_account(idx)?;
            oracle_markets.insert(market.oracle, MarketId::perp(market.market_index));
            let pubkey = market.pubkey;
            self.accounts.perp_markets.push((
                pubkey,
                into_owned(constants::PROGRAM_ID, zero_account_to_bytes(market)),
            ));
        }

        let mut latest_oracle_slot = 0;
        for (oracle_key, market) in oracle_markets.iter() {
            let oracle = client
                .try_get_oracle_price_data_and_slot(*market)
                .ok_or(SdkError::NoMarketData(*market))?;

            latest_oracle_slot = oracle.slot.max(latest_oracle_slot);
            let oracle_owner = oracle_source_to_owner(client.context, oracle.source);
            self.accounts
                .oracles
                .push((*oracle_key, into_owned(oracle_owner, oracle.raw)));
        }

        self.accounts.latest_slot = latest_oracle_slot;
        self.accounts.oracle_guard_rails = Some(unsafe {
            std::mem::transmute_copy::<_, drift::state::state::OracleGuardRails>(
                &drift_state_account.oracle_guard_rails,
            )
        });

        Ok(&mut self.accounts)
    }

    /// Like `try_build` but falls back to RPC to fetch missing markets/oracles.
    pub async fn build(
        &mut self,
        client: &DriftClient,
        user: &User,
        force_markets: &[MarketId],
    ) -> SdkResult<&mut VelocityAccounts> {
        let mut oracle_markets = HashMap::<Pubkey, MarketId>::with_capacity(16);
        let drift_state_account = client.state_account()?;

        let force_spot_iter = force_markets
            .iter()
            .filter(|m| m.is_spot())
            .map(|m| m.index());
        let spot_market_idxs = ahash::HashSet::from_iter(
            user.spot_positions
                .iter()
                .filter(|p| !p.is_available())
                .map(|p| p.market_index)
                .chain(force_spot_iter)
                .chain(std::iter::once(MarketId::QUOTE_SPOT.index())),
        );

        for market_idx in spot_market_idxs.iter() {
            let market = client.get_spot_market_account(*market_idx).await?;
            oracle_markets.insert(market.oracle, MarketId::spot(market.market_index));
            let pubkey = market.pubkey;
            self.accounts.spot_markets.push((
                pubkey,
                into_owned(constants::PROGRAM_ID, zero_account_to_bytes(market)),
            ));
        }

        let force_perp_iter = force_markets
            .iter()
            .filter(|m| m.is_perp())
            .map(|m| m.index());
        let perp_market_idxs = ahash::HashSet::from_iter(
            user.perp_positions
                .iter()
                .filter(|p| !p.is_available())
                .map(|p| p.market_index)
                .chain(force_perp_iter),
        );

        for market_idx in perp_market_idxs.iter() {
            let market = client.get_perp_market_account(*market_idx).await?;
            oracle_markets.insert(market.oracle, MarketId::perp(market.market_index));
            let pubkey = market.pubkey;
            self.accounts.perp_markets.push((
                pubkey,
                into_owned(constants::PROGRAM_ID, zero_account_to_bytes(market)),
            ));
        }

        let mut latest_oracle_slot = 0;
        for (oracle_key, market) in oracle_markets.iter() {
            let oracle = client.get_oracle_price_data_and_slot(*market).await?;

            latest_oracle_slot = oracle.slot.max(latest_oracle_slot);
            let oracle_owner = oracle_source_to_owner(client.context, oracle.source);
            self.accounts
                .oracles
                .push((*oracle_key, into_owned(oracle_owner, oracle.raw)));
        }

        self.accounts.latest_slot = latest_oracle_slot;
        self.accounts.oracle_guard_rails = Some(unsafe {
            std::mem::transmute_copy::<_, drift::state::state::OracleGuardRails>(
                &drift_state_account.oracle_guard_rails,
            )
        });

        Ok(&mut self.accounts)
    }
}
