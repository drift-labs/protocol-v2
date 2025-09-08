mod sig_verification {
    use std::str::FromStr;

    use anchor_lang::prelude::Pubkey;

    use crate::controller::position::PositionDirection;
    use crate::validation::sig_verification::deserialize_into_verified_message;

    #[test]
    fn test_deserialize_into_verified_message_non_delegate() {
        let signature = [1u8; 64];
        let payload = vec![
            200, 213, 166, 94, 34, 52, 245, 93, 0, 1, 0, 1, 0, 202, 154, 59, 0, 0, 0, 0, 0, 248,
            89, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 1, 192, 181, 74, 13, 0, 0, 0, 0,
            1, 0, 248, 89, 13, 0, 0, 0, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0, 72, 112, 54, 84, 106,
            83, 48, 107
        ];

        // Test deserialization with non-delegate signer
        let result = deserialize_into_verified_message(payload, &signature, false);
        assert!(result.is_ok());

        let verified_message = result.unwrap();

        // Verify the deserialized message has expected structure
        assert_eq!(verified_message.signature, signature);
        assert_eq!(verified_message.sub_account_id, Some(0));
        assert_eq!(verified_message.delegate_signed_taker_pubkey, None);
        assert_eq!(verified_message.slot, 1000);
        assert_eq!(verified_message.uuid, [72, 112, 54, 84, 106, 83, 48, 107]);
        assert!(verified_message.take_profit_order_params.is_none());
        assert!(verified_message.stop_loss_order_params.is_none());
        // Verify order params
        let order_params = &verified_message.signed_msg_order_params;
        assert_eq!(order_params.user_order_id, 1);
        assert_eq!(order_params.direction, PositionDirection::Long);
        assert_eq!(order_params.base_asset_amount, 1000000000u64);
        assert_eq!(order_params.price, 224000000u64);
        assert_eq!(order_params.market_index, 0);
        assert_eq!(order_params.reduce_only, false);
        assert_eq!(order_params.auction_duration, Some(10));
        assert_eq!(order_params.auction_start_price, Some(223000000i64));
        assert_eq!(order_params.auction_end_price, Some(224000000i64));
    }

    #[test]
    fn test_deserialize_into_verified_message_non_delegate_with_tpsl() {
        let signature = [1u8; 64];
        let payload = vec![
            200, 213, 166, 94, 34, 52, 245, 93, 0, 1, 0, 3, 0, 96, 254, 205, 0, 0, 0, 0, 64, 85,
            32, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 1, 128, 133, 181, 13, 0, 0, 0, 0,
            1, 64, 85, 32, 14, 0, 0, 0, 0, 2, 0, 41, 9, 0, 0, 0, 0, 0, 0, 67, 82, 79, 51, 105, 114,
            71, 49, 1, 0, 28, 78, 14, 0, 0, 0, 0, 0, 96, 254, 205, 0, 0, 0, 0, 1, 64, 58, 105, 13,
            0, 0, 0, 0, 0, 96, 254, 205
        ];

        // Test deserialization with delegate signer
        let result = deserialize_into_verified_message(payload, &signature, false);
        assert!(result.is_ok());

        let verified_message = result.unwrap();

        // Verify the deserialized message has expected structure
        assert_eq!(verified_message.signature, signature);
        assert_eq!(verified_message.sub_account_id, Some(2));
        assert_eq!(verified_message.delegate_signed_taker_pubkey, None);
        assert_eq!(verified_message.slot, 2345);
        assert_eq!(verified_message.uuid, [67, 82, 79, 51, 105, 114, 71, 49]);
        assert!(verified_message.take_profit_order_params.is_some());
        let tp = verified_message.take_profit_order_params.unwrap();
        assert_eq!(tp.base_asset_amount, 3456000000u64);
        assert_eq!(tp.trigger_price, 240000000u64);

        assert!(verified_message.stop_loss_order_params.is_some());
        let sl = verified_message.stop_loss_order_params.unwrap();
        assert_eq!(sl.base_asset_amount, 3456000000u64);
        assert_eq!(sl.trigger_price, 225000000u64);

        // Verify order params
        let order_params = &verified_message.signed_msg_order_params;
        assert_eq!(order_params.user_order_id, 3);
        assert_eq!(order_params.direction, PositionDirection::Long);
        assert_eq!(order_params.base_asset_amount, 3456000000u64);
        assert_eq!(order_params.price, 237000000u64);
        assert_eq!(order_params.market_index, 0);
        assert_eq!(order_params.reduce_only, false);
        assert_eq!(order_params.auction_duration, Some(10));
        assert_eq!(order_params.auction_start_price, Some(230000000i64));
        assert_eq!(order_params.auction_end_price, Some(237000000i64));
    }

    #[test]
    fn test_deserialize_into_verified_message_delegate() {
        let signature = [1u8; 64];
        let payload = vec![
            66, 101, 102, 56, 199, 37, 158, 35, 0, 1, 1, 2, 0, 202, 154, 59, 0, 0, 0, 0, 64, 85,
            32, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 1, 0, 28, 78, 14, 0, 0, 0, 0, 1,
            128, 151, 47, 14, 0, 0, 0, 0, 242, 208, 117, 159, 92, 135, 34, 224, 147, 14, 64, 92, 7,
            25, 145, 237, 79, 35, 72, 24, 140, 13, 25, 189, 134, 243, 232, 5, 89, 37, 166, 242, 41,
            9, 0, 0, 0, 0, 0, 0, 67, 82, 79, 51, 105, 114, 71, 49
        ];

        // Test deserialization with delegate signer
        let result = deserialize_into_verified_message(payload, &signature, true);
        assert!(result.is_ok());

        let verified_message = result.unwrap();

        // Verify the deserialized message has expected structure
        assert_eq!(verified_message.signature, signature);
        assert_eq!(verified_message.sub_account_id, None);
        assert_eq!(
            verified_message.delegate_signed_taker_pubkey,
            Some(Pubkey::from_str("HLr2UfL422cakKkaBG4z1bMZrcyhmzX2pHdegjM6fYXB").unwrap())
        );
        assert_eq!(verified_message.slot, 2345);
        assert_eq!(verified_message.uuid, [67, 82, 79, 51, 105, 114, 71, 49]);
        assert!(verified_message.take_profit_order_params.is_none());
        assert!(verified_message.stop_loss_order_params.is_none());

        // Verify order params
        let order_params = &verified_message.signed_msg_order_params;
        assert_eq!(order_params.user_order_id, 2);
        assert_eq!(order_params.direction, PositionDirection::Short);
        assert_eq!(order_params.base_asset_amount, 1000000000u64);
        assert_eq!(order_params.price, 237000000u64);
        assert_eq!(order_params.market_index, 0);
        assert_eq!(order_params.reduce_only, false);
        assert_eq!(order_params.auction_duration, Some(10));
        assert_eq!(order_params.auction_start_price, Some(240000000i64));
        assert_eq!(order_params.auction_end_price, Some(238000000i64));
    }

    #[test]
    fn test_deserialize_into_verified_message_delegate_with_tpsl() {
        let signature = [1u8; 64];
        let payload = vec![
            66, 101, 102, 56, 199, 37, 158, 35, 0, 1, 1, 2, 0, 202, 154, 59, 0, 0, 0, 0, 64, 85,
            32, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 1, 0, 28, 78, 14, 0, 0, 0, 0, 1,
            128, 151, 47, 14, 0, 0, 0, 0, 241, 148, 164, 10, 232, 65, 33, 157, 18, 12, 251, 132,
            245, 208, 37, 127, 112, 55, 83, 186, 54, 139, 1, 135, 220, 180, 208, 219, 189, 94, 79,
            148, 41, 9, 0, 0, 0, 0, 0, 0, 67, 82, 79, 51, 105, 114, 71, 49, 1, 128, 133, 181, 13,
            0, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0, 1, 128, 178, 230, 14, 0, 0, 0, 0, 0, 202, 154,
            59
        ];

        // Test deserialization with delegate signer
        let result = deserialize_into_verified_message(payload, &signature, true);
        assert!(result.is_ok());

        let verified_message = result.unwrap();

        // Verify the deserialized message has expected structure
        assert_eq!(verified_message.signature, signature);
        assert_eq!(verified_message.sub_account_id, None);
        assert_eq!(
            verified_message.delegate_signed_taker_pubkey,
            Some(Pubkey::from_str("HG2iQKnRkkasrLptwMZewV6wT7KPstw9wkA8yyu8Nx3m").unwrap())
        );
        assert_eq!(verified_message.slot, 2345);
        assert_eq!(verified_message.uuid, [67, 82, 79, 51, 105, 114, 71, 49]);
        assert!(verified_message.take_profit_order_params.is_some());
        let tp = verified_message.take_profit_order_params.unwrap();
        assert_eq!(tp.base_asset_amount, 1000000000u64);
        assert_eq!(tp.trigger_price, 230000000u64);

        assert!(verified_message.stop_loss_order_params.is_some());
        let sl = verified_message.stop_loss_order_params.unwrap();
        assert_eq!(sl.base_asset_amount, 1000000000u64);
        assert_eq!(sl.trigger_price, 250000000u64);

        // Verify order params
        let order_params = &verified_message.signed_msg_order_params;
        assert_eq!(order_params.user_order_id, 2);
        assert_eq!(order_params.direction, PositionDirection::Short);
        assert_eq!(order_params.base_asset_amount, 1000000000u64);
        assert_eq!(order_params.price, 237000000u64);
        assert_eq!(order_params.market_index, 0);
        assert_eq!(order_params.reduce_only, false);
        assert_eq!(order_params.auction_duration, Some(10));
        assert_eq!(order_params.auction_start_price, Some(240000000i64));
        assert_eq!(order_params.auction_end_price, Some(238000000i64));
    }
}
