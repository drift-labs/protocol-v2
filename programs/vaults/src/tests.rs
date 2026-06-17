#[cfg(test)]
mod vault_fcn {
    use std::str::FromStr;

    use crate::state::traits::VaultDepositorBase;
    use crate::test_utils::create_account_info;
    use crate::withdraw_request::WithdrawRequest;
    use crate::{assert_eq_within, Vault, VaultDepositor, WithdrawUnit};
    use anchor_lang::prelude::{AccountLoader, Pubkey};
    use drift::math::constants::{
        ONE_YEAR, QUOTE_PRECISION, QUOTE_PRECISION_I64, QUOTE_PRECISION_U64,
    };
    use drift::math::insurance::if_shares_to_vault_amount as depositor_shares_to_vault_amount;

    #[test]
    fn test_manager_withdraw() {
        let now = 0;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 1000; // 10 bps
        vault.redeem_period = 60;

        let mut vault_equity = 0;
        let amount = 100_000_000; // $100
        vault
            .manager_deposit(&mut vp, &mut None, amount, vault_equity, now, 0)
            .unwrap();
        vault_equity += amount;
        vault_equity -= 1;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        assert_eq!(vault.total_deposits, 100000000);
        assert_eq!(vault.manager_total_deposits, 100000000);
        assert_eq!(vault.manager_total_withdraws, 0);

        vault
            .manager_request_withdraw(
                &mut vp,
                &mut None,
                amount - 1,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        assert_eq!(vault.total_deposits, 100000000);
        assert_eq!(vault.manager_total_deposits, 100000000);
        assert_eq!(vault.manager_total_withdraws, 0);

        let err = vault
            .manager_withdraw(&mut vp, &mut None, vault_equity, now + 50, 0)
            .is_err();
        assert!(err);

        let withdraw = vault
            .manager_withdraw(&mut vp, &mut None, vault_equity, now + 60, 0)
            .unwrap();
        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.total_deposits, 100000000);
        assert_eq!(vault.manager_total_deposits, 100000000);
        assert_eq!(vault.manager_total_withdraws, 99999999);
        assert_eq!(withdraw, 99999999);
    }

    #[test]
    fn test_smol_management_fee() {
        let now = 0;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 1000; // 10 bps

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(amount, vault_equity, &mut vault, &mut vp, &mut None, now, 0)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.last_fee_update_ts, 0);
        vault_equity += amount;

