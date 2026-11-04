use std::{path::Path, process::ExitCode};

fn run() -> embedts_builder::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--version" {
        println!(
            "{}",
            serde_json::json!({"name":"embedts", "version":env!("CARGO_PKG_VERSION"), "tsrs":embedts_builder::TSRS_VERSION,"tsrs_commit":embedts_builder::TSRS_COMMIT,"typescript":embedts_builder::TYPESCRIPT_VERSION,"typescript_commit":embedts_builder::TYPESCRIPT_COMMIT,"bundler":{"name":"rolldown","version":embedts_builder::ROLLDOWN_VERSION},"implementation":"rust","bytecode":{"name":"EmbedTS Bytecode","extension":".etb","version":1,"engine_id":embedts_engine::ENGINE_ID.iter().map(|b|format!("{b:02x}")).collect::<String>(),"host_abi":embedts_engine::HOST_ABI}})
        );
        return Ok(());
    }
    match args.as_slice() {
        [command, input] if command == "check" => {
            embedts_builder::check(Path::new(input))?;
            println!("{}: checks passed", Path::new(input).display());
        }
        [command, input, flag, output] if command == "build" && flag == "--out" => {
            let count = embedts_builder::build(Path::new(input), Path::new(output))?;
            println!("{count} bytes -> {}", Path::new(output).display());
        }
        [command, source, flag, output] if command == "app" && flag == "--out" => {
            embedts_builder::build_app(Path::new(source), Path::new(output))?;
            println!("application -> {}", Path::new(output).display());
        }
        _ => return Err("usage: embedts check INPUT.ts | build INPUT.ts --out OUTPUT.etb | app SOURCE --out NEW_DIRECTORY | --version".into()),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("embedts: {error}");
            ExitCode::FAILURE
        }
    }
}
