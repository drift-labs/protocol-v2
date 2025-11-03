use super::*;

#[test]
fn init_tree_insert_bids_asks_and_read_back() {
    use hypertree::{RedBlackTreeReadOnly, HyperTreeValueIteratorTrait};

    // Compute node width for RBNode<ClobOrder> to choose non-overlapping indices
    let block_width: u32 = core::mem::size_of::<hypertree::RBNode<ClobOrder>>() as u32;

    // Backing dynamic data buffer for both trees
    let data: Vec<u8> = vec![0u8; (block_width as usize) * 64];

    let fixed = ClobFixed::new(1);

    let mut zc = ClobValue {
        fixed: fixed,
        dynamic: data,
    };
    zc.market_expand().expect("market expand failed");
    zc.market_expand().expect("market expand failed");
    zc.market_expand().expect("market expand failed");
    zc.market_expand().expect("market expand failed");

    // Insert two bids: prices 100 and 120
    let bid1 = ClobOrder {
        is_bid: hypertree::PodBool::from(true),
        price: 100,
        base_asset_amount: 10,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        trader_index: 1,
        reduce_only: hypertree::PodBool::from(false),
        post_only: hypertree::PodBool::from(false),
    };
    let bid2 = ClobOrder { price: 120, trader_index: 2, ..bid1 };
    let DynamicAccount { mut fixed, mut dynamic } = zc.borrow_mut();
    let free_address = get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    super::insert_order_into_tree(true, &mut fixed, &mut dynamic, free_address, &bid1);

    let DynamicAccount { mut fixed, mut dynamic } = zc.borrow_mut();
    let free_address = get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    super::insert_order_into_tree(true, &mut fixed, &mut dynamic, free_address, &bid2);

    // Insert two asks: prices 150 and 140
    let ask1 = ClobOrder {
        is_bid: hypertree::PodBool::from(false),
        price: 150,
        base_asset_amount: 8,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        trader_index: 3,
        reduce_only: hypertree::PodBool::from(false),
        post_only: hypertree::PodBool::from(false),
    };
    let ask2 = ClobOrder { price: 140, trader_index: 4, ..ask1 };
    let DynamicAccount { mut fixed, mut dynamic } = zc.borrow_mut();
    let free_address = get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    super::insert_order_into_tree(false, &mut fixed, &mut dynamic, free_address, &ask1);

    let DynamicAccount { mut fixed, mut dynamic } = zc.borrow_mut();
    let free_address = get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    super::insert_order_into_tree(false, &mut fixed, &mut dynamic, free_address, &ask2);

    let zc_copy = ClobValue {
        fixed: fixed.clone(),
        dynamic: dynamic.to_vec(),
    };

    // Read bids: top should be price 120 (higher is better for Long)
    let bids_ro: RedBlackTreeReadOnly<ClobOrder> = zc_copy.get_bids();
    let mut bids_iter = bids_ro.iter::<ClobOrder>();
    let (_, best_bid) = bids_iter.next().expect("no best bid");
    let best_bid_price = best_bid.price;
    assert_eq!(best_bid_price, 120);

    let (_, second_bid) = bids_iter.next().expect("no second bid");
    let second_bid_price = second_bid.price;
    assert_eq!(second_bid_price, 100);

    // Read asks: top should be price 140 (lower is better for Short)
    let asks_ro: RedBlackTreeReadOnly<ClobOrder> = zc_copy.get_asks();
    let mut asks_iter = asks_ro.iter::<ClobOrder>();
    let (_, best_ask) = asks_iter.next().expect("no best ask");
    let best_ask_price = best_ask.price;
    assert_eq!(best_ask_price, 140);

    let (_, second_ask) = asks_iter.next().expect("no second ask");
    let second_ask_price = second_ask.price;
    assert_eq!(second_ask_price, 150);
}

#[test]
fn free_list_returns_lifo_addresses() {
    let block_width: u32 = core::mem::size_of::<hypertree::RBNode<ClobOrder>>() as u32;

    let mut market = ClobValue {
        fixed: ClobFixed::new(0),
        dynamic: vec![0u8; (block_width as usize) * 64],
    };
    market.market_expand().expect("market expand failed");
    market.market_expand().expect("market expand failed");
    market.market_expand().expect("market expand failed");
    market.market_expand().expect("market expand failed");

    // Pop in LIFO order: 3B, 2B, 1B, 0
    let DynamicAccount { mut fixed, mut dynamic } = market.borrow_mut();
    let a0 = super::get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    assert_eq!(a0, block_width * 3);

    let a1 = super::get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    assert_eq!(a1, block_width * 2);

    let a2 = super::get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    assert_eq!(a2, block_width * 1);

    let a3 = super::get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    assert_eq!(a3, block_width * 0);

    // Next pop returns NIL sentinel
    let a4 = super::get_free_address_on_market_fixed(&mut fixed, &mut dynamic);
    assert_eq!(a4, super::NIL);
}
