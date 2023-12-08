mod get_init_user_fee {
    use crate::State;

    #[test]
    fn it_works() {
        let state = State::default();
        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 0);

        let state = State {
            max_initialize_user_fee: 1,
            max_number_of_sub_accounts: 100,
            number_of_sub_accounts: 8,
            ..State::default()
        };

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 0);

        let state = State {
            max_initialize_user_fee: 1,
            max_number_of_sub_accounts: 10,
            number_of_sub_accounts: 9,
            ..State::default()
        };

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 5000000);

        let state = State {
            max_initialize_user_fee: 1,
            max_number_of_sub_accounts: 10,
            number_of_sub_accounts: 10,
            ..State::default()
        };

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 10000000);

        let state = State {
            max_initialize_user_fee: 100,
            max_number_of_sub_accounts: 10,
            number_of_sub_accounts: 10,
            ..State::default()
        };

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 1000000000);
    }
}
