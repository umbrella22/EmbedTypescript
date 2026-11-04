//! Host-only TypeScript frontend, module bundler and dangoOS bytecode compiler.
mod app;
mod bundle;
mod frontend;
mod subset;
mod workspace;

use std::path::Path;

pub type Result<T> = std::result::Result<T, String>;

pub const TSRS_VERSION: &str = "0.20.1";
pub const TSRS_COMMIT: &str = "77d3cddb44540734abc33a42ccca4d3f33bee527";
pub const TYPESCRIPT_VERSION: &str = "7.1.0-beta";
pub const TYPESCRIPT_COMMIT: &str = "3e9236361fa97a9e6c685f4833ac457ae2d8c50a";
pub const ROLLDOWN_VERSION: &str = "1.2.16";

/// Check the original typed AST and return one ES module with only native imports.
/// All tsrs arena pointers stay on the compilation thread; only owned text escapes.
pub fn check(input: impl AsRef<Path>) -> Result<String> {
    let input = input.as_ref().canonicalize().map_err(|e| e.to_string())?;
    if input.extension().is_none_or(|ext| ext != "ts") {
        return Err("input must be a .ts source file".into());
    }
    // Match the upstream tsrs CLI's stack allowance for recursive type checking.
    std::thread::Builder::new()
        .name("embedts".into())
        .stack_size(512 * 1024 * 1024)
        .spawn(move || {
            let workspace = workspace::Workspace::load(&input)?;
            let temporary = tempfile::Builder::new()
                .prefix("embedts-")
                .tempdir()
                .map_err(|e| e.to_string())?;
            let out = temporary.path().join("out");
            frontend::emit(&workspace, &input, temporary.path(), &out)?;
            bundle::bundle(&workspace, &input, &out)
        })
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "TypeScript compiler thread panicked".to_string())?
}

pub fn compile(input: impl AsRef<Path>) -> Result<Vec<u8>> {
    embedts_engine::compile_module(&check(input)?).map_err(|e| e.to_string())
}

/// Compile completely before atomically replacing an existing output package.
pub fn build(input: impl AsRef<Path>, output: impl AsRef<Path>) -> Result<usize> {
    let bytes = compile(input)?;
    let output = output.as_ref();
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.persist(output).map_err(|e| e.to_string())?;
    Ok(bytes.len())
}

pub use app::build_app;
