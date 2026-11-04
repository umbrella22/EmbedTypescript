use crate::{subset, workspace::Workspace, Result};
use serde_json::json;
use std::{path::Path, sync::Arc};
use tsrs_ast::Diagnostic;
use tsrs_compiler::{new_cached_fs_compiler_host, new_program, Context, Program, ProgramOptions};
use tsrs_core::{Tristate, P};
use tsrs_tsoptions::ParseConfigHost;
use tsrs_vfs::{bundled::embed as bundled, osvfs, FS};

struct ConfigHost {
    fs: Arc<dyn FS>,
    cwd: String,
}
impl ParseConfigHost for ConfigHost {
    fn fs(&self) -> &dyn FS {
        &*self.fs
    }
    fn get_current_directory(&self) -> &str {
        &self.cwd
    }
}

struct ProgramGuard(&'static Program);
impl Drop for ProgramGuard {
    fn drop(&mut self) {
        // SAFETY: this is a fresh non-incremental program. All handles, AST pointers
        // and diagnostics are local to emit_in_region and are dropped before us.
        unsafe { tsrs_compiler::free_unshared_program(self.0) };
    }
}

pub(crate) fn location(file: &tsrs_ast::SourceFile, pos: u32) -> String {
    let starts = file.ecma_line_map();
    let line_index = starts.partition_point(|&start| start <= pos) - 1;
    let line = line_index + 1;
    let column = file.text()[starts[line_index] as usize..pos as usize]
        .encode_utf16()
        .count()
        + 1;
    format!("{}:{line}:{column}", file.file_name())
}

fn diagnostic(d: P<Diagnostic>) -> String {
    let at = d
        .file()
        .map(|file| {
            d.pos()
                .map(|pos| location(&file, pos))
                .unwrap_or_else(|| file.file_name().to_string())
        })
        .unwrap_or_else(|| "TypeScript".to_string());
    let mut message = d.localize();
    for child in d.message_chain() {
        message.push_str(&format!("\n  {}", diagnostic_message(*child)));
    }
    format!("{at}: TS{}: {message}", d.code())
}

fn diagnostic_message(d: P<Diagnostic>) -> String {
    let mut message = d.localize();
    for child in d.message_chain() {
        message.push_str(&format!("\n  {}", diagnostic_message(*child)));
    }
    message
}

pub(crate) fn emit(
    workspace: &Workspace,
    input: &Path,
    temporary: &Path,
    out: &Path,
) -> Result<()> {
    let region = tsrs_core::arena::Region::new(1 << 20);
    let result = {
        let _scope = region.enter();
        emit_in_region(workspace, input, temporary, out)
    };
    drop(region);
    result
}

fn emit_in_region(workspace: &Workspace, input: &Path, temporary: &Path, out: &Path) -> Result<()> {
    let config = temporary.join("tsconfig.json");
    let source_root = input
        .ancestors()
        .last()
        .ok_or("source must have an absolute path")?;
    let paths: serde_json::Map<String, serde_json::Value> = workspace
        .modules
        .iter()
        .map(|(name, file)| (name.clone(), json!([file])))
        .collect();
    std::fs::write(
        &config,
        serde_json::to_vec(&json!({
            "extends": workspace.root.join("tsconfig.base.json"),
            "compilerOptions": {"rootDir": source_root, "outDir": out, "paths": paths},
            "files": [input, workspace.api.join("dango.d.ts")]
        }))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(osvfs::fs()));
    let cwd = workspace.root.to_string_lossy().into_owned();
    let host = ConfigHost {
        fs: fs.clone(),
        cwd: cwd.clone(),
    };
    let (config, errors) = tsrs_tsoptions::get_parsed_command_line_of_config_file(
        &config.to_string_lossy(),
        None,
        None,
        &host,
        None,
    );
    if !errors.is_empty() {
        return Err(errors
            .into_iter()
            .map(diagnostic)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let compiler_host =
        new_cached_fs_compiler_host(&cwd, fs, &bundled::lib_path(), None, None, None);
    let mut options = ProgramOptions::new(
        P::new(config.ok_or("cannot parse compilation project")?),
        compiler_host,
    );
    options.single_threaded = Tristate::True;
    let guard = ProgramGuard(new_program(options));
    let program = guard.0;
    let ctx = Context::default();
    let mut diagnostics = program.get_config_file_parsing_diagnostics().to_vec();
    diagnostics.extend(program.get_program_diagnostics());
    diagnostics.extend(program.get_global_diagnostics(&ctx));
    diagnostics.extend(program.get_syntactic_diagnostics(&ctx, None));
    diagnostics.extend(program.get_semantic_diagnostics(&ctx, None));
    let mut violations = diagnostics.into_iter().map(diagnostic).collect::<Vec<_>>();
    subset::check(program, &ctx, workspace, input, &mut violations)?;
    if !violations.is_empty() {
        return Err(violations.join("\n"));
    }
    let emitted = program.emit(&ctx, &tsrs_compiler::EmitOptions::default());
    if emitted.emit_skipped || !emitted.diagnostics.is_empty() {
        return Err(format!(
            "tsrs emit failed: {}",
            emitted
                .diagnostics
                .into_iter()
                .map(diagnostic)
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    Ok(())
}
