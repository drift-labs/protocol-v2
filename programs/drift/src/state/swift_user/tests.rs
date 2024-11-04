mod swift_order_id_eviction {
    use anchor_lang::prelude::Pubkey;

    use crate::{
        error::ErrorCode,
        state::swift_user::{SwiftOrderId, SwiftUserOrders},
    };

    #[test]
    fn swift_order_id_exists() {
        let mut swift_user = SwiftUserOrders {
            user_pubkey: Pubkey::new_unique(),
            swift_order_data: [SwiftOrderId::new([0; 8], 0, 0); 32],
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

        assert_eq!(
            swift_user
                .swift_order_data
                .iter()
                .filter(|x| x.uuid == new_swift_order_id.uuid)
                .count(),
            0
        );
    }

    #[test]
    fn swift_user_order_account_full() {
        let mut swift_user = SwiftUserOrders {
            user_pubkey: Pubkey::new_unique(),
            swift_order_data: [SwiftOrderId::new([7; 8], 10, 1); 32],
        };

        let new_swift_order_id = SwiftOrderId::new([7; 8], 10, 2);
        let add_result = swift_user.add_swift_order_id(new_swift_order_id);
        assert!(add_result.is_err());
        assert_eq!(
            add_result.err().unwrap(),
            ErrorCode::SwiftUserOrdersAccountFull
        )
    }

    #[test]
    fn bad_swift_order_ids() {
        let mut swift_user = SwiftUserOrders {
            user_pubkey: Pubkey::new_unique(),
            swift_order_data: [SwiftOrderId::new([7; 8], 10, 1); 32],
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
