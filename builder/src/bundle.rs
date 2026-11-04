use crate::{
    workspace::{emitted_file, Workspace},
    Result,
};
use rolldown::{
    Bundler, BundlerOptions, BundlerTransformOptions, InputItem, OutputFormat, Platform,
    ResolveOptions,
};
use rolldown_common::{
    AttachDebugInfo, CodeSplittingMode, CommentsOptions, Either, ExperimentalOptions, Output,
    RawCompressOptions, RawMinifyOptions, RawMinifyOptionsDetailed,
};
use std::path::Path;

pub(crate) fn bundle(workspace: &Workspace, input: &Path, out: &Path) -> Result<String> {
    let aliases = workspace
        .modules
        .iter()
        .map(|(name, file)| {
            (
                format!("{name}$"),
                vec![Some(emitted_file(file, out).to_string_lossy().into_owned())],
            )
        })
        .collect();
    let options = BundlerOptions {
        input: Some(vec![InputItem {
            name: Some("app".into()),
            import: emitted_file(input, out).to_string_lossy().into_owned(),
        }]),
        cwd: Some(workspace.root.clone()),
        platform: Some(Platform::Neutral),
        transform: Some(BundlerTransformOptions {
            target: Some(Either::Left("es2020".into())),
            ..Default::default()
        }),
        external: Some(vec!["dango:host".to_string()].into()),
        format: Some(OutputFormat::Esm),
        // Compress the emitted program before bytecode generation. Preserve
        // observable function/class and property names; whitespace never enters
        // the device, so only AST/bytecode reductions matter here.
        keep_names: Some(true),
        minify: Some(RawMinifyOptions::Object(RawMinifyOptionsDetailed {
            mangle: None,
            mangle_properties: None,
            compress: Some(RawCompressOptions::default()),
            remove_whitespace: true,
            ascii_only: false,
        })),
        code_splitting: Some(CodeSplittingMode::Bool(false)),
        comments: Some(CommentsOptions {
            legal: false,
            annotation: false,
            jsdoc: false,
        }),
        experimental: Some(ExperimentalOptions {
            attach_debug_info: Some(AttachDebugInfo::None),
            ..Default::default()
        }),
        resolve: Some(ResolveOptions {
            alias: Some(aliases),
            ..Default::default()
        }),
        ..Default::default()
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(async {
            let mut bundler = Bundler::new(options).map_err(|e| format!("Rolldown: {e:?}"))?;
            let output = bundler
                .generate()
                .await
                .map_err(|e| format!("Rolldown: {e:?}"))?;
            let mut chunks = output.assets.into_iter().filter_map(|item| match item {
                Output::Chunk(chunk) => Some(chunk),
                Output::Asset(_) => None,
            });
            let chunk = chunks.next().ok_or("Rolldown did not emit a module")?;
            if chunks.next().is_some()
                || chunk
                    .imports
                    .iter()
                    .any(|name| name.as_str() != "dango:host")
                || !chunk.dynamic_imports.is_empty()
            {
                return Err(
                    "compiler requires one module with only the dango:host native import".into(),
                );
            }
            Ok(chunk.code.clone())
        })
}
