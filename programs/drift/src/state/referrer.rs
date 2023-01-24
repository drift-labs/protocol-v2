use crate::state::user::{User, UserStats};
use std::cell::RefMut;

pub enum ReferrerInfo<'a> {
    Some {
        referrer: RefMut<'a, User>,
        referrer_stats: RefMut<'a, UserStats>,
    },
    IsMaker,
    None,
}
