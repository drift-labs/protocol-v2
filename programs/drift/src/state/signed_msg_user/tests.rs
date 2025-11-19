#[cfg(test)]
mod signed_msg_order_id_eviction {
    use std::cell::RefCell;

    use anchor_lang::prelude::Pubkey;
    use borsh::BorshSerialize;

    use crate::{
        error::ErrorCode,
        state::signed_msg_user::{
            SignedMsgOrderId, SignedMsgUserOrdersFixed, SignedMsgUserOrdersZeroCopyMut,
        },
    };

    #[test]
    fn signed_msg_order_id_exists() {
        let fixed = RefCell::new(SignedMsgUserOrdersFixed {
            user_pubkey: Pubkey::default(),
            padding: 0,
            len: 32,
        });
        let data = RefCell::new([0u8; 768]);
        let mut signed_msg_user = SignedMsgUserOrdersZeroCopyMut {
            fixed: fixed.borrow_mut(),
            data: data.borrow_mut(),
        };

        let new_signed_msg_order_id = SignedMsgOrderId::new([7; 8], 10, 2);
        let add_result = signed_msg_user.add_signed_msg_order_id(new_signed_msg_order_id);
        assert!(add_result.is_ok());

        assert_eq!(
            signed_msg_user
                .check_exists_and_prune_stale_signed_msg_order_ids(new_signed_msg_order_id, 11),
            true
        );
        assert_eq!(
            signed_msg_user
                .check_exists_and_prune_stale_signed_msg_order_ids(new_signed_msg_order_id, 20),
            true
        );
        assert_eq!(
            signed_msg_user
                .check_exists_and_prune_stale_signed_msg_order_ids(new_signed_msg_order_id, 30),
            false
        );

        let mut count = 0;
        for i in 0..32 {
            if signed_msg_user.get_mut(i).uuid == new_signed_msg_order_id.uuid {
                count += 1;
            }
        }
        assert_eq!(count, 0);
    }

    #[test]
    fn signed_msg_user_order_account_full() {
        let fixed = RefCell::new(SignedMsgUserOrdersFixed {
            user_pubkey: Pubkey::default(),
            padding: 0,
            len: 32,
        });

        let signed_msg_order_data: [SignedMsgOrderId; 32] =
            [SignedMsgOrderId::new([7; 8], 10, 1); 32];

        let mut byte_array = [0u8; 768];
        for (i, order) in signed_msg_order_data.iter().enumerate() {
            let start = i * 24;
            let end = start + 24;
            byte_array[start..end].copy_from_slice(&order.try_to_vec().unwrap());
        }

        let data = RefCell::new(byte_array);
        let mut signed_msg_user = SignedMsgUserOrdersZeroCopyMut {
            fixed: fixed.borrow_mut(),
            data: data.borrow_mut(),
        };

        let new_signed_msg_order_id = SignedMsgOrderId::new([7; 8], 10, 2);
        let add_result = signed_msg_user.add_signed_msg_order_id(new_signed_msg_order_id);
        assert!(add_result.is_err());
        assert_eq!(
            add_result.err().unwrap(),
            ErrorCode::SignedMsgUserOrdersAccountFull
        );
    }

    #[test]
    fn bad_signed_msg_order_ids() {
        let fixed = RefCell::new(SignedMsgUserOrdersFixed {
            user_pubkey: Pubkey::default(),
            padding: 0,
            len: 32,
        });

        let signed_msg_order_data: [SignedMsgOrderId; 32] =
            [SignedMsgOrderId::new([7; 8], 10, 1); 32];

        let mut byte_array = [0u8; 768];
        for (i, order) in signed_msg_order_data.iter().enumerate() {
            let start = i * 24;
            let end = start + 24;
            byte_array[start..end].copy_from_slice(&order.try_to_vec().unwrap());
        }

        let data = RefCell::new(byte_array);
        let mut signed_msg_user = SignedMsgUserOrdersZeroCopyMut {
            fixed: fixed.borrow_mut(),
            data: data.borrow_mut(),
        };

        let new_signed_msg_order_id = SignedMsgOrderId::new([7; 8], 10, 0);
        let add_result = signed_msg_user.add_signed_msg_order_id(new_signed_msg_order_id);
        assert!(add_result.is_err());
        assert_eq!(
            add_result.err().unwrap(),
            ErrorCode::InvalidSignedMsgOrderId
        );

        let new_signed_msg_order_id = SignedMsgOrderId::new([0; 8], 10, 10);
        let add_result = signed_msg_user.add_signed_msg_order_id(new_signed_msg_order_id);
        assert!(add_result.is_err());
        assert_eq!(
            add_result.err().unwrap(),
            ErrorCode::InvalidSignedMsgOrderId
        );

        let new_signed_msg_order_id = SignedMsgOrderId::new([7; 8], 0, 10);
        let add_result = signed_msg_user.add_signed_msg_order_id(new_signed_msg_order_id);
        assert!(add_result.is_err());
        assert_eq!(
            add_result.err().unwrap(),
            ErrorCode::InvalidSignedMsgOrderId
        );
    }
}