        let user_eq_before =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(user_eq_before, 100000000);

        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now + ONE_YEAR as i64)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200200200);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 99900000);

        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_excessive_management_fee() {
        let now = 1000;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 1000000;
        vault.last_fee_update_ts = 0;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(amount, vault_equity, &mut vault, &mut vp, &mut None, now, 0)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.shares_base, 0);
        assert_eq!(vault.last_fee_update_ts, 1000);
        vault_equity += amount;

        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now + ONE_YEAR as i64)
            .unwrap();
        assert_eq!(vault.user_shares, 10);
        assert_eq!(vault.total_shares, 2000000000);
        assert_eq!(vault.shares_base, 7);

        let vd_amount_left =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(vd_amount_left, 1);
        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_management_fee_high_frequency() {
        // asymptotic nature of calling -100% annualized on shorter time scale
        let mut now = 0;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 1000000; // 100%
        vault.last_fee_update_ts = 0;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(amount, vault_equity, &mut vault, &mut vp, &mut None, now, 0)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.shares_base, 0);
        // assert_eq!(vault.last_fee_update_ts(, 1000);
        vault_equity += amount;

        while now < ONE_YEAR as i64 {
            vault
                .apply_fee(&mut vp, &mut None, vault_equity, now)
                .unwrap();
            now += 60 * 60 * 24 * 7; // every week
        }
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now)
            .unwrap();

        let vd_amount_left =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(vd_amount_left, 35832760); // ~$35
        assert_eq!(vault.last_fee_update_ts, now);
    }

    #[test]
    fn test_manager_alone_deposit_withdraw() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 100; // .01%
        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(&mut vp, &mut None, amount, vault_equity, now, 0)
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        now += 60 * 60;

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 100000000);

        vault
            .manager_request_withdraw(
                &mut vp,
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        let withdrew = vault
            .manager_withdraw(&mut vp, &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount, withdrew);
        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 0);

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 0);
    }

    #[test]
    fn test_negative_management_fee() {
        let now = 0;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = -2_147_483_648; // -214700% annualized (manager pays 24% hourly, .4% per minute)

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(amount, vault_equity, &mut vault, &mut vp, &mut None, now, 0)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.last_fee_update_ts, 0);
        vault_equity += amount;

        let user_eq_before =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(user_eq_before, 100000000);

        // one second since inception
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now + 1_i64)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 199986200);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 100006900); // up half a cent

        // one minute since inception
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now + 60_i64)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 199185855);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 100408736); // up 40 cents

        // one year since inception
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now + ONE_YEAR as i64)
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 100000000);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 200000000); // up $100

        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_negative_management_fee_manager_alone() {
        let mut now = 0;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = -2_147_483_648; // -214700% annualized (manager pays 24% hourly, .4% per minute)
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        now += 100000;
        vault
            .manager_deposit(&mut vp, &mut None, amount, vault_equity, now, 0)
            .unwrap();

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, amount as u128);
        assert_eq!(vault.last_fee_update_ts, now);
        vault_equity += amount;

        now += 100000;
        vault
            .manager_request_withdraw(
                &mut vp,
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        let withdrew = vault
            .manager_withdraw(&mut vp, &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(withdrew, amount);
    }

    #[test]
    fn test_manager_deposit_withdraw_with_user_flat() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 0;
        vault.profit_share = 150_000; // 15%

        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(&mut vp, &mut None, amount, vault_equity, now, 0)
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        now += 60 * 60;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount * 20,
            vault_equity,
            &mut vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000000000 + 100000000);
        vault_equity += amount * 20;

        now += 60 * 60 * 24; // 1 day later

        vd.apply_profit_share(vault_equity, &mut vault, &mut vp, now)
            .unwrap();
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now)
            .unwrap();

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 100000000);
        vault
            .manager_request_withdraw(
                &mut vp,
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        let withdrew = vault
            .manager_withdraw(&mut vp, &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount, withdrew);
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000000000);

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 0);
    }

    #[test]
    fn test_manager_deposit_withdraw_with_user_manager_fee_loss() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 100; // .01%
        vault.profit_share = 150000; // 15%

        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(&mut vp, &mut None, amount, vault_equity, now, 0)
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        now += 60 * 60;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount * 20,
            vault_equity,
            &mut vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000000000 + 100000000);
        vault_equity += amount * 20;

        let mut cnt = 0;
        while (vault.total_shares == 2000000000 + 100000000) && cnt < 400 {
            now += 60 * 60 * 24; // 1 day later

            vd.apply_profit_share(vault_equity, &mut vault, &mut vp, now)
                .unwrap();
            vault
                .apply_fee(&mut vp, &mut None, vault_equity, now)
                .unwrap();
            // crate::msg!("vault last ts: {} vs {}", vault.last_fee_update_ts, now);
            cnt += 1;
        }

        assert_eq!(cnt, 4); // 4 days

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 100001999);
        vault
            .manager_request_withdraw(
                &mut vp,
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        let withdrew = vault
            .manager_withdraw(&mut vp, &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount, withdrew);
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000002000);
        vault_equity -= withdrew;

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 1999); // gainz

        let vd_amount = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(vd_amount, 1999998000); // loss

        assert_eq!(vd_amount + vault_manager_amount_after, vault_equity - 1);
    }

    #[test]
    fn test_manager_deposit_withdraw_with_user_gain() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 100; // .01%
        vault.profit_share = 150000; // 15%

        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(&mut vp, &mut None, amount, vault_equity, now, 0)
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        now += 60 * 60;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount * 20,
            vault_equity,
            &mut vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000000000 + 100000000);
        vault_equity += amount * 20;

        // up 50%
        vault_equity *= 3;
        vault_equity /= 2;

        assert_eq!(vault_equity, 3_150_000_000);

        let mut cnt = 0;
        while (vault.total_shares == 2000000000 + 100000000) && cnt < 400 {
            now += 60 * 60 * 24; // 1 day later

            vd.apply_profit_share(vault_equity, &mut vault, &mut vp, now)
                .unwrap();
            vault
                .apply_fee(&mut vp, &mut None, vault_equity, now)
                .unwrap();
            // crate::msg!("vault last ts: {} vs {}", vault.last_fee_update_ts, now);
            cnt += 1;
        }

        assert_eq!(cnt, 4); // 4 days
        assert_eq!(
            vd.cumulative_profit_share_amount,
            (850 * QUOTE_PRECISION_U64) as i64 // 1000 - 15% profit share
        );
        assert_eq!(vd.net_deposits, (2000 * QUOTE_PRECISION_U64) as i64);

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 300002849); //$300??

        vault
            .manager_request_withdraw(
                &mut vp,
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        assert_eq!(amount, vault.last_manager_withdraw_request.value);

        let withdrew = vault
            .manager_withdraw(&mut vp, &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount - 1, withdrew); // todo: slight round out of favor
        assert_eq!(vault.user_shares, 1900000000);
        assert_eq!(vault.total_shares, 2033335367);
        vault_equity -= withdrew;

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 200_002_850); // gainz

        let vd_amount = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(vd_amount, 2_849_997_150); // gainz

        assert_eq!(vd_amount + vault_manager_amount_after, vault_equity - 1);
    }

    #[test]
    fn test_vd_withdraw_on_drawdown() {
        let mut now = 123456789;
        let vault = &mut Vault::default();

        let mut vault_equity: u64 = 0;
        let deposit_amount: u64 = 100 * QUOTE_PRECISION_U64;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.shares_base, 0);

        let vd = &mut VaultDepositor::new(
            Pubkey::default(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            now,
        );
        vd.deposit(
            deposit_amount,
            vault_equity,
            vault,
            &mut None,
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        let vd_shares = vd.get_vault_shares();
        now += 100;
        assert_eq!(vault.user_shares, deposit_amount as u128);
        assert_eq!(vault.total_shares, deposit_amount as u128);
        assert_eq!(vd.get_vault_shares(), vault.user_shares);
        assert_eq!(vd.get_vault_shares_base(), vault.shares_base);
        vault_equity += deposit_amount;

        // down 50%
        vault_equity /= 2;
        now += 100;

        // user withdraws
        vd.request_withdraw(
            vd_shares as u64,
            WithdrawUnit::Shares,
            vault_equity,
            vault,
            &mut None,
            &mut None,
            now,
            0,
        )
        .expect("request withdraw");

        assert_eq!(
            vd.last_withdraw_request,
            WithdrawRequest {
                shares: vd_shares,
                value: vault_equity,
                ts: now,
            }
        );

        // down another 50%
        vault_equity /= 2;
        now += 100;

        let (withdraw_amount, finishing_liquidation) = vd
            .withdraw(vault_equity, vault, &mut None, &mut None, now, 0)
            .expect("withdraw");
        assert_eq!(withdraw_amount, vault_equity);
        assert!(!finishing_liquidation);
    }

    #[test]
    fn test_vd_request_withdraw_after_rebase() {
        let mut now = 123456789;
        let vault = &mut Vault::default();
        let mut vp = None;

        let mut vault_equity: u64 = 0;
        let deposit_amount: u64 = 100 * QUOTE_PRECISION_U64;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.shares_base, 0);

        let vd = &mut VaultDepositor::new(
            Pubkey::default(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            now,
        );
        vd.deposit(
            deposit_amount,
            vault_equity,
            vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        let vd_shares = vd.checked_vault_shares(vault).unwrap();
        now += 100;
        assert_eq!(vault.user_shares, deposit_amount as u128);
        assert_eq!(vault.total_shares, deposit_amount as u128);
        assert_eq!(vault.shares_base, 0);
        assert_eq!(vd.checked_vault_shares(vault).unwrap(), vault.user_shares);
        assert_eq!(vd.vault_shares_base, vault.shares_base);
        vault_equity += deposit_amount;

        // down 99.9%
        vault_equity /= 1000;
        now += 100;

        // request_withdraw triggers rebase
        vd.request_withdraw(
            vd_shares as u64,
            WithdrawUnit::Shares,
            vault_equity,
            vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .expect("request withdraw");

        assert_eq!(
            vd.last_withdraw_request,
            WithdrawRequest {
                shares: vd_shares / 100, // expected rebase by expo_diff 2
                value: vault_equity,
                ts: now,
            }
        );

        println!(
            "last_withdraw_request 1: {:?}, vault eq: {}",
            vd.last_withdraw_request, vault_equity
        );

        // // down another 50%
        // vault_equity /= 2;
        now += 100;

        let (withdraw_amount, finishing_liquidation) = vd
            .withdraw(vault_equity, vault, &mut vp, &mut None, now, 0)
            .expect("withdraw");
        assert_eq!(withdraw_amount, vault_equity);
        println!(
            "final withdraw_amount 1: {}, vault eq: {}",
            withdraw_amount, vault_equity
        );
        assert!(!finishing_liquidation);
    }

    #[test]
    fn test_vd_request_withdraw_before_rebase() {
        let mut now = 123456789;
        let vault = &mut Vault::default();
        let mut vp = None;

        let mut vault_equity: u64 = 0;
        let deposit_amount: u64 = 100 * QUOTE_PRECISION_U64;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.shares_base, 0);

        let vd = &mut VaultDepositor::new(
            Pubkey::default(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            now,
        );
        vd.deposit(
            deposit_amount,
            vault_equity,
            vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        let vd_shares = vd.checked_vault_shares(vault).unwrap();
        now += 100;
        assert_eq!(vault.user_shares, deposit_amount as u128);
        assert_eq!(vault.total_shares, deposit_amount as u128);
        assert_eq!(vault.shares_base, 0);
        assert_eq!(vd.checked_vault_shares(vault).unwrap(), vault.user_shares);
        assert_eq!(vd.vault_shares_base, vault.shares_base);
        vault_equity += deposit_amount;

        vd.request_withdraw(
            vd_shares as u64,
            WithdrawUnit::Shares,
            vault_equity,
            vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .expect("request withdraw");

        assert_eq!(
            vd.last_withdraw_request,
            WithdrawRequest {
                shares: vd_shares,
                value: vault_equity,
                ts: now,
            }
        );
        println!(
            "last_withdraw_request 2: {:?}, vault equity: {}",
            vd.last_withdraw_request, vault_equity
        );

        // down 99.9%
        vault_equity /= 1000;
        now += 100;

        // withdraw will trigger a rebase
        let (withdraw_amount, finishing_liquidation) = vd
            .withdraw(vault_equity, vault, &mut None, &mut None, now, 0)
            .expect("withdraw");
        assert_eq!(withdraw_amount, vault_equity);
        println!(
            "final withdraw_amount 2: {}, vault eq: {}",
            withdraw_amount, vault_equity
        );
        assert!(!finishing_liquidation);
    }

    #[test]
    fn test_apply_profit_share_on_net_hwm() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let mut vp = None;
        vault.management_fee = 0;
        vault.profit_share = 100_000; // 10%
        vault.last_fee_update_ts = now;

        let mut vault_equity: u64 = 0;

        let deposit_amount = 2000 * QUOTE_PRECISION_U64;
        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            deposit_amount,
            vault_equity,
            &mut vault,
            &mut vp,
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        vault_equity += deposit_amount;

        let depositor_amount_before = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(depositor_amount_before, vault_equity);

        // vault up 10% (user +$200 gross, +$180 net)
        now += 60 * 60 * 24; // 1 day later
        vault_equity = 2200 * QUOTE_PRECISION_U64;

        vd.apply_profit_share(vault_equity, &mut vault, &mut vp, now)
            .unwrap();
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now)
            .unwrap();

        let depositor_amount_in_profit = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(depositor_amount_in_profit, 2180 * QUOTE_PRECISION_U64);
        assert_eq!(vd.cumulative_profit_share_amount, 180 * QUOTE_PRECISION_I64);
        assert_eq!(vd.profit_share_fee_paid, 20 * QUOTE_PRECISION_U64);
        assert_eq!(vault.total_shares, 2000 * QUOTE_PRECISION);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 1_981_818_182);

        // vault drawdown 10%
        now += 60 * 60 * 24; // 1 day later
        vault_equity = 1980 * QUOTE_PRECISION_U64;

        vd.apply_profit_share(vault_equity, &mut vault, &mut vp, now)
            .unwrap();
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now)
            .unwrap();

        let depositor_amount_in_drawdown = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(depositor_amount_in_drawdown, 1962 * QUOTE_PRECISION_U64);
        assert_eq!(vd.cumulative_profit_share_amount, 180 * QUOTE_PRECISION_I64);
        assert_eq!(vd.profit_share_fee_paid, 20 * QUOTE_PRECISION_U64);
        assert_eq!(vault.total_shares, 2000 * QUOTE_PRECISION);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 1_981_818_182);

        // in profit again (above net hwm (2180), below gross hwm (2200))
        // vd equity = 2210*1982/2000 = 2190
        now += 60 * 60 * 24; // 1 day later
        vault_equity = 2210 * QUOTE_PRECISION_U64;

        vd.apply_profit_share(vault_equity, &mut vault, &mut vp, now)
            .unwrap();
        vault
            .apply_fee(&mut vp, &mut None, vault_equity, now)
            .unwrap();

        let depositor_amount_in_profit = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(depositor_amount_in_profit, 2_188_918_182);
        assert_eq!(vd.cumulative_profit_share_amount, 188_918_182);
        assert_eq!(vd.profit_share_fee_paid, 20_990_909);
        assert_eq!(vault.total_shares, 2000 * QUOTE_PRECISION);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 1_980_921_432);
    }

    // Fixture bytes were captured under the pre-anchor-1.0 Vault layout; needs regeneration.
    #[test]
    #[ignore]
    fn apply_profit_share_on_net_hwm_example() {
        let vault_str = String::from("0wjoKwKYdXdTdXBlcmNoYXJnZXIgVmF1bHQgICAgICAgICAgICAgIObOTURhcaZ/hexxlaSKNnYv57PHIZx9B8zN8k75zR8X5YskhtQuJRuc1ZuimumplgthmeBFASQW793js7pxldJCFqweTOnzcxGL+XKJx2Lif7339IdAC/KyKj8JEFZwkobFx9kGlk72vtua5uHjyHSzAViuG0/APV227Zmg8aZjmuxoym5eTWKAUNtoEdxsbA9c5IdRusnrLgc4WGs7FVYLef8oRnsVQX7JdnHagGAmJsU0t+iRQjIn8UdUnf8jwgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQjcnBxIEAAAAAAAAAAAAAMeNOt6kBAAAAAAAAAAAAAC5KoFnAAAAAAAAAAAAAAAAgDoJAAAAAADHSjWPHAAAAADgV+tIGwAAAAAAAAAAAADTz/tkAAAAAHycB+TTAgAAAEibJrr///8aotBlLSwAAJ4FyYFZKQAAAAAAAAAAAAAAuGTZRQAAAAAAAAAAAAAAEQ28vgkBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ//V2YAAAAAAAAAAOCTBAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        let mut vault_decoded_bytes = base64::decode(vault_str).unwrap();
        let vault_bytes = vault_decoded_bytes.as_mut_slice();
        let mut lamports = 0;
        let key = Pubkey::default();
        let owner = Pubkey::from_str("vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR").unwrap();
        let vault_account_info =
            create_account_info(&key, true, &mut lamports, vault_bytes, &owner);
        let vault_loader: AccountLoader<Vault> =
            AccountLoader::try_from(&vault_account_info).unwrap();

        let vd_str = String::from("V222aldgP9Pmzk1EYXGmf4XscZWkijZ2L+ezxyGcfQfMzfJO+c0fF3+94atStThJMBa2OKTfUXJGJXPLv0FNp+KPmd6vhnmEDTcLJRUaWdAPxV7zBY0GiaKVHFu9h+8uxW0VlL9rvWTAzbMLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHJ+VZgAAAAAAAAAAAAAAAABJfw8AAAAAAEl/DwAAAAAAAAAAAAAAAKkKggIAAAAAypzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        let mut vd_decoded_bytes = base64::decode(vd_str).unwrap();
        let vd_bytes = vd_decoded_bytes.as_mut_slice();
        let mut lamports = 0;
        let key = Pubkey::default();
        let owner = Pubkey::from_str("vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR").unwrap();
        let vd_account_info = create_account_info(&key, true, &mut lamports, vd_bytes, &owner);
        let vd_loader: AccountLoader<VaultDepositor> =
            AccountLoader::try_from(&vd_account_info).unwrap();

        let mut vault = vault_loader.load_mut().unwrap();
        let mut vd = vd_loader.load_mut().unwrap();
        let mut vp = None;

        let vault_equity = 8_045_367_880_000;
        let vd_amount = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault.profit_share, 300_000);
        let manager_total_profit_share_before = vault.manager_total_profit_share;
        assert_eq!(manager_total_profit_share_before, 1_141_366_328_593);

        let vd_hwm_before =
            (vd.total_deposits - vd.total_withdraws) as i64 + vd.cumulative_profit_share_amount;
        let unrealized_profit_before = vd_amount as i64 - vd_hwm_before;

        assert_eq!(vd_amount, 309_346_825);
        assert_eq!(vd_hwm_before, 302_076_841);
        assert_eq!(unrealized_profit_before, 7_269_984);

        let (manager_profit_share, protocol_profit_share) = vd
            .apply_profit_share(vault_equity, &mut vault, &mut vp, 0)
            .unwrap();

        assert_eq!(manager_profit_share, 2_180_995);
        assert_eq!(protocol_profit_share, 0);

        let vd_amount = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        let vd_hwm =
            (vd.total_deposits - vd.total_withdraws) as i64 + vd.cumulative_profit_share_amount;
        let unrealized_profit = vd_amount as i64 - vd_hwm;

        assert_eq!(vd_amount, 307_165_832);
        assert_eq_within!(
            vd_hwm,
            vd_hwm_before + unrealized_profit_before * 700_000 / 1_000_000,
            1
        ); // hwm increased by net pnl net of fees
        assert_eq!(unrealized_profit, 2);

        assert_eq!(
            vault.manager_total_profit_share,
            manager_total_profit_share_before + manager_profit_share
        );
    }
}

