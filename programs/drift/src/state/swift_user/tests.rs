mod swift_order_id_eviction {
    use std::cell::{Ref, RefCell};

    use anchor_lang::prelude::Pubkey;
    use borsh::BorshSerialize;

    use crate::{
        error::ErrorCode,
        state::swift_user::{
            SwiftOrderId, SwiftUserOrders, SwiftUserOrdersFixed, SwiftUserOrdersZeroCopy,
            SwiftUserOrdersZeroCopyMut,
        },
    };

    #[test]
    fn swift_order_id_exists() {
        let fixed = RefCell::new(SwiftUserOrdersFixed {
            user_pubkey: Pubkey::default(),
            padding: 0,
            len: 32,
        });
        let data = RefCell::new([0u8; 768]);
        let mut swift_user = SwiftUserOrdersZeroCopyMut {
            fixed: fixed.borrow_mut(),
            data: data.borrow_mut(),
        };

        let new_swift_order_id = SwiftOrderId::new([7; 8], 10, 2);
        let add_result = swift_user.add_swift_order_id(new_swift_order_id);
        assert!(add_result.is_ok());

        assert_eq!(
            swift_user.check_exists_and_prune_stale_swift_order_ids(new_swift_order_id, 11),
            true
        );
        assert_eq!(
            swift_user.check_exists_and_prune_stale_swift_order_ids(new_swift_order_id, 20),
            true
        );
        assert_eq!(
            swift_user.check_exists_and_prune_stale_swift_order_ids(new_swift_order_id, 30),
            false
        );

        let mut count = 0;
        for i in 0..32 {
            if swift_user.get_mut(i).uuid == new_swift_order_id.uuid {
                count += 1;
            }
        }
        assert_eq!(count, 0);
    }

    #[test]
    fn swift_user_order_account_full() {
        let fixed = RefCell::new(SwiftUserOrdersFixed {
            user_pubkey: Pubkey::default(),
            padding: 0,
            len: 32,
        });

        let swift_order_data: [SwiftOrderId; 32] = [SwiftOrderId::new([7; 8], 10, 1); 32];

        let mut byte_array = [0u8; 768];
        for (i, order) in swift_order_data.iter().enumerate() {
            let start = i * 24;
            let end = start + 24;
            byte_array[start..end].copy_from_slice(&order.try_to_vec().unwrap());
        }

        let data = RefCell::new(byte_array);
        let mut swift_user = SwiftUserOrdersZeroCopyMut {
            fixed: fixed.borrow_mut(),
            data: data.borrow_mut(),
        };

        let new_swift_order_id = SwiftOrderId::new([7; 8], 10, 2);
        let add_result = swift_user.add_swift_order_id(new_swift_order_id);
        assert!(add_result.is_err());
        assert_eq!(
            add_result.err().unwrap(),
            ErrorCode::SwiftUserOrdersAccountFull
        );
    }

    #[test]
    fn bad_swift_order_ids() {
        let fixed = RefCell::new(SwiftUserOrdersFixed {
            user_pubkey: Pubkey::default(),
            padding: 0,
            len: 32,
        });

        let swift_order_data: [SwiftOrderId; 32] = [SwiftOrderId::new([7; 8], 10, 1); 32];

        let mut byte_array = [0u8; 768];
        for (i, order) in swift_order_data.iter().enumerate() {
            let start = i * 24;
            let end = start + 24;
            byte_array[start..end].copy_from_slice(&order.try_to_vec().unwrap());
        }

        let data = RefCell::new(byte_array);
        let mut swift_user = SwiftUserOrdersZeroCopyMut {
            fixed: fixed.borrow_mut(),
            data: data.borrow_mut(),
        };

        let new_swift_order_id = SwiftOrderId::new([7; 8], 10, 0);
        let add_result = swift_user.add_swift_order_id(new_swift_order_id);
        assert!(add_result.is_err());
        assert_eq!(add_result.err().unwrap(), ErrorCode::InvalidSwiftOrderId);

        let new_swift_order_id = SwiftOrderId::new([0; 8], 10, 10);
        let add_result = swift_user.add_swift_order_id(new_swift_order_id);
        assert!(add_result.is_err());
        assert_eq!(add_result.err().unwrap(), ErrorCode::InvalidSwiftOrderId);

        let new_swift_order_id = SwiftOrderId::new([7; 8], 0, 10);
        let add_result = swift_user.add_swift_order_id(new_swift_order_id);
        assert!(add_result.is_err());
        assert_eq!(add_result.err().unwrap(), ErrorCode::InvalidSwiftOrderId);
    }
}

#[cfg(test)]
mod zero_copy {
    use std::cell::RefCell;

    use crate::test_utils::create_account_info;
    use crate::ID;

    use anchor_lang::{prelude::Pubkey, Discriminator};
    use borsh::BorshSerialize;

    use crate::{
        error::ErrorCode,
        state::swift_user::{SwiftOrderId, SwiftUserOrders, SwiftUserOrdersLoader},
    };

    #[test]
    fn zero_copy() {
        let mut orders: SwiftUserOrders = SwiftUserOrders {
            user_pubkey: Pubkey::default(),
            padding: 0,
            swift_order_data: Vec::with_capacity(100),
        };

        for i in 0..100 {
            orders.swift_order_data.push(SwiftOrderId {
                uuid: [0; 8],
                max_slot: 0,
                order_id: i as u32,
                padding: 0,
            });
        }

        let mut bytes = Vec::with_capacity(8 + orders.try_to_vec().unwrap().len());
        bytes.extend_from_slice(&SwiftUserOrders::discriminator());
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
                &SwiftOrderId {
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
        bytes.extend_from_slice(&SwiftUserOrders::discriminator());
        let orders_account_info =
            create_account_info(&random_pubkey, false, &mut lamports, &mut bytes, &ID);
        let result = orders_account_info.load();
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), ErrorCode::DefaultError);
    }

    #[test]
    fn zero_copy_mut() {
        let mut orders: SwiftUserOrders = SwiftUserOrders {
            user_pubkey: Pubkey::default(),
            padding: 0,
            swift_order_data: Vec::with_capacity(100),
        };

        for i in 0..100 {
            orders.swift_order_data.push(SwiftOrderId {
                uuid: [0; 8],
                max_slot: 0,
                order_id: i as u32,
                padding: 0,
            });
        }

        let mut bytes = Vec::with_capacity(8 + orders.try_to_vec().unwrap().len());
        bytes.extend_from_slice(&SwiftUserOrders::discriminator());
        bytes.extend_from_slice(&orders.try_to_vec().unwrap());

        let pubkey = Pubkey::default();
        let mut lamports = 0;
        let mut orders_account_info =
            create_account_info(&pubkey, true, &mut lamports, &mut bytes, &ID);

        let mut orders_zero_copy_mut = orders_account_info.load_mut().unwrap();

        assert_eq!(orders_zero_copy_mut.fixed.len, 100);
        for i in 0..100 {
            println!("i {}", i);
            assert_eq!(
                orders_zero_copy_mut.get_mut(i),
                &SwiftOrderId {
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
        let mut orders_account_info = create_account_info(
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
        bytes.extend_from_slice(&SwiftUserOrders::discriminator());
        let mut orders_account_info =
            create_account_info(&random_pubkey, true, &mut lamports, &mut bytes, &ID);
        let result = orders_account_info.load_mut();
        assert!(result.is_err());
        assert_eq!(result.err().unwrap(), ErrorCode::DefaultError);
    }
}
