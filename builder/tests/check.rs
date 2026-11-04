use embedts_builder::check;
use std::path::Path;

fn fixture(source: &str, run: impl FnOnce(&Path)) {
    let root = tempfile::tempdir().unwrap();
    let entry = root.path().join("main.ts");
    std::fs::write(&entry, source).unwrap();
    run(&entry);
}

#[test]
fn accept_type_only_sdk_import() {
    fixture(
        r####"import type {Point} from "dango:display";export function main():number{const p:Point={id:0,x:1,y:2};return p.x+p.y;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_async_entry() {
    fixture(
        r####"export async function main():Promise<number> {return 1;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_async_scalar_union() {
    fixture(
        r####"export async function main():Promise<number|void> {return 42;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_async_sdk() {
    fixture(
        r####"import {sleep,nowMs} from "dango:system";export async function main():Promise<number>{await sleep(1);return nowMs();}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_typed_array_indices() {
    fixture(
        r####"export function main():number {const a=new Uint8Array([7]);return a[0]??0;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_optional_tuple_indices() {
    fixture(
        r####"export function main():number {const o:{p?:[number]}={p:[42]};return o.p?.[0]??0;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_typed_native_calls() {
    fixture(
        r####"import {emit} from "dango:host"; export function main():number {emit(42);return 42;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_declared_properties_and_tuples() {
    fixture(
        r####"export function main():number {const o={x:1};o.x=2;const a:[number]=[o.x];return a[0];}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_directive_like_strings() {
    fixture(
        r####"export function main():number {const s="// @ts-ignore";return s.length;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_directive_like_templates() {
    fixture(
        r####"export function main():number {const s=`// @ts-ignore ${1} /* @ts-nocheck */`;return s.length;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn accept_stateful_tick() {
    fixture(
        r####"let total=0;export function main():void {} export function onTick(at:number):void {total+=at;}"####,
        |file| {
            let output = check(file).unwrap();
            assert!(output.contains("function main("), "{output}");
        },
    );
}

#[test]
fn reject_async_invalid_union() {
    fixture(
        r####"export async function main():Promise<number|string> {return "invalid";}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"must return"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_explicit_any() {
    fixture(
        r####"export function main():number {const x:any=1;return x;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"any"####).unwrap().is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_implicit_any() {
    fixture(
        r####"function f(x){return x;} export function main():number{return f(1);}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"implicitly has an 'any'"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_transitive_any() {
    fixture(
        r####"export function main():number {const value=JSON.parse("1");return value;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"any-valued"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_assertion_escape() {
    fixture(
        r####"export function main():number {return (1 as unknown as number);}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"type assertions"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_non_null_assertion() {
    fixture(
        r####"export function main():number {const x:number[]=[];return x[0]!;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"type assertions"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_ignore_directive() {
    fixture(
        r####"// @ts-ignore
export function main():number {return "x";}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"suppression"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_expect_error_directive() {
    fixture(
        r####"// @ts-expect-error
export function main():number {return "x";}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"suppression"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_nocheck_directive() {
    fixture(
        r####"// @ts-nocheck
export function main():number {return "x";}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"suppression"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_interior_directive() {
    fixture(
        r####"export function main():void { /* @ts-ignore */ }"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"suppression"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_delete() {
    fixture(
        r####"export function main():number {const x:{a?:number}={a:1};delete x.a;return 1;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"delete"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_undeclared_property() {
    fixture(
        r####"export function main():number {const x={a:1};x.b=2;return x.a;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"does not exist"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_eval_alias() {
    fixture(
        r####"const run=eval;export function main():number {return run("1");}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"eval"####).unwrap().is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_function() {
    fixture(
        r####"export function main():number {return Function("return 1")();}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"Function"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_constructor_access() {
    fixture(
        r####"export function main():number {return main.constructor("return 1")();}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"construction"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_computed_constructor() {
    fixture(
        r####"export function main():number {return main["constructor"]("return 1")();}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"computed access"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_proxy() {
    fixture(
        r####"const P=Proxy;export function main():number {return 1;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"Proxy"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_reflect() {
    fixture(
        r####"const R=Reflect;export function main():number {return 1;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"Reflect"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_object_mutation_alias() {
    fixture(
        r####"const {defineProperty}=Object;export function main():number{return 1;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"Object"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_unavailable_intrinsic() {
    fixture(
        r####"export function main():number {return Date.now();}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"Date"####).unwrap().is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_unavailable_regex() {
    fixture(
        r####"export function main():number {return /x/.test("x") ? 1 : 0;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"regular expressions"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_ambient_escape() {
    fixture(
        r####"declare function f():number; export function main():number {return f();}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"ambient declarations"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_unresolved_local_import() {
    fixture(
        r####"import {x} from "./other";export function main():number {return x;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"Cannot find module"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_package_import() {
    fixture(
        r####"import x from "some-package";export function main():number {return 1;}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"imports only"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_dynamic_import() {
    fixture(
        r####"export function main():void {import("dango:host");}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"dynamic import"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_async_string_entry() {
    fixture(
        r####"export async function main():Promise<string> {return "no";}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"must return"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_top_level_await() {
    fixture(
        r####"await Promise.resolve();export function main():void{}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"top-level await"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn reject_missing_entry() {
    fixture(r####"export const x=1;"####, |file| {
        let error = check(file).unwrap_err();
        assert!(
            regex::Regex::new(r####"main.*required"####)
                .unwrap()
                .is_match(&error),
            "{error}"
        );
    });
}

#[test]
fn reject_wrong_tick_signature() {
    fixture(
        r####"export function main():void{} export function onTick(x:string):void{}"####,
        |file| {
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"parameter must be number"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn relative_typed_helper() {
    fixture(
        r####"import {value} from "./helper.js";export function main():number{return value();}"####,
        |file| {
            std::fs::write(
                file.parent().unwrap().join("helper.ts"),
                r####"export function value():number{return 7;}"####,
            )
            .unwrap();
            let output = check(file).unwrap();
            assert!(output.contains("return 7"), "{output}");
        },
    );
}

#[test]
fn relative_transitive_any() {
    fixture(
        r####"import {value} from "./helper.js";export function main():number{return value();}"####,
        |file| {
            std::fs::write(
                file.parent().unwrap().join("helper.ts"),
                r####"export function value():number{const x:any=7;return x;}"####,
            )
            .unwrap();
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"any"####).unwrap().is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn relative_transitive_directive() {
    fixture(
        r####"import {value} from "./helper.js";export function main():number{return value();}"####,
        |file| {
            std::fs::write(
                file.parent().unwrap().join("helper.ts"),
                r####"// @ts-nocheck
export function value():number{return 7;}"####,
            )
            .unwrap();
            let error = check(file).unwrap_err();
            assert!(
                regex::Regex::new(r####"suppression"####)
                    .unwrap()
                    .is_match(&error),
                "{error}"
            );
        },
    );
}

#[test]
fn workspace_exports_bundle_to_one_native_module_reproducibly() {
    fixture(
        r#"import {Random} from "@dango/sdk/game";import {print} from "@dango/sdk/system";export function main():number{print("workspace");return new Random(1).next();}"#,
        |file| {
            let first = check(file).unwrap();
            assert_eq!(first, check(file).unwrap());
            assert!(first.contains("dango:host"));
            for forbidden in [
                "from \"@dango",
                "embedts-",
                "node_modules",
                "typescript/compiler",
            ] {
                assert!(!first.contains(forbidden), "{first}");
            }
        },
    );
}
