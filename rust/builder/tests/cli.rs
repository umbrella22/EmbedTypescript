use std::{fs, process::Command};

fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_embedts"));
    // Compiling and assembling apps must work without external runtimes on PATH.
    command.env("PATH", "");
    command
}

#[test]
fn failed_build_preserves_package_and_success_creates_parents() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("main.ts");
    let output = root.path().join("existing.etb");
    fs::write(&input, "export function main():number{return 'invalid';}").unwrap();
    fs::write(&output, b"existing package").unwrap();
    let result = cli()
        .arg("build")
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("not assignable"));
    assert_eq!(fs::read(&output).unwrap(), b"existing package");
    fs::write(&input, "export function main():number{return 42;}").unwrap();
    let nested = root.path().join("new/nested/main.etb");
    let result = cli()
        .arg("build")
        .arg(&input)
        .arg("--out")
        .arg(&nested)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    embedts_engine::Package::parse(&fs::read(nested).unwrap()).unwrap();
}

#[test]
fn app_uses_launcher_identity_and_publishes_only_successful_payloads() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("friendly-source-folder");
    fs::create_dir_all(source.join("scripts")).unwrap();
    fs::create_dir_all(source.join("assets")).unwrap();
    fs::write(
        source.join("launcher.json"),
        r#"{"id":"installed-id","entry":"scripts/main.ts"}"#,
    )
    .unwrap();
    fs::write(
        source.join("scripts/main.ts"),
        "export function main():number{return 42;}",
    )
    .unwrap();
    fs::write(source.join("package.json"), "{}").unwrap();
    fs::write(source.join("assets/data.bin"), [0, 255]).unwrap();
    fs::write(source.join("scripts/other.lua"), "wrong language").unwrap();
    let output = root.path().join("payload");
    let result = cli()
        .arg("app")
        .arg(&source)
        .arg("--out")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let app = output.join("installed-id");
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(app.join("launcher.json")).unwrap()).unwrap();
    assert_eq!(manifest["entry"], "scripts/main.etb");
    assert_eq!(fs::read(app.join("assets/data.bin")).unwrap(), [0, 255]);
    for file in ["scripts/main.ts", "package.json", "scripts/other.lua"] {
        assert!(!app.join(file).exists());
    }
    let existing = cli()
        .arg("app")
        .arg(&source)
        .arg("--out")
        .arg(&output)
        .output()
        .unwrap();
    assert!(!existing.status.success());
    fs::write(
        source.join("scripts/main.ts"),
        "export function main():number{return 'bad';}",
    )
    .unwrap();
    let failed_output = root.path().join("failed");
    let failed = cli()
        .arg("app")
        .arg(&source)
        .arg("--out")
        .arg(&failed_output)
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(!failed_output.exists());
}

#[test]
fn copied_native_cli_builds_sdk_app_without_the_checkout_or_node() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("embedts");
    fs::copy(env!("CARGO_BIN_EXE_embedts"), &binary).unwrap();
    fs::write(
        root.path().join("main.ts"),
        "import {nowMs} from '@dango/sdk/system';export function main():number{return nowMs();}",
    )
    .unwrap();
    let result = Command::new(&binary)
        .current_dir(root.path())
        .env("PATH", "")
        .args(["build", "main.ts", "--out", "main.etb"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    embedts_engine::Package::parse(&fs::read(root.path().join("main.etb")).unwrap()).unwrap();
}
