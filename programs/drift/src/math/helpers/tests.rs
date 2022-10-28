use crate::math::helpers::*;

#[test]
pub fn log_test() {
    assert_eq!(log10_iter(0), 0);
    assert_eq!(log10(0), 0);

    assert_eq!(log10_iter(9), 0);
    assert_eq!(log10(9), 0);

    assert_eq!(log10(19), 1);
    assert_eq!(log10_iter(19), 1);

    assert_eq!(log10_iter(13432429), 7);

    assert_eq!(log10(100), 2);
    assert_eq!(log10_iter(100), 2);

    // no modify check
    let n = 1005325523;
    assert_eq!(log10_iter(n), 9);
    assert_eq!(log10_iter(n), 9);
    assert_eq!(log10(n), 9);
    assert_eq!(log10_iter(n), 9);
}

#[test]
fn proportion_tests() {
    let result = get_proportion_i128(999999999369, 1000000036297, 1000000042597).unwrap();
    assert_eq!(result, 999999993069);
    let result = get_proportion_u128(999999999369, 1000000036297, 1000000042597).unwrap();
    assert_eq!(result, 999999993069);
    let result = get_proportion_u128(1000000036297, 999999999369, 1000000042597).unwrap();
    assert_eq!(result, 999999993069);

    let result = get_proportion_u128(999999999369, 1000000042597, 1000000036297).unwrap();
    assert_eq!(result, 1000000005668);
    let result = get_proportion_u128(1000000042597, 999999999369, 1000000036297).unwrap();
    assert_eq!(result, 1000000005668);
}
