fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        return Err("usage: compile INPUT.mjs OUTPUT.etb".into());
    }
    let bytes = embedts_engine::compile_module(&std::fs::read_to_string(&args[1])?)?;
    std::fs::write(&args[2], bytes)?;
    Ok(())
}
