use std::{
    fs,
    path::{Path, PathBuf},
};
fn files(root: &Path, path: &Path, output: &mut String) {
    let mut children: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    children.sort();
    for child in children {
        if child.is_dir() {
            if child.file_name().unwrap() != "node_modules" {
                files(root, &child, output);
            }
        } else if child.extension().is_some_and(|e| e == "ts")
            || child.file_name().unwrap() == "package.json"
        {
            let name = child.strip_prefix(root).unwrap().to_string_lossy();
            output.push_str(&format!(
                "({name:?}, include_str!({:?})),\n",
                child.canonicalize().unwrap()
            ));
            println!("cargo:rerun-if-changed={}", child.display());
        }
    }
}
fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("..");
    let mut output = String::from("const SDK_FILES: &[(&str, &str)] = &[\n");
    files(&root, &root.join("sdk"), &mut output);
    output.push_str("];\n");
    output.push_str(&format!(
        "const TSCONFIG: &str = include_str!({:?});\n",
        root.join("tsconfig.base.json").canonicalize().unwrap()
    ));
    fs::write(
        PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("sdk.rs"),
        output,
    )
    .unwrap();
    println!("cargo:rerun-if-changed=../sdk");
    println!("cargo:rerun-if-changed=../tsconfig.base.json");
}
