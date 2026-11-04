use crate::Result;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(crate) struct Workspace {
    pub root: PathBuf,
    pub api: PathBuf,
    pub modules: BTreeMap<String, PathBuf>,
    _assets: tempfile::TempDir,
}

include!(concat!(env!("OUT_DIR"), "/sdk.rs"));

impl Workspace {
    pub fn load(input: &Path) -> Result<Self> {
        let assets = tempfile::tempdir().map_err(|e| e.to_string())?;
        let root = assets.path().canonicalize().map_err(|e| e.to_string())?;
        for (name, source) in SDK_FILES {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(path, source).map_err(|e| e.to_string())?;
        }
        std::fs::write(root.join("tsconfig.base.json"), TSCONFIG).map_err(|e| e.to_string())?;
        let api = root.join("sdk/src/api");
        let mut packages = vec![root.join("sdk")];
        // Source package exports are explicit, relative to the nearest workspace.
        if let Some(workspace) = input
            .ancestors()
            .find(|p| p.join("embedts.workspace.json").is_file())
        {
            let config: Value = serde_json::from_slice(
                &std::fs::read(workspace.join("embedts.workspace.json"))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            for package in config["packages"]
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
                let directory = workspace
                    .join(relative)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !directory.starts_with(workspace) {
                    return Err("workspace package escapes source workspace".into());
                }
                packages.push(directory);
            }
        }
        let mut modules = BTreeMap::new();
        for directory in packages {
            let directory = directory.canonicalize().map_err(|e| e.to_string())?;
            let manifest: Value = serde_json::from_slice(
                &std::fs::read(directory.join("package.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let name = manifest["name"]
                .as_str()
                .ok_or("workspace package requires a name")?;
            if let Some(exports) = manifest["exports"].as_object() {
                for (subpath, target) in exports {
                    let file = directory
                        .join(
                            target
                                .as_str()
                                .ok_or("workspace exports must name TypeScript files")?,
                        )
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                    if !file.starts_with(&directory)
                        || file.extension().is_none_or(|ext| ext != "ts")
                        || !(subpath == "." || subpath.starts_with("./"))
                    {
                        return Err(format!(
                            "invalid TypeScript workspace export: {name}/{subpath}"
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
        }
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
            let file = modules
                .get(&format!("@dango/sdk/{name}"))
                .ok_or_else(|| format!("missing SDK export: {name}"))?
                .clone();
            modules.insert(format!("dango:{name}"), file);
        }
        Ok(Self {
            root,
            api,
            modules,
            _assets: assets,
        })
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
