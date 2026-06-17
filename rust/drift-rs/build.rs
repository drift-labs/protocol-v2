use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("DOCS_RS").is_ok() {
        println!("cargo:warning=docs.rs build detected. skipping idl-gen");
        return Ok(());
    }
    let current_dir = std::env::current_dir()?.canonicalize()?;

    // Generate IDL types from 'res/velocity.json' — the velocity program IDL,
    // kept in sync with the program by `bun run program:idl` (which copies
    // target/idl/velocity.json here via the `rust:idl-sync` script).
    let idl_source_path = current_dir.join("res/velocity.json");
    let idl_mod_path = current_dir.join("crates/src/drift_idl.rs");
    println!("cargo:rerun-if-changed=res/velocity.json");
    generate_idl_types(&idl_source_path, idl_mod_path.as_path())?;
    Ok(())
}

fn generate_idl_types(
    idl_source_path: &Path,
    idl_mod_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let idl_mod_rs = drift_idl_gen::generate_rust_types(idl_source_path)
        .map_err(|err| format!("generating IDL failed: {err:?}"))?;

    std::fs::write(idl_mod_path, idl_mod_rs)?;
    Ok(())
}
