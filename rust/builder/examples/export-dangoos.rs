//! Export precompiled OS integration inputs from a reviewed EmbedTS checkout.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
fn main() -> Result<(), String> {
    let destination = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: export-dangoos NEW_DIRECTORY")?,
    );
    if destination.exists() {
        return Err("export destination already exists".into());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = tempfile::tempdir_in(parent).map_err(|e| e.to_string())?;
    let mut artifacts: Vec<Value> = Vec::new();
    let fixture_root = root.join("tests/integration/fixtures/dangoos");
    let mut sources: Vec<_> = fs::read_dir(&fixture_root)
        .map_err(|e| e.to_string())?
        .map(|e| e.unwrap().path())
        .collect();
    sources.push(root.join("typescript/examples/brain/default.ts"));
    sources.sort();
    for source in sources {
        let Some(extension) = source.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        let bytes = match extension {
            "ts" => embedts_builder::compile(&source)?,
            "mjs" => embedts_engine::compile_module(
                &fs::read_to_string(&source).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?,
            _ => continue,
        };
        let name = source.file_stem().unwrap().to_string_lossy();
        let output = if name == "default" {
            "brain/default.etb.hex".to_string()
        } else if name == "selftest" {
            "selftest.etb".to_string()
        } else {
            format!("fixtures/{name}.etb")
        };
        let target = temporary.path().join(&output);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        let output_bytes = if name == "default" {
            let mut envelope = String::from("etb1:");
            use std::fmt::Write;
            for byte in &bytes {
                write!(envelope, "{byte:02x}").unwrap();
            }
            if envelope.len() > 65536 {
                return Err("default brain exceeds envelope storage budget".into());
            }
            envelope.into_bytes()
        } else {
            bytes
        };
        fs::write(&target, &output_bytes).map_err(|e| e.to_string())?;
        artifacts.push(json!({"source":source.strip_prefix(root).unwrap(),"source_sha256":format!("{:x}",Sha256::digest(fs::read(&source).unwrap())),"path":output,"bytes":output_bytes.len(),"sha256":format!("{:x}",Sha256::digest(&output_bytes))}));
    }
    let engine_id = embedts_engine::ENGINE_ID
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let manifest = json!({"format":"embedts-artifacts-v1","producer":"embedts-builder","version":env!("CARGO_PKG_VERSION"),"typescript":embedts_builder::TYPESCRIPT_VERSION,"tsrs_commit":embedts_builder::TSRS_COMMIT,"engine_id":engine_id,"host_abi":embedts_engine::HOST_ABI,"artifacts":artifacts});
    fs::write(
        temporary.path().join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary.path(), &destination).map_err(|e| e.to_string())?;
    println!("{} packages -> {}", artifacts.len(), destination.display());
    Ok(())
}
