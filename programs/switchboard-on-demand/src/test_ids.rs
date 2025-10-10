#[cfg(test)]
mod tests {
    use crate::solana_program::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;

    #[test]
    fn print_instructions_sysvar_id() {
        let bytes = INSTRUCTIONS_SYSVAR_ID.to_bytes();
        println!("Instructions sysvar ID bytes: {:02x?}", bytes);
        
        // Convert to u64 array for assembly
        let ptr = bytes.as_ptr() as *const u64;
        unsafe {
            let u64_0 = ptr.read_unaligned();
            let u64_1 = ptr.add(1).read_unaligned();
            let u64_2 = ptr.add(2).read_unaligned();
            let u64_3 = ptr.add(3).read_unaligned();
            
            println!("As u64 array for assembly:");
            println!("  [0]: 0x{:016x}", u64_0);
            println!("  [1]: 0x{:016x}", u64_1);
            println!("  [2]: 0x{:016x}", u64_2);
            println!("  [3]: 0x{:016x}", u64_3);
        }
    }
}