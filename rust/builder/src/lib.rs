//! Host-only TypeScript frontend, module bundler and dangoOS bytecode compiler.
mod app;
mod bundle;
mod frontend;
mod subset;
mod workspace;

use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, String>;

pub const TSRS_VERSION: &str = "0.20.1";
pub const TSRS_COMMIT: &str = "77d3cddb44540734abc33a42ccca4d3f33bee527";
pub const TYPESCRIPT_VERSION: &str = "7.1.0-beta";
pub const TYPESCRIPT_COMMIT: &str = "3e9236361fa97a9e6c685f4833ac457ae2d8c50a";
pub const ROLLDOWN_VERSION: &str = "1.2.16";

/// An explicit SDK overrides the nearest embedts.workspace.json SDK selection.
/// SDK source is read during application compilation, never during the Rust build.
#[derive(Clone, Debug, Default)]
pub struct BuildOptions {
    pub sdk: Option<PathBuf>,
}

pub fn toolchain_identity() -> serde_json::Value {
    serde_json::json!({
        "name":"embedts", "version":env!("CARGO_PKG_VERSION"),
        "tsrs":TSRS_VERSION, "tsrs_commit":TSRS_COMMIT,
        "typescript":TYPESCRIPT_VERSION, "typescript_commit":TYPESCRIPT_COMMIT,
        "bundler":{"name":"rolldown","version":ROLLDOWN_VERSION},
        "implementation":"rust", "sdk_mode":"external",
        "bytecode":{"name":"EmbedTS Bytecode","extension":".etb","version":1,
            "engine_id":embedts_engine::ENGINE_ID.iter().map(|b|format!("{b:02x}")).collect::<String>(),
            "host_abi":embedts_engine::HOST_ABI}
    })
}

struct CheckedModule {
    code: String,
    sdk: Option<serde_json::Value>,
}

fn check_module(input: &Path, options: &BuildOptions) -> Result<CheckedModule> {
    let input = input.canonicalize().map_err(|e| e.to_string())?;
    if input.extension().is_none_or(|ext| ext != "ts") {
        return Err("input must be a .ts source file".into());
    }
    let options = options.clone();
    // Match the upstream tsrs CLI's stack allowance for recursive type checking.
    std::thread::Builder::new()
        .name("embedts".into())
        .stack_size(512 * 1024 * 1024)
        .spawn(move || {
            let workspace = workspace::Workspace::load(&input, &options)?;
            let temporary = tempfile::Builder::new()
                .prefix("embedts-")
                .tempdir()
                .map_err(|e| e.to_string())?;
            let out = temporary.path().join("out");
            frontend::emit(&workspace, &input, temporary.path(), &out)?;
            Ok(CheckedModule {
                code: bundle::bundle(&workspace, &input, &out)?,
                sdk: workspace.sdk.clone(),
            })
        })
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "TypeScript compiler thread panicked".to_string())?
}

/// Check the original typed AST and return one ES module with only native imports.
/// All tsrs arena pointers stay on the compilation thread; only owned text escapes.
pub fn check(input: impl AsRef<Path>) -> Result<String> {
    check_with_options(input, &BuildOptions::default())
}

pub fn check_with_options(input: impl AsRef<Path>, options: &BuildOptions) -> Result<String> {
    Ok(check_module(input.as_ref(), options)?.code)
}

pub(crate) struct CompiledModule {
    pub bytes: Vec<u8>,
    pub sdk: Option<serde_json::Value>,
}

pub(crate) fn compile_module(input: &Path, options: &BuildOptions) -> Result<CompiledModule> {
    let checked = check_module(input, options)?;
    Ok(CompiledModule {
        bytes: embedts_engine::compile_module(&checked.code).map_err(|e| e.to_string())?,
        sdk: checked.sdk,
    })
}

pub fn compile(input: impl AsRef<Path>) -> Result<Vec<u8>> {
    compile_with_options(input, &BuildOptions::default())
}

pub fn compile_with_options(input: impl AsRef<Path>, options: &BuildOptions) -> Result<Vec<u8>> {
    Ok(compile_module(input.as_ref(), options)?.bytes)
}

pub(crate) fn write_package(bytes: &[u8], output: &Path) -> Result<()> {
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.persist(output).map_err(|e| e.to_string())?;
    Ok(())
}

/// Compile completely before atomically replacing an existing output package.
pub fn build(input: impl AsRef<Path>, output: impl AsRef<Path>) -> Result<usize> {
    build_with_options(input, output, &BuildOptions::default())
}

pub fn build_with_options(
    input: impl AsRef<Path>,
    output: impl AsRef<Path>,
    options: &BuildOptions,
) -> Result<usize> {
    let compiled = compile_module(input.as_ref(), options)?;
    write_package(&compiled.bytes, output.as_ref())?;
    Ok(compiled.bytes.len())
}

pub use app::{build_app, build_app_with_options};