#[cfg(test)]
mod zero_copy {
    use crate::test_utils::create_account_info;
    use crate::ID;

    use anchor_lang::{prelude::Pubkey, Discriminator};
    use borsh::BorshSerialize;

    use crate::{
        error::ErrorCode,
        state::signed_msg_user::{
            SignedMsgOrderId, SignedMsgUserOrders, SignedMsgUserOrdersLoader,
        },
    };

    #[test]
    fn zero_copy() {
        let mut orders: SignedMsgUserOrders = SignedMsgUserOrders {
            authority_pubkey: Pubkey::default(),
            padding: 0,
            signed_msg_order_data: Vec::with_capacity(100),
        };

        for i in 0..100 {
            orders.signed_msg_order_data.push(SignedMsgOrderId {
                uuid: [0; 8],
                max_slot: 0,
                order_id: i as u32,
                padding: 0,
            });
        }

        let mut bytes = Vec::with_capacity(8 + orders.try_to_vec().unwrap().len());
        bytes.extend_from_slice(&SignedMsgUserOrders::DISCRIMINATOR);
        bytes.extend_from_slice(&orders.try_to_vec().unwrap());

        let pubkey = Pubkey::default();
        let mut lamports = 0;
        let orders_account_info =
            create_account_info(&pubkey, false, &mut lamports, &mut bytes, &ID);

        let orders_zero_copy = orders_account_info.load().unwrap();
        assert_eq!(orders_zero_copy.fixed.len, 100);
        for i in 0..100 {
            println!("i {}", i);
            assert_eq!(
                orders_zero_copy.get(i),
                &SignedMsgOrderId {
                    uuid: [0; 8],
                    max_slot: 0,
                    order_id: i as u32,
                    padding: 0,
                }
            );
        }

        drop(orders_zero_copy);

        // invalid owner
        let random_pubkey = Pubkey::new_unique();
        let orders_account_info = create_account_info(
            &random_pubkey,
            false,
            &mut lamports,
            &mut bytes,
            &random_pubkey,
        );
        let result = orders_account_info.load();
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), ErrorCode::DefaultError);

        // invalid discriminator
        let mut bytes = Vec::with_capacity(8 + orders.try_to_vec().unwrap().len());
        bytes.extend_from_slice(&orders.try_to_vec().unwrap());
        bytes.extend_from_slice(&SignedMsgUserOrders::DISCRIMINATOR);
        let orders_account_info =
            create_account_info(&random_pubkey, false, &mut lamports, &mut bytes, &ID);
        let result = orders_account_info.load();
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), ErrorCode::DefaultError);
    }

    #[test]
    fn zero_copy_mut() {
        let mut orders: SignedMsgUserOrders = SignedMsgUserOrders {
            authority_pubkey: Pubkey::default(),
            padding: 0,
            signed_msg_order_data: Vec::with_capacity(100),
        };

        for i in 0..100 {
            orders.signed_msg_order_data.push(SignedMsgOrderId {
                uuid: [0; 8],
                max_slot: 0,
                order_id: i as u32,
                padding: 0,
            });
        }

        let mut bytes = Vec::with_capacity(8 + orders.try_to_vec().unwrap().len());
        bytes.extend_from_slice(&SignedMsgUserOrders::DISCRIMINATOR);
        bytes.extend_from_slice(&orders.try_to_vec().unwrap());

        let pubkey = Pubkey::default();
        let mut lamports = 0;
        let orders_account_info =
            create_account_info(&pubkey, true, &mut lamports, &mut bytes, &ID);

        let mut orders_zero_copy_mut = orders_account_info.load_mut().unwrap();

        assert_eq!(orders_zero_copy_mut.fixed.len, 100);
        for i in 0..100 {
            println!("i {}", i);
            assert_eq!(
                orders_zero_copy_mut.get_mut(i),
                &SignedMsgOrderId {
                    uuid: [0; 8],
                    max_slot: 0,
                    order_id: i as u32,
                    padding: 0,
                }
            );
        }

        drop(orders_zero_copy_mut);

        // invalid owner
        let random_pubkey = Pubkey::new_unique();
        let orders_account_info = create_account_info(
            &random_pubkey,
            true,
            &mut lamports,
            &mut bytes,
            &random_pubkey,
        );
        let result = orders_account_info.load_mut();
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), ErrorCode::DefaultError);

        // invalid discriminator
        let mut bytes = Vec::with_capacity(8 + orders.try_to_vec().unwrap().len());
        bytes.extend_from_slice(&orders.try_to_vec().unwrap());
        bytes.extend_from_slice(&SignedMsgUserOrders::DISCRIMINATOR);
        let orders_account_info =
            create_account_info(&random_pubkey, true, &mut lamports, &mut bytes, &ID);
        let result = orders_account_info.load_mut();
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), ErrorCode::DefaultError);
    }
}