#[cfg(test)]
mod vault_v1_fcn {
    use std::cell::RefCell;

    use anchor_lang::prelude::Pubkey;
    use drift::math::constants::{ONE_YEAR, QUOTE_PRECISION_U64};
    use drift::math::insurance::if_shares_to_vault_amount as depositor_shares_to_vault_amount;

    use crate::state::{Vault, VaultDepositorBase, VaultProtocol};
    use crate::{VaultDepositor, WithdrawUnit};

    const USER_SHARES_AFTER_1500_BPS_FEE: u64 = 99_850_025;

    #[test]
    fn test_manager_withdraw_v1() {
        let now = 0;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 1000; // 10 bps
        vp.borrow_mut().protocol_fee = 500; // 5 bps
        vault.redeem_period = 60;

        let mut vault_equity = 0;
        let amount = 100_000_000; // $100
        vault
            .manager_deposit(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        vault_equity += amount;
        vault_equity -= 1;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        assert_eq!(vault.total_deposits, 100000000);
        assert_eq!(vault.manager_total_deposits, 100000000);
        assert_eq!(vault.manager_total_withdraws, 0);

        vault
            .manager_request_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount - 1,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        assert_eq!(vault.total_deposits, 100000000);
        assert_eq!(vault.manager_total_deposits, 100000000);
        assert_eq!(vault.manager_total_withdraws, 0);

        let err = vault
            .manager_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + 50,
                0,
            )
            .is_err();
        assert!(err);

        let withdraw = vault
            .manager_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + 60,
                0,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.total_deposits, 100000000);
        assert_eq!(vault.manager_total_deposits, 100000000);
        assert_eq!(vault.manager_total_withdraws, 99999999);
        assert_eq!(withdraw, 99999999);
    }

    #[test]
    fn test_management_and_protocol_fee_v1() {
        let now = 0;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 1000; // 10 bps
        vp.borrow_mut().protocol_fee = 500; // 5 bps

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.last_fee_update_ts, 0);
        vault_equity += amount;

        let user_eq_before =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(user_eq_before, 100_000_000);

        vault
            .apply_fee(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + ONE_YEAR as i64,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 100_000_000);

        let manager_shares = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        println!("manager shares: {}", manager_shares);
        assert_eq!(manager_shares, 100_000_000 + 200_400);

        let protocol_shares = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        println!("protocol shares: {}", protocol_shares);
        assert_eq!(protocol_shares, 100_000);

        assert_eq!(vault.total_shares, 200_000_000 + 200_400 + 100_000);
        println!("total shares: {}", vault.total_shares);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        // 1000 mgmt fee + 500 protocol fee = 1500 bps fee
        // this is user shares after 1500 bps fee
        assert_eq!(oo, USER_SHARES_AFTER_1500_BPS_FEE);

        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_odd_management_and_protocol_fee_v1() {
        let now = 0;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 1001; // 10.01 bps
        vp.borrow_mut().protocol_fee = 499; // 4.99 bps

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.last_fee_update_ts, 0);
        vault_equity += amount;

        let user_eq_before =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(user_eq_before, 100_000_000);

        vault
            .apply_fee(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + ONE_YEAR as i64,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 100_000_000);

        let manager_shares = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        println!("manager shares: {}", manager_shares);
        // 200_400 shares at 1000 point profit share
        // 200_600 shares at 1001 point profit share
        // 200_400 / 1000 = 200.4
        // 200_600 / 1001 = 200.399999 (ends up as 200.4 in the program due to u64 rounding)
        assert_eq!(manager_shares, 100_000_000 + 200_600);

        let protocol_shares = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        println!("protocol shares: {}", protocol_shares);
        // 100_000 shares at 500 point profit share
        // 99_800 shares at 499 point profit share
        // 100_000 / 500 = 200
        // 99_800 / 499 = 200
        assert_eq!(protocol_shares, 99_800);

        assert_eq!(vault.total_shares, 200_000_000 + 200_600 + 99_800);
        println!("total shares: {}", vault.total_shares);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        // 1001 mgmt fee + 499 protocol fee = 1500 bps fee
        // this is user shares after 1500 bps fee
        assert_eq!(oo, USER_SHARES_AFTER_1500_BPS_FEE);

        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_protocol_fee_alone_v1() {
        let now = 0;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 0; // 0 bps
        vp.borrow_mut().protocol_fee = 500; // 5 bps

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.last_fee_update_ts, 0);
        vault_equity += amount;

        let user_eq_before =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(user_eq_before, 100_000_000);

        vault
            .apply_fee(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + ONE_YEAR as i64,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 100_000_000);

        let manager_shares = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        println!("manager shares: {}", manager_shares);
        assert_eq!(manager_shares, 100_000_000);

        let protocol_shares = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        println!("protocol shares: {}", protocol_shares);
        assert_eq!(protocol_shares, 100_000);

        assert_eq!(vault.total_shares, 200_000_000 + 100_000);
        println!("total shares: {}", vault.total_shares);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 99950024);

        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_excessive_fee_v1() {
        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 600_000;
        vp.borrow_mut().protocol_fee = 400_000;
        vault.last_fee_update_ts = 0;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.shares_base, 0);
        assert_eq!(vault.last_fee_update_ts, 1000);
        vault_equity += amount;

        vault
            .apply_fee(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + ONE_YEAR as i64,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 10);
        assert_eq!(vault.total_shares, 2000000000);
        assert_eq!(vault.shares_base, 7);

        let vd_amount_left =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(vd_amount_left, 1);
        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_fee_high_frequency_v1() {
        // asymptotic nature of calling -100% annualized on shorter time scale
        let mut now = 0;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 600_000; // 60%
        vp.borrow_mut().protocol_fee = 400_000; // 40%
                                                // vault.management_fee = 1_000_000; // 100%
        vault.last_fee_update_ts = 0;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.shares_base, 0);
        // assert_eq!(vault.last_fee_update_ts(, 1000);
        vault_equity += amount;

        while now < ONE_YEAR as i64 {
            vault
                .apply_fee(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now)
                .unwrap();
            now += 60 * 60 * 24 * 7; // every week
        }
        vault
            .apply_fee(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now)
            .unwrap();

        let vd_amount_left =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(vd_amount_left, 35832760); // ~$35 // 54152987
        assert_eq!(vault.last_fee_update_ts, now);
    }

    #[test]
    fn test_manager_alone_deposit_withdraw_v1() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 100; // .01%
        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        now += 60 * 60;

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 100000000);

        vault
            .manager_request_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        let withdrew = vault
            .manager_withdraw(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount, withdrew);
        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 0);

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 0);
    }

    #[test]
    fn test_negative_management_fee_v1() {
        let now = 0;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = -2_147_483_648; // -214700% annualized (manager pays 24% hourly, .4% per minute)

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);
        assert_eq!(vault.last_fee_update_ts, 0);
        vault_equity += amount;

        let user_eq_before =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(user_eq_before, 100000000);

        // one second since inception
        vault
            .apply_fee(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + 1_i64,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 199986200);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 100006900); // up half a cent

        // one minute since inception
        vault
            .apply_fee(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + 60_i64,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 199185855);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 100408736); // up 40 cents

        // one year since inception
        vault
            .apply_fee(
                &mut Some(vp.borrow_mut()),
                &mut None,
                vault_equity,
                now + ONE_YEAR as i64,
            )
            .unwrap();
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 100000000);

        let oo =
            depositor_shares_to_vault_amount(vault.user_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(oo, 200000000); // up $100

        assert_eq!(vault.last_fee_update_ts, now + ONE_YEAR as i64);
    }

    #[test]
    fn test_negative_management_fee_manager_alone_v1() {
        let mut now = 0;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = -2_147_483_648; // -214700% annualized (manager pays 24% hourly, .4% per minute)
        assert_eq!(vault.total_shares, 0);
        assert_eq!(vault.last_fee_update_ts, 0);

        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        now += 100000;
        vault
            .manager_deposit(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, amount as u128);
        assert_eq!(vault.last_fee_update_ts, now);
        vault_equity += amount;

        now += 100000;
        vault
            .manager_request_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        let withdrew = vault
            .manager_withdraw(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(withdrew, amount);
    }

    #[test]
    fn test_manager_deposit_withdraw_with_user_flat_v1() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 0;
        vault.profit_share = 150_000; // 15%

        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        now += 60 * 60;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount * 20,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000000000 + 100000000);
        vault_equity += amount * 20;

        now += 60 * 60 * 24; // 1 day later

        vd.apply_profit_share(vault_equity, &mut vault, &mut Some(vp.borrow_mut()), now)
            .unwrap();
        vault
            .apply_fee(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now)
            .unwrap();

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 100000000);
        vault
            .manager_request_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        let withdrew = vault
            .manager_withdraw(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount, withdrew);
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000000000);

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 0);
    }

    #[test]
    fn test_manager_deposit_withdraw_with_user_manager_fee_loss_v1() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 100; // .01%
        vault.profit_share = 150000; // 15%

        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100000000);
        now += 60 * 60;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount * 20,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000000000 + 100000000);
        vault_equity += amount * 20;

        let mut cnt = 0;
        while (vault.total_shares == 2000000000 + 100000000) && cnt < 400 {
            now += 60 * 60 * 24; // 1 day later

            vd.apply_profit_share(vault_equity, &mut vault, &mut Some(vp.borrow_mut()), now)
                .unwrap();
            vault
                .apply_fee(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now)
                .unwrap();
            // crate::msg!("vault last ts: {} vs {}", vault.last_fee_update_ts, now);
            cnt += 1;
        }

        assert_eq!(cnt, 4); // 4 days

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 100001999);
        vault
            .manager_request_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();

        let withdrew = vault
            .manager_withdraw(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount, withdrew);
        assert_eq!(vault.user_shares, 2000000000);
        assert_eq!(vault.total_shares, 2000002000);
        vault_equity -= withdrew;

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 1999); // gainz

        let vd_amount = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(vd_amount, 1999998000); // loss

        assert_eq!(vd_amount + vault_manager_amount_after, vault_equity - 1);
    }

    #[test]
    fn test_manager_deposit_withdraw_with_user_gain_v1() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 100; // .01%
        vault.profit_share = 150000; // 15%

        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100_000_000);
        now += 60 * 60;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount * 20,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, 2_000_000_000);
        assert_eq!(vault.total_shares, 2_000_000_000 + 100_000_000);
        vault_equity += amount * 20;

        // up 50%
        vault_equity *= 3;
        vault_equity /= 2;

        assert_eq!(vault_equity, 3_150_000_000);

        let mut cnt = 0;
        while (vault.total_shares == 2_000_000_000 + 100_000_000) && cnt < 400 {
            now += 60 * 60 * 24; // 1 day later

            vd.apply_profit_share(vault_equity, &mut vault, &mut Some(vp.borrow_mut()), now)
                .unwrap();
            vault
                .apply_fee(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now)
                .unwrap();
            cnt += 1;
        }

        assert_eq!(cnt, 4); // 4 days
        assert_eq!(
            vd.cumulative_profit_share_amount,
            (850 * QUOTE_PRECISION_U64) as i64 // $850 = $1000 - 15%
        );
        assert_eq!(vd.net_deposits, (2000 * QUOTE_PRECISION_U64) as i64);

        let vault_manager_amount = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount, 300002849); //$300??

        vault
            .manager_request_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        assert_eq!(amount, vault.last_manager_withdraw_request.value);

        let withdrew = vault
            .manager_withdraw(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount - 1, withdrew); // todo: slight round out of favor
        assert_eq!(vault.user_shares, 1900000000);
        assert_eq!(vault.total_shares, 2033335367);
        vault_equity -= withdrew;

        let vault_manager_amount_after = depositor_shares_to_vault_amount(
            vault.total_shares - vault.user_shares,
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(vault_manager_amount_after, 200_002_850); // gainz

        let vd_amount = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(vd_amount, 2_849_997_150); // gainz

        assert_eq!(vd_amount + vault_manager_amount_after, vault_equity - 1);
    }

    #[test]
    fn test_protocol_withdraw_with_user_gain_v1() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vp.borrow_mut().protocol_fee = 100; // .01% (1 bps)
        vp.borrow_mut().protocol_profit_share = 150_000; // 15%

        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vault
            .manager_deposit(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        vault_equity += amount;

        assert_eq!(vault.user_shares, 0);
        assert_eq!(vault.total_shares, 100_000_000);
        now += 60 * 60;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount * 20,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, 2_000_000_000);
        assert_eq!(vault.total_shares, 2_000_000_000 + 100_000_000);
        vault_equity += amount * 20;

        // up 50%
        vault_equity *= 3;
        vault_equity /= 2;

        assert_eq!(vault_equity, 3_150_000_000);

        let mut cnt = 0;
        while (vault.total_shares == 2_000_000_000 + 100_000_000) && cnt < 400 {
            now += 60 * 60 * 24; // 1 day later

            vd.apply_profit_share(vault_equity, &mut vault, &mut Some(vp.borrow_mut()), now)
                .unwrap();
            vault
                .apply_fee(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now)
                .unwrap();
            cnt += 1;
        }

        assert_eq!(cnt, 4); // 4 days
        assert_eq!(
            vd.cumulative_profit_share_amount,
            (850 * QUOTE_PRECISION_U64) as i64 // $850 = $1000 - 15%
        );
        assert_eq!(vd.net_deposits, (2000 * QUOTE_PRECISION_U64) as i64);

        let protocol_amount = depositor_shares_to_vault_amount(
            vault.get_protocol_shares(&mut Some(vp.borrow_mut())),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(protocol_amount, 150002999);

        vault
            .protocol_request_withdraw(
                &mut Some(vp.borrow_mut()),
                &mut None,
                amount,
                WithdrawUnit::Token,
                vault_equity,
                now,
                0,
            )
            .unwrap();
        assert_eq!(amount, vp.borrow().last_protocol_withdraw_request.value);

        let withdrew = vault
            .protocol_withdraw(&mut Some(vp.borrow_mut()), &mut None, vault_equity, now, 0)
            .unwrap();
        assert_eq!(amount - 1, withdrew); // todo: slight round out of favor
        assert_eq!(vault.user_shares, 1900000000);
        assert_eq!(vault.total_shares, 2033335367);
        vault_equity -= withdrew;

        let protocol_amount_after = depositor_shares_to_vault_amount(
            vault.get_protocol_shares(&mut Some(vp.borrow_mut())),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        let manager_amount = depositor_shares_to_vault_amount(
            vault
                .get_manager_shares(&mut Some(vp.borrow_mut()))
                .unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();

        assert_eq!(protocol_amount_after, 50_003_000);
        assert_eq!(manager_amount, 149999850);

        let vd_amount = depositor_shares_to_vault_amount(
            vd.checked_vault_shares(&vault).unwrap(),
            vault.total_shares,
            vault_equity,
        )
        .unwrap();
        assert_eq!(vd_amount, 2_849_997_150);

        assert_eq!(
            vd_amount + protocol_amount_after + manager_amount,
            vault_equity - 1
        );
    }

    #[test]
    fn test_profit_share_with_hurdle_rate() {
        let mut now = 123456789;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());
        vault.management_fee = 0;
        vault.profit_share = 150_000; // 15%
        vault.hurdle_rate = 100_000; // 10%
        vault.last_fee_update_ts = now;
        let mut vault_equity: u64 = 0;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap(); // new user deposits $2000
        now += 60 * 60;
        assert_eq!(vault.user_shares, amount as u128);
        assert_eq!(vault.total_shares, amount as u128);
        vault_equity += amount;

        now += 60 * 60 * 24; // 1 day later

        // no profit share yet
        vd.apply_profit_share(vault_equity, &mut vault, &mut Some(vp.borrow_mut()), now)
            .unwrap();
        assert_eq!(vd.cumulative_profit_share_amount, 0);
        assert_eq!(vault.manager_total_profit_share, 0);

        // vault up 5%, no profit share yet, less than hurdle
        vd.apply_profit_share(
            vault_equity * 105 / 100,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            now,
        )
        .unwrap();
        assert_eq!(vd.cumulative_profit_share_amount, 0);
        assert_eq!(vault.manager_total_profit_share, 0);

        // vault up 10%, no profit share yet, less than hurdle
        vd.apply_profit_share(
            vault_equity * 110 / 100,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            now,
        )
        .unwrap();
        assert_eq!(vd.cumulative_profit_share_amount, 0);
        assert_eq!(vault.manager_total_profit_share, 0);

        // vault up 11%, profit share now
        let vault_equity_profit_share = vault_equity * 111 / 100;
        assert_eq!(vault_equity_profit_share, 111000000);
        vd.apply_profit_share(
            vault_equity_profit_share,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            now,
        )
        .unwrap();
        assert_eq!(vd.cumulative_profit_share_amount, 9350000); // $11 * 0.85 = 9.35
        assert_eq!(vault.manager_total_profit_share, 1650000); // $11 * 0.15 = 1.65
        assert_eq!(vault.user_shares, vd.get_vault_shares()); //
        assert_eq!(vault.user_shares, 98513514); // 109.35 / 111 = 0.98513514
        assert_eq!(vault.total_shares, amount as u128);

        let user_equity =
            vault_equity_profit_share * (vault.user_shares as u64) / (vault.total_shares as u64);
        assert_eq!(user_equity, 109350000);

        // vault up 10% since last profit share, no profit share yet (below hurdle)
        let vault_equity_final = vault_equity_profit_share * 110 / 100;
        assert_eq!(vault_equity_final, 122_100_000);
        vd.apply_profit_share(
            vault_equity_final,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            now,
        )
        .unwrap();
        assert_eq!(vd.cumulative_profit_share_amount, 9350000); // $11 * 0.85 = 9.35
        assert_eq!(vault.manager_total_profit_share, 1650000); // $11 * 0.15 = 1.65
        assert_eq!(vault.user_shares, vd.get_vault_shares()); //
        assert_eq!(vault.user_shares, 98513514); // 109.35 / 111 = 0.98513514
        assert_eq!(vault.total_shares, amount as u128);

        // vault up 11% since last profit share, profit share now (above hurdle)
        let vault_equity_final = vault_equity_profit_share * 111 / 100;
        assert_eq!(vault_equity_final, 123_210_000);
        let user_equity = vault_equity_final * 98513514 / vault.total_shares as u64;
        assert_eq!(user_equity, 121_378_500); // 121,378,500.5994

        vd.apply_profit_share(
            vault_equity_final,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            now,
        )
        .unwrap();
        assert_eq!(vd.cumulative_profit_share_amount, 19_574_225); // (121.378500 - 109.35) * 0.85 + 9.35 = 19.574225
        assert_eq!(vault.manager_total_profit_share, 3_454_275); // (121.378500 - 109.35) * 0.15 + 1.65 = 3.454275
        assert_eq!(vault.user_shares, vd.get_vault_shares()); //
        assert_eq!(vault.user_shares, 97049124);
        assert_eq!(vault.total_shares, amount as u128);

        let user_equity = vault_equity_final * vault.user_shares as u64 / vault.total_shares as u64;
        assert_eq!(user_equity, 119_574_225); // 109.35 + (121.3785 - 109.35) * 0.85 = 119.574225
    }
}

