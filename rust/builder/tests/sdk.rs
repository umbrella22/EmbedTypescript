use embedts_builder::{build_with_options, check, check_with_options, BuildOptions};
use serde_json::json;
use std::{fs, path::Path};

fn sdk(root: &Path, abi: u32) -> BuildOptions {
    let directory = root.join("SDK 空 格");
    fs::create_dir_all(directory.join("src/api")).unwrap();
    fs::create_dir_all(directory.join("src/helpers")).unwrap();
    fs::write(directory.join("package.json"), json!({
        "name":"@dango/sdk", "version":"1.2.3", "embedts":{"hostAbi":abi},
        "exports":{"./system":"./src/api/system.ts", "./native":"./src/api/native.d.ts", "./helper":"./src/helpers/helper.ts"}
    }).to_string()).unwrap();
    fs::write(
        directory.join("src/api/native.d.ts"),
        "declare module 'dango:host' {export function emit(value:number):void;}",
    )
    .unwrap();
    fs::write(
        directory.join("src/api/system.ts"),
        "export function value():number{return 7 as number;}",
    )
    .unwrap();
    fs::write(
        directory.join("src/helpers/helper.ts"),
        "export function helper():number{return 42;}",
    )
    .unwrap();
    BuildOptions {
        sdk: Some(directory),
    }
}

#[test]
fn explicit_sdk_is_read_at_compile_time_and_native_cli_options_override_project_selection() {
    let root = tempfile::tempdir().unwrap();
    let options = sdk(root.path(), embedts_engine::HOST_ABI);
    let entry = root.path().join("main.ts");
    fs::write(
        &entry,
        "import {value} from '@dango/sdk/system';export function main():number{return value();}",
    )
    .unwrap();
    fs::write(
        root.path().join("embedts.workspace.json"),
        r#"{"sdk":"missing-sdk"}"#,
    )
    .unwrap();
    assert!(check_with_options(&entry, &options)
        .unwrap()
        .contains("return 7"));
    fs::write(
        options.sdk.unwrap().join("src/api/system.ts"),
        "export function value():string{return 'changed';}",
    )
    .unwrap();
    assert!(check_with_options(&entry, &sdk_options(root.path()))
        .unwrap_err()
        .contains("not assignable"));
}

fn sdk_options(root: &Path) -> BuildOptions {
    BuildOptions {
        sdk: Some(root.join("SDK 空 格")),
    }
}

#[test]
fn workspace_sdk_path_can_reference_an_external_dependency() {
    let root = tempfile::tempdir().unwrap();
    sdk(root.path(), embedts_engine::HOST_ABI);
    let project = root.path().join("project");
    fs::create_dir(&project).unwrap();
    fs::write(
        project.join("embedts.workspace.json"),
        r#"{"sdk":"../SDK 空 格"}"#,
    )
    .unwrap();
    let entry = project.join("main.ts");
    fs::write(
        &entry,
        "import {value} from 'dango:system';export function main():number{return value();}",
    )
    .unwrap();
    assert!(check(entry).unwrap().contains("return 7"));
}

#[test]
fn incompatible_sdk_fails_before_replacing_a_package() {
    let root = tempfile::tempdir().unwrap();
    let options = sdk(root.path(), embedts_engine::HOST_ABI + 1);
    let entry = root.path().join("main.ts");
    let output = root.path().join("main.etb");
    fs::write(&entry, "export function main():number{return 42;}").unwrap();
    fs::write(&output, b"previous package").unwrap();
    assert!(build_with_options(entry, &output, &options)
        .unwrap_err()
        .contains("SDK host ABI mismatch"));
    assert_eq!(fs::read(output).unwrap(), b"previous package");
}

#[test]
fn selected_sdk_api_is_typechecked_and_helpers_keep_application_rules() {
    let root = tempfile::tempdir().unwrap();
    let options = sdk(root.path(), embedts_engine::HOST_ABI);
    let entry = root.path().join("main.ts");
    fs::write(
        &entry,
        "import {helper} from '@dango/sdk/helper';export function main():number{return helper();}",
    )
    .unwrap();
    fs::write(
        options.sdk.as_ref().unwrap().join("src/helpers/helper.ts"),
        "export function helper():number{return 1 as number;}",
    )
    .unwrap();
    assert!(check_with_options(&entry, &options)
        .unwrap_err()
        .contains("type assertions"));
    fs::write(
        &entry,
        "import {value} from '@dango/sdk/system';export function main():number{return value();}",
    )
    .unwrap();
    fs::write(
        options.sdk.unwrap().join("src/api/system.ts"),
        "export function value():number{return 'wrong';}",
    )
    .unwrap();
    assert!(check_with_options(entry, &sdk_options(root.path()))
        .unwrap_err()
        .contains("not assignable"));
}

#[test]
fn a_directory_named_sdk_does_not_exempt_application_code() {
    let root = tempfile::tempdir().unwrap();
    let api = root.path().join("sdk/src/api");
    fs::create_dir_all(&api).unwrap();
    fs::write(
        api.join("helper.ts"),
        "export function value():number{return 7 as number;}",
    )
    .unwrap();
    let entry = root.path().join("main.ts");
    fs::write(&entry, "import {value} from './sdk/src/api/helper.js';export function main():number{return value();}").unwrap();
    assert!(check(entry).unwrap_err().contains("type assertions"));
}

#[test]
fn an_application_entry_inside_selected_sdk_api_keeps_application_rules() {
    let root = tempfile::tempdir().unwrap();
    let options = sdk(root.path(), embedts_engine::HOST_ABI);
    let entry = options.sdk.as_ref().unwrap().join("src/api/application.ts");
    fs::write(&entry, "export function main():number{return 7 as number;}").unwrap();
    assert!(check_with_options(entry, &options)
        .unwrap_err()
        .contains("type assertions"));
}
