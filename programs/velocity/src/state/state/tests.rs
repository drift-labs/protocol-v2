mod get_init_user_fee {
    use crate::State;

    #[test]
    fn it_works() {
        let state = State::default();
        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 0);

        let state = State {
            max_initialize_user_fee: 1,
            max_number_of_sub_accounts: 10,
            number_of_sub_accounts: 800,
            ..State::default()
        };

        let max_number_of_sub_accounts = state.max_number_of_sub_accounts();
        assert_eq!(max_number_of_sub_accounts, 1000);

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 0);

        let state = State {
            max_initialize_user_fee: 1,
            max_number_of_sub_accounts: 10,
            number_of_sub_accounts: 900,
            ..State::default()
        };

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 5000000);

        let state = State {
            max_initialize_user_fee: 1,
            max_number_of_sub_accounts: 10,
            number_of_sub_accounts: 1000,
            ..State::default()
        };

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 10000000);

        let state = State {
            max_initialize_user_fee: 100,
            max_number_of_sub_accounts: 10,
            number_of_sub_accounts: 1000,
            ..State::default()
        };

        let init_user_fee = state.get_init_user_fee().unwrap();
        assert_eq!(init_user_fee, 1000000000);
    }
}