#[cfg(test)]
#[derive(Debug, Clone)]
enum EntityType {
    Manager,
    Protocol,
    VaultDepositor,
}

#[cfg(test)]
mod request_withdraw_cancel_tests {
    use super::EntityType;
    use crate::{
        assert_eq_within,
        state::{vault::Vault, VaultDepositor, VaultProtocol},
        WithdrawUnit,
    };
    use drift::math::{
        casting::Cast,
        constants::{PERCENTAGE_PRECISION_U64, QUOTE_PRECISION, QUOTE_PRECISION_U64},
        safe_math::SafeMath,
    };
    use std::cell::RefCell;

    struct DepositsInWithdrawWindow {
        entity_type: EntityType,
        amount: u64, // token amount
    }

    #[allow(clippy::too_many_arguments)]
    fn run_withdraw_request_cancel_test(
        test_type: EntityType,
        // withdraw shares pct,
        withdraw_shares_pct: u64,
        // deposits during withdraw window
        deposits_in_withdraw_window: Vec<DepositsInWithdrawWindow>,
        // shares params
        total_shares_initial: u128,
        user_shares_initial: u128,
        protocol_shares_initial: u128,
        vd_shares_initial: u128,
        // equity params
        vault_equity_initial: u64,
        vault_equity_before_cancel: u64,
        // expected final sahres
        expected_manager_shares_final: u128,
        expected_protocol_shares_final: u128,
        expected_total_shares_final: u128,
        expected_user_shares_final: u128,
        expected_vd_shares_final: u128,
        // expected final equity
        expected_manager_equity_final: u64,
        expected_protocol_equity_final: u64,
        expected_user_equity_final: u64,
        expected_vd_equity_final: u64,
    ) {
        let now = 1000;

        let mut vault = Vault {
            total_shares: total_shares_initial,
            user_shares: user_shares_initial,
            vault_protocol: protocol_shares_initial == 0,
            ..Default::default()
        };

        let vp = RefCell::new(VaultProtocol::default());
        vp.borrow_mut().protocol_profit_and_fee_shares = protocol_shares_initial;

        let mut vd = VaultDepositor::default();
        vd.update_vault_shares(vd_shares_initial, &vault).unwrap();

        let mut equity_deposited = 0;

        // ACTION 1) request withdraw
        match test_type {
            EntityType::Manager => {
                vault
                    .manager_request_withdraw(
                        &mut Some(vp.borrow_mut()),
                        &mut None,
                        withdraw_shares_pct,
                        WithdrawUnit::SharesPercent,
                        vault_equity_initial,
                        now,
                        0,
                    )
                    .expect("can request withdraw");
            }
            EntityType::Protocol => {
                vault
                    .protocol_request_withdraw(
                        &mut Some(vp.borrow_mut()),
                        &mut None,
                        withdraw_shares_pct,
                        WithdrawUnit::SharesPercent,
                        vault_equity_initial,
                        now,
                        0,
                    )
                    .expect("can request withdraw");
            }
            EntityType::VaultDepositor => {
                vd.request_withdraw(
                    withdraw_shares_pct,
                    WithdrawUnit::SharesPercent,
                    vault_equity_initial,
                    &mut vault,
                    &mut None,
                    &mut None,
                    now,
                    0,
                )
                .expect("can request withdraw");
            }
        }

        // ACTION 2) do deposits if any
        for action in deposits_in_withdraw_window {
            equity_deposited += action.amount;

            match action.entity_type {
                EntityType::Manager => {
                    vault
                        .manager_deposit(
                            &mut Some(vp.borrow_mut()),
                            &mut None,
                            action.amount,
                            vault_equity_initial,
                            now,
                            0,
                        )
                        .expect("manager can deposit");
                }
                EntityType::Protocol => {
                    // protocol doesnt deposit, skip this case
                }
                EntityType::VaultDepositor => {
                    vd.deposit(
                        action.amount,
                        vault_equity_initial,
                        &mut vault,
                        &mut Some(vp.borrow_mut()),
                        &mut None,
                        now,
                        0,
                    )
                    .expect("vault depositor can deposit");
                }
            }
        }

        let vault_equity_final = vault_equity_before_cancel + equity_deposited;

        // ACTION 3) cancel withdraw request
        match test_type {
            EntityType::Manager => {
                vault
                    .manager_cancel_withdraw_request(
                        &mut Some(vp.borrow_mut()),
                        &mut None,
                        vault_equity_final,
                        now + 1000,
                        0,
                    )
                    .expect("can cancel withdraw request");
            }
            EntityType::Protocol => {
                vault
                    .protocol_cancel_withdraw_request(
                        &mut Some(vp.borrow_mut()),
                        &mut None,
                        vault_equity_final,
                        now + 1000,
                        0,
                    )
                    .expect("can cancel withdraw request");
            }
            EntityType::VaultDepositor => {
                vd.cancel_withdraw_request(
                    vault_equity_final,
                    &mut vault,
                    &mut Some(vp.borrow_mut()),
                    &mut None,
                    now + 1000,
                    0,
                )
                .expect("can cancel withdraw request");
            }
        }

        // check final shares state

        assert_eq!(
            vault.last_manager_withdraw_request.value, 0,
            "manager withdraw request value"
        );
        assert_eq!(
            vault.last_manager_withdraw_request.shares, 0,
            "manager withdraw request shares"
        );
        assert_eq!(
            vault.total_shares, expected_total_shares_final,
            "total shares final"
        );
        assert_eq!(
            vault.user_shares, expected_user_shares_final,
            "user shares final"
        );

        let manager_shares_final = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        assert_eq!(
            manager_shares_final, expected_manager_shares_final,
            "manager shares final"
        );

        let protocol_shares_final = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        let vp = vp.borrow_mut();
        assert_eq!(vp.last_protocol_withdraw_request.value, 0);
        assert_eq!(vp.last_protocol_withdraw_request.shares, 0);
        assert_eq!(
            protocol_shares_final, expected_protocol_shares_final,
            "protocol shares final"
        );

        let vd_shares_final = vd.checked_vault_shares(&vault).unwrap();
        assert_eq!(vd.last_withdraw_request.value, 0);
        assert_eq!(vd.last_withdraw_request.shares, 0);
        assert_eq!(vd_shares_final, expected_vd_shares_final, "vd shares final");

        // check equity

        let manager_equity = vault_equity_final
            .safe_mul(manager_shares_final.cast::<u64>().unwrap())
            .unwrap()
            .safe_div(vault.total_shares.cast::<u64>().unwrap())
            .unwrap();
        assert_eq!(
            manager_equity, expected_manager_equity_final,
            "manager equity final"
        );

        let protocol_equity_final = vault_equity_final
            .safe_mul(protocol_shares_final.cast::<u64>().unwrap())
            .unwrap()
            .safe_div(vault.total_shares.cast::<u64>().unwrap())
            .unwrap();
        assert_eq!(
            protocol_equity_final, expected_protocol_equity_final,
            "protocol equity final"
        );

        let total_user_equity = vault_equity_final
            .safe_mul(vault.user_shares.cast::<u64>().unwrap())
            .unwrap()
            .safe_div(vault.total_shares.cast::<u64>().unwrap())
            .unwrap();
        assert_eq!(
            total_user_equity, expected_user_equity_final,
            "user equity final"
        );

        let vd_equity = vault_equity_final
            .safe_mul(vd_shares_final.cast::<u64>().unwrap())
            .unwrap()
            .safe_div(vault.total_shares.cast::<u64>().unwrap())
            .unwrap();
        assert_eq!(vd_equity, expected_vd_equity_final, "vd equity final");

        let total_equity = manager_equity
            .safe_add(protocol_equity_final)
            .unwrap()
            .safe_add(total_user_equity)
            .unwrap();

        assert_eq_within!(total_equity, vault_equity_final, 2, "total equity final")
    }

