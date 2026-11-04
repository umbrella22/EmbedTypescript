//! Runtime subset checks on the original, semantically checked TypeScript AST.
use crate::{frontend::location, workspace::Workspace, Result};
use std::path::Path;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_checker::{Checker, SignatureKind, TypeFlags};
use tsrs_compiler::{Context, Program};
use tsrs_core::P;

const FORBIDDEN: &[&str] = &[
    "eval",
    "Function",
    "Proxy",
    "Reflect",
    "globalThis",
    "require",
    "Object",
    "Date",
    "RegExp",
    "WeakRef",
    "FinalizationRegistry",
    "Atomics",
    "SharedArrayBuffer",
];
const MUTATIONS: &[&str] = &[
    "constructor",
    "prototype",
    "__proto__",
    "setPrototypeOf",
    "defineProperty",
    "defineProperties",
    "assign",
];
const TYPED_ARRAYS: &[&str] = &[
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
];

pub(crate) fn check(
    program: &Program,
    ctx: &Context,
    workspace: &Workspace,
    input: &Path,
    violations: &mut Vec<String>,
) -> Result<()> {
    for &file in program.source_files() {
        if program.is_source_file_default_library(file.path())
            || (Path::new(file.file_name()) != input
                && workspace.is_sdk_api(Path::new(file.file_name())))
        {
            continue;
        }
        check_directives(file, violations);
        let mut checker = program.get_type_checker_for_file(ctx, file);
        Visitor {
            program,
            workspace,
            file,
            checker: &mut checker,
            violations,
        }
        .visit(file.as_node(), false);
    }
    let entry = program
        .get_source_file(&input.to_string_lossy())
        .ok_or("cannot read TypeScript entry")?;
    let mut checker = program.get_type_checker_for_file(ctx, entry);
    let exports = checker
        .get_symbol_at_location_exported(entry.as_node())
        .map(|symbol| checker.get_exports_of_module_exported(symbol))
        .unwrap_or_default();
    if !exports.iter().any(|symbol| symbol.name() == "main") {
        violations.push(format!(
            "{}: export function main() is required",
            input.display()
        ));
    }
    for symbol in exports
        .into_iter()
        .filter(|symbol| matches!(symbol.name(), "main" | "onTick"))
    {
        let Some(t) = checker.get_type_of_symbol_at_location(symbol, Some(entry.as_node())) else {
            violations.push(format!(
                "{}: cannot resolve entry type: {}",
                input.display(),
                symbol.name()
            ));
            continue;
        };
        let signatures = checker.get_signatures_of_type_exported(t, SignatureKind::Call);
        let expected = usize::from(symbol.name() == "onTick");
        let reject = |violations: &mut Vec<String>, message: String| {
            violations.push(format!("{}: {message}", input.display()))
        };
        if signatures.len() != 1 || signatures[0].parameters().len() != expected {
            reject(
                violations,
                format!("{} requires {expected} parameter(s)", symbol.name()),
            );
            continue;
        }
        let signature = signatures[0];
        let mut result = checker.get_return_type_of_signature_exported(signature);
        if result.symbol().is_some_and(|s| s.name() == "Promise") {
            if let Some(&inner) = checker.get_type_arguments_exported(result).first() {
                result = inner;
            }
        }
        let results = if result.flags().contains(TypeFlags::Union) {
            result.types()
        } else {
            std::slice::from_ref(&result)
        };
        if results.is_empty()
            || !results.iter().all(|t| {
                t.flags()
                    .intersects(TypeFlags::NumberLike | TypeFlags::Void)
            })
        {
            reject(
                violations,
                format!(
                    "{} must return number, void or Promise<number|void>",
                    symbol.name()
                ),
            );
        }
        if expected != 0
            && !checker
                .get_type_of_symbol_at_location(signature.parameters()[0], Some(entry.as_node()))
                .is_some_and(|t| t.flags().intersects(TypeFlags::NumberLike))
        {
            reject(violations, "onTick parameter must be number".into());
        }
    }
    Ok(())
}

struct Visitor<'a> {
    program: &'a Program,
    workspace: &'a Workspace,
    file: P<SourceFile>,
    checker: &'a mut Checker,
    violations: &'a mut Vec<String>,
}

