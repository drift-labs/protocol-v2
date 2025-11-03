#[derive(Clone)]
pub struct DynamicAccount<Fixed, Dynamic> {
    pub fixed: Fixed,
    pub dynamic: Dynamic,
}

pub trait DerefOrBorrow<T: ?Sized> {
    fn deref_or_borrow(&self) -> &T;
}

impl<T: ?Sized> DerefOrBorrow<T> for T {
    fn deref_or_borrow(&self) -> &T {
        self
    }
}

impl<T: ?Sized> DerefOrBorrow<T> for &T {
    fn deref_or_borrow(&self) -> &T {
        self
    }
}

impl<T: ?Sized> DerefOrBorrow<T> for &mut T {
    fn deref_or_borrow(&self) -> &T {
        self
    }
}

impl<T: Sized> DerefOrBorrow<[T]> for Vec<T> {
    fn deref_or_borrow(&self) -> &[T] {
        self
    }
}

pub trait DerefOrBorrowMut<T: ?Sized> {
    fn deref_or_borrow_mut(&mut self) -> &mut T;
}

impl<T: ?Sized> DerefOrBorrowMut<T> for &mut T {
    fn deref_or_borrow_mut(&mut self) -> &mut T {
        self
    }
}

impl<T: ?Sized> DerefOrBorrowMut<T> for T {
    fn deref_or_borrow_mut(&mut self) -> &mut T {
        self
    }
}

impl<T: Sized> DerefOrBorrowMut<[T]> for Vec<T> {
    fn deref_or_borrow_mut(&mut self) -> &mut [T] {
        self
    }
}