    // full withdraw tests

    #[test]
    fn test_vault_manager_cancel_withdraw_request_no_profit() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 100% of their shares
        // 2) manager cancels withdraw request (vault equity stays unchanged)
        //
        // expected result:
        // * no 'lost shares' applied
        // * manager equity stays unchanged

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $10
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64,
            // expected final shares
            10 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // expected final equity
            10 * QUOTE_PRECISION_U64,
            10 * QUOTE_PRECISION_U64,
            80 * QUOTE_PRECISION_U64,
            50 * QUOTE_PRECISION_U64,
        );
    }

    #[test]
    fn test_vault_manager_cancel_withdraw_request_with_profit() {
        // test setup:
        // * users own 70% of vault
        // * manager owns 20% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 100% of their shares
        // 2) manager cancels withdraw request (vault equity +50% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * manager does not enjoy pnl during withdraw window

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $20
            70 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            150 * QUOTE_PRECISION_U64,
            // expected final shares
            12_307_692,
            10_000_000,
            92_307_692,
            70_000_000,
            50_000_000,
            // expected final equity
            19_999_999,  // manager equity be unchanged, manager should forfeit pnl
            16_250_000,  // protocol equity +62.5%
            113_750_000, // users equity +62.5%
            81_250_000,  // vd equity +62.5%
        );
    }

    #[test]
    fn test_vault_manager_cancel_withdraw_request_with_loss() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 100% of their shares
        // 2) manager cancels withdraw request (vault equity -10% during withdraw)
        //
        // expected result:
        // * no 'lost shares' applied
        // * manager exposed to loss during withdraw window

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $10
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            90 * QUOTE_PRECISION_U64,
            // expected final shares
            10 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // expected final equity
            9 * QUOTE_PRECISION_U64,
            9 * QUOTE_PRECISION_U64, // manager equity down 10% with vault
            72 * QUOTE_PRECISION_U64,
            45 * QUOTE_PRECISION_U64,
        );
    }

    #[test]
    fn test_vault_protocol_cancel_withdraw_request_no_profit() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault

        // test sequence
        // 1) protocol requests withdraw for 100% of their shares
        // 2) protocol cancels withdraw request (vault equity stays unchanged)
        //
        // expected result:
        // * no 'lost shares' applied
        // * protocol equity stays unchanged
        // * user equity stays unchanged

        run_withdraw_request_cancel_test(
            EntityType::Protocol,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION, // protocol equity initial = $10
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64,
            // expected final shares
            10 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // expected final equity
            10 * QUOTE_PRECISION_U64,
            10 * QUOTE_PRECISION_U64, // protocol equity unchanged
            80 * QUOTE_PRECISION_U64,
            50 * QUOTE_PRECISION_U64,
        );
    }

    #[test]
    fn test_vault_protocol_cancel_withdraw_request_with_profit() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault

        // test sequence
        // 1) protocol requests withdraw for 100% of their shares
        // 2) protocol cancels withdraw request (vault equity +10% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * protocol does not enjoy pnl during withdraw window
        // * user and manager share protocol pnl

        run_withdraw_request_cancel_test(
            EntityType::Protocol,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION, // protocol equity initial = $10
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            10_000_000,
            9_000_000,
            99_000_000,
            80_000_000,
            50_000_000,
            // expected final equity
            11_111_111, // manager equity +11.11%
            10_000_000, // protocol equity unchanged
            88_888_888, // user equity +11.11%
            55_555_555, // vd equity +11.11%
        );
    }

    #[test]
    fn test_vault_protocol_cancel_withdraw_request_with_loss() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault

        // test sequence
        // 1) protocol requests withdraw for 100% of their shares
        // 2) protocol cancels withdraw request (vault equity -10% during withdraw)
        //
        // expected result:
        // * no 'lost shares' applied
        // * user, manager, and protocol exposed to losses during withdraw window

        run_withdraw_request_cancel_test(
            EntityType::Protocol,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION, // protocol equity initial = $10
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            90 * QUOTE_PRECISION_U64,
            // expected final shares
            10 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // expected final equity
            9_000_000,
            9_000_000, // protocol equity down 10% with vault
            72 * QUOTE_PRECISION_U64,
            45 * QUOTE_PRECISION_U64,
        );
    }

    #[test]
    fn test_vault_depositor_cancel_withdraw_request_no_profit() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) depositor requests withdraw for 100% of their shares
        // 2) depositor cancels withdraw request (vault equity stays unchanged)
        //
        // expected result:
        // * no 'lost shares' applied
        // * vd equity stays unchanged

        run_withdraw_request_cancel_test(
            EntityType::VaultDepositor,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION, // vd equity initial = $50
            // equity params
            100 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64,
            // expected final shares
            10 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // expected final equity
            10 * QUOTE_PRECISION_U64,
            10 * QUOTE_PRECISION_U64,
            80 * QUOTE_PRECISION_U64,
            50 * QUOTE_PRECISION_U64, // vd equity remains unchanged = $50
        );
    }

    #[test]
    fn test_vault_depositor_cancel_withdraw_request_with_profit() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) depositor requests withdraw for 100% of their shares
        // 2) depositor cancels withdraw request (vault equity +10% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * vd does not enjoy pnl during withdraw window
        // * manager equity +10%
        // * protocol equity +10%
        // * users equity +10%
        //   * vd does not enjoy pnl during withdraw window (5% extra pnl split with remaining shares)

        run_withdraw_request_cancel_test(
            EntityType::VaultDepositor,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION, // vd equity initial = $50
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            10_000_000,
            10_000_000,
            91_666_666,
            71_666_666,
            41_666_666,
            // expected final equity
            12_000_000,
            12_000_000,
            85_999_999,
            49_999_999, // vd equity remains unchanged = ~$50
        );
    }

    #[test]
    fn test_vault_depositor_cancel_withdraw_request_with_loss() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) depositor requests withdraw for 100% of their shares
        // 2) depositor cancels withdraw request (vault equity -10% during withdraw)
        //
        // expected result:
        // * no 'lost shares' applied
        // * users and vd equity -10%
        // * protocol equity -10%
        // * manager equity -10%

        run_withdraw_request_cancel_test(
            EntityType::VaultDepositor,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION, // vd equity initial = $50
            // equity params
            100 * QUOTE_PRECISION_U64,
            90 * QUOTE_PRECISION_U64,
            // expected final shares
            10 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // expected final equity
            9 * QUOTE_PRECISION_U64,
            9 * QUOTE_PRECISION_U64,
            72 * QUOTE_PRECISION_U64,
            45 * QUOTE_PRECISION_U64, // vd equity down 10% with vault
        );
    }

    // partial withdraw tests

    #[test]
    fn test_vault_manager_cancel_withdraw_request_with_profit_half_shares() {
        // test setup:
        // * users own 70% of vault
        // * manager owns 20% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 50% of their shares
        // 2) manager cancels withdraw request (vault equity +50% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * manager enjoys partial pnl during withdraw window

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $20
            70 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            150 * QUOTE_PRECISION_U64,
            // expected final shares
            16_428_571,
            10_000_000,
            96_428_571,
            70_000_000,
            50_000_000,
            // expected final equity
            25_555_555,  // manager equity +27.8%
            15_555_555,  // protocol equity +55.5%
            108_888_889, // users equity +55.5%
            77_777_778,  // vd equity +55.5%
        );
    }

    #[test]
    fn test_vault_protocol_cancel_withdraw_request_with_profit_half_shares() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault

        // test sequence
        // 1) protocol requests withdraw for 50% of their shares
        // 2) protocol cancels withdraw request (vault equity +10% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * protocol enjoys partial pnl during withdraw window
        // * user and manager share protocol pnl

        run_withdraw_request_cancel_test(
            EntityType::Protocol,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION, // protocol equity initial = $10
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            10_000_000,
            9_523_809,
            99_523_809,
            80_000_000,
            50_000_000,
            // expected final equity
            11_052_631, // manager equity +10.52631625%
            10_526_315, // protocol equity +5.26315%
            88_421_053, // user equity +10.52631625%
            55_263_158, // vd equity +10.52631625%
        );
    }

    #[test]
    fn test_vault_depositor_cancel_withdraw_request_with_profit_half_shares() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) depositor requests withdraw for 50% of their shares
        // 2) depositor cancels withdraw request (vault equity +10% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * vd enjoys partial pnl during withdraw window

        run_withdraw_request_cancel_test(
            EntityType::VaultDepositor,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION, // vd equity initial = $50
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            10_000_000,
            10_000_000,
            97_058_823,
            77_058_823,
            47_058_823,
            // expected final equity
            11_333_333, // manager equity +13.33333333%
            11_333_333, // protocol equity +13.33333333%
            87_333_333, // user equity +9.16666625%
            53_333_333, // vd equity +6.666666%
        );
    }

    #[test]
    fn test_vault_depositor_cancel_withdraw_request_no_profit_half_shares() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) depositor requests withdraw for 50% of their shares
        // 2) depositor cancels withdraw request (vault equity unchanged during withdraw)
        //
        // expected result:
        // * no 'lost shares' applied
        // * no pnl

        run_withdraw_request_cancel_test(
            EntityType::VaultDepositor,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION, // vd equity initial = $50
            // equity params
            100 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64,
            // expected final shares
            10_000_000,
            10_000_000,
            100_000_000,
            80_000_000,
            50_000_000,
            // expected final equity unchanged
            10_000_000,
            10_000_000,
            80_000_000,
            50_000_000,
        );
    }

    // deposits with pending withdrawals test
    #[test]
    fn test_vault_depositor_cancel_withdraw_request_no_profit_half_shares_with_deposits() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) depositor requests withdraw for 50% of their shares
        // 2) manager deposits $20 during window
        // 2) depositor cancels withdraw request (vault equity unchanged during withdraw)
        //
        // expected result:
        // * no 'lost shares' applied
        // * no pnl diff

        run_withdraw_request_cancel_test(
            EntityType::VaultDepositor,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![DepositsInWithdrawWindow {
                amount: 20 * QUOTE_PRECISION_U64,
                entity_type: EntityType::Manager,
            }],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION, // vd equity initial = $50
            // equity params
            100 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64,
            // expected final shares
            30_000_000,
            10_000_000,
            120_000_000,
            80_000_000,
            50_000_000,
            // expected final equity
            30_000_000, // manager deposited +$20
            10_000_000,
            80_000_000,
            50_000_000,
        );
    }

    #[test]
    fn test_vault_depositor_cancel_withdraw_request_with_profit_half_shares_with_deposits() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) depositor requests withdraw for 50% of their shares
        // 2) manager deposits $20 during window
        // 2) depositor cancels withdraw request (vault equity +10% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * vd enjoys partial withdraw during window

        run_withdraw_request_cancel_test(
            EntityType::VaultDepositor,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![DepositsInWithdrawWindow {
                amount: 20 * QUOTE_PRECISION_U64,
                entity_type: EntityType::Manager,
            }],
            // shares params
            100 * QUOTE_PRECISION,
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION, // vd equity initial = $50
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            30_000_000,
            10_000_000,
            117_619_047,
            77_619_047,
            47_619_047,
            // expected final equity
            33_157_894, // manager deposited +$20, +10.52631333%
            11_052_631, // +10.52631333%
            85_789_473, // +7.23684125%
            52_631_578, // +5.263156%
        );
    }

    #[test]
    fn test_vault_manager_cancel_withdraw_request_no_profit_half_shares_with_deposits() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 50% of their shares
        // 2) vd deposits $20 during window
        // 2) manager cancels withdraw request (vault equity unchanged during withdraw)
        //
        // expected result:
        // * no 'lost shares' applied
        // * no pnl diff

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![DepositsInWithdrawWindow {
                amount: 20 * QUOTE_PRECISION_U64,
                entity_type: EntityType::VaultDepositor,
            }],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $10
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64,
            // expected final shares
            10 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            120 * QUOTE_PRECISION,
            100 * QUOTE_PRECISION,
            70 * QUOTE_PRECISION,
            // expected final equity
            10 * QUOTE_PRECISION_U64,
            10 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64, // vd deposited +$20
            70 * QUOTE_PRECISION_U64,  // vd equity +$20
        );
    }

    #[test]
    fn test_vault_manager_cancel_withdraw_request_with_profit_half_shares_with_deposits() {
        // test setup:
        // * users own 80% of vault
        // * manager owns 10% of vault
        // * protocol own 10% of vault
        // * single vault depositor owns 50% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 50% of their shares
        // 2) vd deposits $20 during window
        // 2) manager cancels withdraw request (vault equity +10% during withdraw)
        //
        // expected result:
        // * 'lost shares' applied
        // * manager enjoys partial withdraw during window

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_div(2).unwrap(),
            vec![DepositsInWithdrawWindow {
                amount: 20 * QUOTE_PRECISION_U64,
                entity_type: EntityType::VaultDepositor,
            }],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $10
            80 * QUOTE_PRECISION,
            10 * QUOTE_PRECISION,
            50 * QUOTE_PRECISION,
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            9_600_000,
            10 * QUOTE_PRECISION,
            119_600_000,
            100 * QUOTE_PRECISION,
            70 * QUOTE_PRECISION,
            // expected final equity
            10_434_782,  // +4.34782%
            10_869_565,  // +8.69565%
            108_695_652, // +10.869565%
            76_086_956,  // +12.173912%
        );
    }

    #[test]
    fn test_vault_fully_owned_by_manager_cancel_withdraw_request_no_profit() {
        // test setup:
        // * manager owns 100% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 100% of their shares
        //
        // expected result:
        // * no 'lost shares' applied
        // * manager equity unchanged

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $10
            0,
            0,
            0,
            // equity params
            100 * QUOTE_PRECISION_U64,
            100 * QUOTE_PRECISION_U64,
            // expected final shares
            100 * QUOTE_PRECISION,
            0,
            100 * QUOTE_PRECISION,
            0,
            0,
            // expected final equity
            100 * QUOTE_PRECISION_U64, // unchanged
            0,
            0,
            0,
        );
    }

    #[test]
    fn test_vault_fully_owned_by_manager_cancel_withdraw_request_with_loss() {
        // test setup:
        // * manager owns 100% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 100% of their shares
        //
        // expected result:
        // * no 'lost shares' applied
        // * manager -10% with vault

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $10
            0,
            0,
            0,
            // equity params
            100 * QUOTE_PRECISION_U64,
            90 * QUOTE_PRECISION_U64,
            // expected final shares
            100 * QUOTE_PRECISION,
            0,
            100 * QUOTE_PRECISION,
            0,
            0,
            // expected final equity
            90 * QUOTE_PRECISION_U64, // -10%
            0,
            0,
            0,
        );
    }

    #[test]
    fn test_vault_mostly_owned_by_manager_cancel_withdraw_request_with_profit() {
        // test setup:
        // * manager owns nearly 100% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 100% of their shares
        //
        // expected result:
        // * 'lost shares' applied
        // * manager +10% with vault

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64,
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial is almost 100% of vault
            1,
            0,
            1,
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            9,
            0,
            10,
            1,
            1,
            // expected final equity
            99_000_000, // manager equity unchanged
            0,
            11_000_000, // manager forfeits $9.9 of profits
            11_000_000, // user gets the $9.9 profit
        );
    }

    #[test]
    fn test_vault_fully_owned_by_manager_cancel_withdraw_request_with_profit() {
        // test setup:
        // * manager owns 100% of vault
        //
        // test sequence
        // 1) manager requests withdraw for 100% of their shares
        //
        // expected result:
        // * no 'lost shares' applied
        // * manager +10% with vault since they own 100%

        run_withdraw_request_cancel_test(
            EntityType::Manager,
            // withdraw shares pct
            PERCENTAGE_PRECISION_U64.safe_sub(1).unwrap(),
            vec![],
            // shares params
            100 * QUOTE_PRECISION, // manager equity initial = $100
            0,
            0,
            0,
            // equity params
            100 * QUOTE_PRECISION_U64,
            110 * QUOTE_PRECISION_U64,
            // expected final shares
            100 * QUOTE_PRECISION,
            0,
            100 * QUOTE_PRECISION,
            0,
            0,
            // expected final equity
            110 * QUOTE_PRECISION_U64, // +10%
            0,
            0,
            0,
        );
    }
}