impl Visitor<'_> {
    fn reject(&mut self, node: P<Node>, message: impl AsRef<str>) {
        let pos = tsrs_scanner::get_token_pos_of_node(node, self.file, false);
        self.violations.push(format!(
            "{}: {}",
            location(&self.file, pos),
            message.as_ref()
        ));
    }
    fn visit(&mut self, node: P<Node>, type_position: bool) {
        let kind = node.kind();
        let in_type = type_position
            || ast::is_type_node(node)
            || (matches!(kind, Kind::ImportClause | Kind::ImportSpecifier) && node.is_type_only());
        match kind {
            Kind::AnyKeyword => self.reject(node, "any is forbidden"),
            Kind::AsExpression | Kind::TypeAssertionExpression | Kind::NonNullExpression => {
                self.reject(node, "type assertions are forbidden in subset v1")
            }
            Kind::DeleteExpression => self.reject(node, "delete is forbidden"),
            Kind::RegularExpressionLiteral => self.reject(
                node,
                "regular expressions are unavailable in the bootstrap runtime",
            ),
            Kind::Identifier if FORBIDDEN.contains(&node.text()) => {
                self.reject(node, format!("{} is forbidden", node.text()))
            }
            Kind::PropertyAccessExpression
                if MUTATIONS.contains(&node.as_property_access_expression().name().text()) =>
            {
                self.reject(node, "dynamic object mutation or construction is forbidden")
            }
            Kind::ElementAccessExpression => {
                let access = node.as_element_access_expression();
                let index = self
                    .checker
                    .get_type_at_location(access.argument_expression());
                let target = self.checker.get_type_at_location(access.expression());
                let target = self.checker.get_non_nullable_type(target);
                let typed_array = target.symbol().is_some_and(|symbol| {
                    TYPED_ARRAYS.contains(&symbol.name())
                        && symbol.declarations().iter().any(|&declaration| {
                            ast::get_source_file_of_node(declaration).is_some_and(|file| {
                                self.program.is_source_file_default_library(file.path())
                            })
                        })
                });
                if !index.flags().intersects(TypeFlags::NumberLike)
                    || !(self.checker.is_array_type_exported(target)
                        || tsrs_checker::is_tuple_type_exported(target)
                        || typed_array)
                {
                    self.reject(
                        node,
                        "computed access is limited to numeric array/tuple/typed-array indices",
                    );
                }
            }
            Kind::ImportDeclaration => {
                let module = node.as_import_declaration().module_specifier();
                if module.kind() != Kind::StringLiteral
                    || !(module.text() == "dango:host"
                        || self.workspace.modules.contains_key(module.text())
                        || module.text().starts_with("./")
                        || module.text().starts_with("../"))
                {
                    self.reject(node, "imports only support declared workspace packages, dango SDK modules and relative TypeScript modules");
                }
            }
            Kind::ImportEqualsDeclaration | Kind::ExportDeclaration | Kind::ExportAssignment => {
                self.reject(node, "use direct named ES module exports")
            }
            Kind::CallExpression
                if node
                    .expression()
                    .is_some_and(|expression| expression.kind() == Kind::ImportKeyword) =>
            {
                self.reject(node, "dynamic import is forbidden")
            }
            Kind::AwaitExpression => {
                let mut parent = node.parent();
                while let Some(p) = parent {
                    if p.kind() == Kind::SourceFile || ast::is_function_like_declaration(p) {
                        break;
                    }
                    parent = p.parent();
                }
                if parent.is_none_or(|p| p.kind() == Kind::SourceFile) {
                    self.reject(node, "top-level await is unsupported");
                }
            }
            _ => {}
        }
        if node.modifiers().is_some_and(|modifiers| {
            modifiers
                .nodes()
                .iter()
                .any(|m| m.kind() == Kind::DeclareKeyword)
        }) {
            self.reject(node, "application ambient declarations are forbidden");
        }
        let import_specifier = node.parent().is_some_and(|parent| {
            parent.kind() == Kind::ImportDeclaration && parent.module_specifier() == Some(node)
        });
        if !in_type
            && ast::is_expression(node)
            && !import_specifier
            && self
                .checker
                .get_type_at_location(node)
                .flags()
                .contains(TypeFlags::Any)
        {
            self.reject(node, "any-valued expressions are forbidden");
        }
        node.for_each_child(&mut |child| {
            self.visit(child, in_type);
            false
        });
    }
}

fn literal_spans(node: P<Node>, file: P<SourceFile>, spans: &mut Vec<(usize, usize)>) {
    if matches!(
        node.kind(),
        Kind::StringLiteral
            | Kind::NoSubstitutionTemplateLiteral
            | Kind::RegularExpressionLiteral
            | Kind::TemplateHead
            | Kind::TemplateMiddle
            | Kind::TemplateTail
    ) {
        spans.push((
            tsrs_scanner::get_token_pos_of_node(node, file, false) as usize,
            node.end().expect_source("parsed literal") as usize,
        ));
    }
    node.for_each_child(&mut |child| {
        literal_spans(child, file, spans);
        false
    });
}

fn check_directives(file: P<SourceFile>, violations: &mut Vec<String>) {
    let mut spans = Vec::new();
    literal_spans(file.as_node(), file, &mut spans);
    spans.sort_unstable();
    let mut masked = file.text().as_bytes().to_vec();
    for (start, end) in spans {
        for byte in &mut masked[start..end] {
            if !matches!(*byte, b'\r' | b'\n') {
                *byte = b' ';
            }
        }
    }
    let text = String::from_utf8(masked).expect("only complete literal spans masked");
    let mut scanner = tsrs_scanner::Scanner::new();
    scanner.set_text(tsrs_core::alloc_str(&text));
    scanner.set_skip_trivia(false);
    let directive = regex::Regex::new(r"@ts-(?:ignore|expect-error|nocheck)\b").unwrap();
    loop {
        let token = scanner.scan();
        if token == Kind::EndOfFile {
            break;
        }
        if matches!(
            token,
            Kind::SingleLineCommentTrivia | Kind::MultiLineCommentTrivia
        ) && directive.is_match(scanner.token_text())
        {
            violations.push(format!(
                "{}: type-check suppression comments are forbidden",
                file.file_name()
            ));
        }
    }
}
