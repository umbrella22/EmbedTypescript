use crate::{BuildOptions, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(crate) struct Workspace {
    pub root: PathBuf,
    pub api: Option<PathBuf>,
    pub sdk_files: Vec<PathBuf>,
    pub sdk: Option<Value>,
    pub modules: BTreeMap<String, PathBuf>,
    _assets: tempfile::TempDir,
}

fn manifest(directory: &Path) -> Result<Value> {
    let path = directory.join("package.json");
    serde_json::from_slice(&std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn exports(
    directory: &Path,
    manifest: &Value,
    modules: &mut BTreeMap<String, PathBuf>,
) -> Result<()> {
    let name = manifest["name"]
        .as_str()
        .ok_or("source package requires a name")?;
    if let Some(exports) = manifest["exports"].as_object() {
        for (subpath, target) in exports {
            let file = directory
                .join(
                    target
                        .as_str()
                        .ok_or("source exports must name TypeScript files")?,
                )
                .canonicalize()
                .map_err(|e| format!("{name}/{subpath}: {e}"))?;
            if !file.starts_with(directory)
                || file.extension().is_none_or(|ext| ext != "ts")
                || !(subpath == "." || subpath.starts_with("./"))
            {
                return Err(format!(
                    "invalid TypeScript source export: {name}/{subpath}"
                ));
            }
            let specifier = if subpath == "." {
                name.to_string()
            } else {
                format!("{name}{}", &subpath[1..])
            };
            if modules.insert(specifier.clone(), file).is_some() {
                return Err(format!("duplicate workspace export: {specifier}"));
            }
        }
    }
    Ok(())
}

fn sdk_source_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            sdk_source_files(&entry.path(), files)?;
        } else if entry.path().extension().is_some_and(|ext| ext == "ts") {
            files.push(entry.path().canonicalize().map_err(|e| e.to_string())?);
        }
    }
    Ok(())
}

impl Workspace {
    pub fn load(input: &Path, options: &BuildOptions) -> Result<Self> {
        let assets = tempfile::tempdir().map_err(|e| e.to_string())?;
        let root = assets.path().canonicalize().map_err(|e| e.to_string())?;
        std::fs::write(
            root.join("tsconfig.base.json"),
            include_str!("../defaults/tsconfig.json"),
        )
        .map_err(|e| e.to_string())?;
        let source_root = input
            .ancestors()
            .find(|p| p.join("embedts.workspace.json").is_file());
        let config: Value = match source_root {
            Some(workspace) => {
                let path = workspace.join("embedts.workspace.json");
                serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("{}: {e}", path.display()))?
            }
            None => json!({}),
        };
        if !config.is_object() {
            return Err("workspace configuration must be an object".into());
        }
        let sdk_path = match &options.sdk {
            Some(path) => Some(path.clone()),
            None => match config.get("sdk") {
                Some(value) => Some(
                    source_root.unwrap().join(
                        value
                            .as_str()
                            .ok_or("workspace sdk must be a directory path")?,
                    ),
                ),
                None => None,
            },
        };
        let mut modules = BTreeMap::new();
        let (mut api, mut sdk) = (None, None);
        let mut sdk_files = Vec::new();
        if let Some(path) = sdk_path {
            let directory = path
                .canonicalize()
                .map_err(|e| format!("SDK {}: {e}", path.display()))?;
            let package = manifest(&directory)?;
            if package["name"] != "@dango/sdk" {
                return Err("selected SDK must be the @dango/sdk source package".into());
            }
            let version = package["version"]
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or("SDK requires a version")?;
            if package["embedts"]["hostAbi"].as_u64() != Some(u64::from(embedts_engine::HOST_ABI)) {
                return Err(format!(
                    "SDK host ABI mismatch: builder requires {}",
                    embedts_engine::HOST_ABI
                ));
            }
            let api_directory = directory
                .join("src/api")
                .canonicalize()
                .map_err(|e| format!("SDK src/api: {e}"))?;
            if !api_directory.starts_with(&directory) {
                return Err("SDK API directory must stay inside the selected SDK".into());
            }
            exports(&directory, &package, &mut modules)?;
            let native_file = modules
                .get("@dango/sdk/native")
                .ok_or("SDK requires a ./native declaration export")?
                .clone();
            if !native_file.starts_with(&api_directory)
                || !native_file.to_string_lossy().ends_with(".d.ts")
            {
                return Err("SDK ./native must export a declaration inside src/api".into());
            }
            // SDK source is compiled, including private relative modules in
            // node_modules that tsrs otherwise classifies as external libraries.
            // Every SDK source file must be a depth-zero compilation input.
            sdk_files.extend(modules.values().cloned());
            sdk_source_files(&directory.join("src"), &mut sdk_files)?;
            sdk_files.sort();
            sdk_files.dedup();
            for name in [
                "system",
                "hardware",
                "storage",
                "ui",
                "schema",
                "display",
                "image",
                "thread",
                "brain",
                "default-brain",
            ] {
                if let Some(file) = modules.get(&format!("@dango/sdk/{name}")).cloned() {
                    modules.insert(format!("dango:{name}"), file);
                }
            }
            sdk = Some(
                json!({"name":"@dango/sdk", "version":version, "host_abi":embedts_engine::HOST_ABI}),
            );
            api = Some(api_directory);
        }
        if let Some(packages) = config.get("packages") {
            for package in packages
                .as_array()
                .ok_or("workspace packages must be an array")?
            {
                let relative = Path::new(
                    package
                        .as_str()
                        .ok_or("workspace package must be a relative directory")?,
                );
                if relative.is_absolute()
                    || relative
                        .components()
                        .any(|c| !matches!(c, std::path::Component::Normal(_)))
                {
                    return Err("workspace package must stay inside its source workspace".into());
                }
                let workspace = source_root.unwrap();
                let directory = workspace
                    .join(relative)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !directory.starts_with(workspace) {
                    return Err("workspace package escapes source workspace".into());
                }
                exports(&directory, &manifest(&directory)?, &mut modules)?;
            }
        }
        Ok(Self {
            root,
            api,
            sdk_files,
            sdk,
            modules,
            _assets: assets,
        })
    }

    pub fn is_sdk_api(&self, file: &Path) -> bool {
        self.api
            .as_ref()
            .is_some_and(|api| file.canonicalize().is_ok_and(|path| path.starts_with(api)))
    }
}

pub(crate) fn emitted_file(file: &Path, out: &Path) -> PathBuf {
    // tsrs rootDir is the filesystem root; preserve source hierarchy beneath outDir.
    out.join(
        file.components()
            .filter(|c| matches!(c, std::path::Component::Normal(_)))
            .collect::<PathBuf>(),
    )
    .with_extension("js")
}