#[cfg(test)]
mod full_vault_withdraw_tests {

    use super::EntityType;
    use crate::{
        state::{vault::Vault, VaultDepositor, VaultProtocol},
        WithdrawUnit,
    };
    use drift::math::constants::{PERCENTAGE_PRECISION_U64, QUOTE_PRECISION_U64};
    use std::cell::RefCell;

    #[derive(Debug)]
    struct WithdrawParam {
        entity_type: EntityType,
        shares_pct: u64,
    }

    #[allow(clippy::too_many_arguments)]
    fn run_complete_withdraw_test(
        request_withdraw_order: &Vec<WithdrawParam>,
        withdraw_order: &Vec<WithdrawParam>,
        // shares params
        total_shares_initial: u128,
        protocol_shares_initial: u128,
        vd_shares_initial: u128,
        // equity params
        vault_equity_initial: u64,
        vault_equity_final: u64,
        // expected final sahres
        expected_manager_shares_final: u128,
        expected_protocol_shares_final: u128,
        expected_total_shares_final: u128,
        expected_user_shares_final: u128,
        expected_vd_shares_final: u128,
    ) -> Result<(), &'static str> {
        let now = 1000;

        let mut vault = Vault {
            total_shares: total_shares_initial,
            user_shares: vd_shares_initial,
            vault_protocol: protocol_shares_initial == 0,
            ..Default::default()
        };

