use crate::{compile_module, toolchain_identity, write_package, BuildOptions, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

// Device registry contract: crates/os/src/apps/registry::ID_MAX_LEN.
const APP_ID_MAX_BYTES: usize = 63;

fn resources(source: &Path, relative: &Path, destination: &Path) -> Result<()> {
    for item in std::fs::read_dir(source.join(relative)).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name();
        let text = name.to_string_lossy();
        if text.starts_with('.') || matches!(text.as_ref(), "node_modules" | "dist") {
            continue;
        }
        let kind = item.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!(
                "symbolic application resource: {}",
                item.path().display()
            ));
        }
        let child = relative.join(&name);
        if kind.is_dir() {
            resources(source, &child, destination)?;
            continue;
        }
        if matches!(
            text.as_ref(),
            "launcher.json"
                | "package.json"
                | "package-lock.json"
                | "pnpm-lock.yaml"
                | "pnpm-workspace.yaml"
                | "yarn.lock"
                | "tsconfig.json"
                | "embedts.workspace.json"
                | "embedts-toolchain.json"
        ) || item
            .path()
            .extension()
            .is_some_and(|ext| ext == "ts" || ext == "etb" || ext == "lua")
        {
            continue;
        }
        let target = destination.join(child);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(item.path(), target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Assemble one TS application into a new directory, publishing only after success.
/// The launcher ID controls the installed identity independently of the source folder name.
pub fn build_app(source: impl AsRef<Path>, output: impl AsRef<Path>) -> Result<()> {
    build_app_with_options(source, output, &BuildOptions::default())
}

pub fn build_app_with_options(
    source: impl AsRef<Path>,
    output: impl AsRef<Path>,
    options: &BuildOptions,
) -> Result<()> {
    let source = source.as_ref().canonicalize().map_err(|e| e.to_string())?;
    let output = std::path::absolute(output).map_err(|e| e.to_string())?;
    if output.exists() {
        return Err(format!("output already exists: {}", output.display()));
    }
    let mut manifest: Value = serde_json::from_slice(
        &std::fs::read(source.join("launcher.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let identity = manifest["id"]
        .as_str()
        .ok_or("launcher requires an id")?
        .to_string();
    if identity.is_empty()
        || identity.len() > APP_ID_MAX_BYTES
        || !identity
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!(
            "launcher id must have 1..={APP_ID_MAX_BYTES} ASCII letters, digits, '_' or '-'"
        ));
    }
    let entry = Path::new(
        manifest["entry"]
            .as_str()
            .ok_or("launcher requires an entry")?,
    )
    .to_path_buf();
    if entry.extension().is_none_or(|ext| ext != "ts")
        || entry
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        || entry.as_os_str().is_empty()
    {
        return Err("entry must name a relative .ts source".into());
    }
    let parent = output.parent().ok_or("output must name a directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = tempfile::Builder::new()
        .prefix(".dango-app-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let destination = temporary.path().join(&identity);
    std::fs::create_dir(&destination).map_err(|e| e.to_string())?;
    resources(&source, Path::new(""), &destination)?;
    let compiled_entry = entry.with_extension("etb");
    let compiled = compile_module(&source.join(&entry), options)?;
    write_package(&compiled.bytes, &destination.join(&compiled_entry))?;
    manifest["entry"] = json!(compiled_entry.to_string_lossy().replace('\\', "/"));
    std::fs::write(
        destination.join("launcher.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|e| e.to_string())?;
    let bytes = std::fs::read(destination.join(&compiled_entry)).map_err(|e| e.to_string())?;
    let report = json!({"engine":"ts", "toolchain":toolchain_identity(), "sdk":compiled.sdk, "applications":[{"id":identity,"source":source,"entry":manifest["entry"],"bytes":bytes.len(),"sha256":format!("{:x}", Sha256::digest(&bytes))}]});
    std::fs::write(
        temporary.path().join("build-report.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary.path(), &output).map_err(|e| e.to_string())?;
    Ok(())
}
