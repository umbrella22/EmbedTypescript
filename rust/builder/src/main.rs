use embedts_builder::BuildOptions;
use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

const USAGE: &str = "usage: embedts check INPUT.ts [--sdk SDK_DIR] | build INPUT.ts --out OUTPUT.etb [--sdk SDK_DIR] | app SOURCE --out NEW_DIRECTORY [--sdk SDK_DIR] | --version";

fn run() -> embedts_builder::Result<()> {
    let mut args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--version" {
        println!("{}", embedts_builder::toolchain_identity());
        return Ok(());
    }
    if args.len() == 1 && matches!(args[0].to_str(), Some("--help" | "-h")) {
        println!("{USAGE}");
        return Ok(());
    }
    let mut options = BuildOptions::default();
    while let Some(index) = args.iter().position(|a| a == "--sdk") {
        if options.sdk.is_some() || index + 1 >= args.len() {
            return Err("--sdk requires exactly one SDK directory".into());
        }
        args.remove(index);
        options.sdk = Some(PathBuf::from(args.remove(index)));
    }
    match args.as_slice() {
        [command, input] if command == "check" => {
            embedts_builder::check_with_options(Path::new(input), &options)?;
            println!("{}: checks passed", Path::new(input).display());
        }
        [command, input, flag, output] if command == "build" && flag == "--out" => {
            let count =
                embedts_builder::build_with_options(Path::new(input), Path::new(output), &options)?;
            println!("{count} bytes -> {}", Path::new(output).display());
        }
        [command, source, flag, output] if command == "app" && flag == "--out" => {
            embedts_builder::build_app_with_options(
                Path::new(source),
                Path::new(output),
                &options,
            )?;
            println!("application -> {}", Path::new(output).display());
        }
        _ => return Err(USAGE.into()),
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