        let vp = RefCell::new(VaultProtocol::default());
        vp.borrow_mut().protocol_profit_and_fee_shares = protocol_shares_initial;

        let mut vd = VaultDepositor::default();
        vd.update_vault_shares(vd_shares_initial, &vault).unwrap();

        // ACTION 1) request withdraw
        for param in request_withdraw_order {
            match param.entity_type {
                EntityType::Manager => {
                    vault
                        .manager_request_withdraw(
                            &mut Some(vp.borrow_mut()),
                            &mut None,
                            param.shares_pct,
                            WithdrawUnit::SharesPercent,
                            vault_equity_initial,
                            now,
                            0,
                        )
                        .expect("manager can request withdraw");
                }
                EntityType::Protocol => {
                    vault
                        .protocol_request_withdraw(
                            &mut Some(vp.borrow_mut()),
                            &mut None,
                            param.shares_pct,
                            WithdrawUnit::SharesPercent,
                            vault_equity_initial,
                            now,
                            0,
                        )
                        .expect("protocol can request withdraw");
                }
                EntityType::VaultDepositor => {
                    vd.request_withdraw(
                        param.shares_pct,
                        WithdrawUnit::SharesPercent,
                        vault_equity_initial,
                        &mut vault,
                        &mut None,
                        &mut None,
                        now,
                        0,
                    )
                    .expect("vault depositor can request withdraw");
                }
            }
        }

        let now = now + 1000;

        // ACTION 2) complete withdraw
        for param in withdraw_order {
            match param.entity_type {
                EntityType::Manager => {
                    vault
                        .manager_withdraw(
                            &mut Some(vp.borrow_mut()),
                            &mut None,
                            vault_equity_final,
                            now,
                            0,
                        )
                        .expect("manager can withdraw");
                }
                EntityType::Protocol => {
                    vault
                        .protocol_withdraw(
                            &mut Some(vp.borrow_mut()),
                            &mut None,
                            vault_equity_final,
                            now,
                            0,
                        )
                        .expect("protocol can withdraw");
                }
                EntityType::VaultDepositor => {
                    vd.withdraw(
                        vault_equity_final,
                        &mut vault,
                        &mut Some(vp.borrow_mut()),
                        &mut None,
                        now,
                        0,
                    )
                    .expect("vault depositor can withdraw");
                }
            }
        }

        // check final shares state

        if vault.last_manager_withdraw_request.value != 0 {
            return Err("manager withdraw request value");
        }
        if vault.last_manager_withdraw_request.shares != 0 {
            return Err("manager withdraw request shares");
        }
        if vault.total_shares != expected_total_shares_final {
            return Err("total shares final");
        }
        if vault.user_shares != expected_user_shares_final {
            return Err("user shares final");
        }

        let manager_shares_final = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        if manager_shares_final != expected_manager_shares_final {
            return Err("manager shares final");
        }

        let protocol_shares_final = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        let vp = vp.borrow_mut();
        if vp.last_protocol_withdraw_request.value != 0 {
            return Err("protocol withdraw request value");
        }
        if vp.last_protocol_withdraw_request.shares != 0 {
            return Err("protocol withdraw request shares");
        }
        if protocol_shares_final != expected_protocol_shares_final {
            return Err("protocol shares final");
        }

        let vd_shares_final = vd.checked_vault_shares(&vault).unwrap();
        if vd.last_withdraw_request.value != 0 {
            return Err("vault depositor withdraw request value");
        }
        if vd.last_withdraw_request.shares != 0 {
            return Err("vault depositor withdraw request shares");
        }
        if vd_shares_final != expected_vd_shares_final {
            return Err("vault depositor shares final");
        }

        Ok(())
    }

    #[test]
    fn test_complete_withdraw() {
        // Test all possible withdraw order permutations
        let withdraw_orders = vec![
            vec![
                EntityType::Manager,
                EntityType::Protocol,
                EntityType::VaultDepositor,
            ],
            vec![
                EntityType::Manager,
                EntityType::VaultDepositor,
                EntityType::Protocol,
            ],
            vec![
                EntityType::Protocol,
                EntityType::Manager,
                EntityType::VaultDepositor,
            ],
            vec![
                EntityType::Protocol,
                EntityType::VaultDepositor,
                EntityType::Manager,
            ],
            vec![
                EntityType::VaultDepositor,
                EntityType::Manager,
                EntityType::Protocol,
            ],
            vec![
                EntityType::VaultDepositor,
                EntityType::Protocol,
                EntityType::Manager,
            ],
        ];

        let vault_equity_initial = 100 * QUOTE_PRECISION_U64;
        let test_final_vault_equity = vec![100, 90, 110];

        for vault_equity_final in &test_final_vault_equity {
            for withdraw_order in &withdraw_orders {
                let withdraw_params = withdraw_order
                    .iter()
                    .map(|entity_type| WithdrawParam {
                        entity_type: entity_type.clone(),
                        shares_pct: PERCENTAGE_PRECISION_U64,
                    })
                    .collect();

                let result = run_complete_withdraw_test(
                    &vec![
                        WithdrawParam {
                            entity_type: EntityType::Manager,
                            shares_pct: PERCENTAGE_PRECISION_U64,
                        },
                        WithdrawParam {
                            entity_type: EntityType::Protocol,
                            shares_pct: PERCENTAGE_PRECISION_U64,
                        },
                        WithdrawParam {
                            entity_type: EntityType::VaultDepositor,
                            shares_pct: PERCENTAGE_PRECISION_U64,
                        },
                    ],
                    &withdraw_params,
                    // shares params
                    100,
                    10,
                    80,
                    // equity params
                    vault_equity_initial,
                    *vault_equity_final,
                    // expected final shares
                    0,
                    0,
                    0,
                    0,
                    0,
                );

                assert!(
                    result.is_ok(),
                    "\nError {:?}\nInitial vault equity: {}\nFinal vault equity: {}\nwithdraw order: {:?}",
                    result.err().unwrap(),
                    vault_equity_initial,
                    vault_equity_final,
                    withdraw_params
                );
            }
        }
    }
}
