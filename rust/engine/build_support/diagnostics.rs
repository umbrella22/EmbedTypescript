//! Diagnostic hooks apply to either kernel profile, after the pinned patches.
pub fn instrument(source: &mut String) {
    fn replace(source: &mut String, before: &str, after: &str) {
        assert_eq!(
            source.matches(before).count(),
            1,
            "diagnostic anchor: {before}"
        );
        *source = source.replacen(before, after, 1);
    }
    replace(
        source,
        "#include \"quickjs.h\"",
        "#include \"quickjs.h\"\n#include \"diagnostics.h\"",
    );
    replace(
        source,
        "struct JSRuntime {",
        "struct JSRuntime {\n    EmbedTsInterpreterDiagnostics embedts_diagnostics;",
    );
    replace(source, "static JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,\n", "#include \"diagnostics.inc\"\n\nstatic JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,\n");
    // Both switch and computed-goto builds count the same executed opcodes.
    let anchor = "#define SWITCH(pc)      DUMP_BYTECODE_OR_DONT(pc) ";
    assert_eq!(source.matches(anchor).count(), 2);
    *source = source.replace(anchor, "#define SWITCH(pc)      DUMP_BYTECODE_OR_DONT(pc) embedts_note_opcode(rt, pc, b->byte_code_buf + b->byte_code_len, 1); ");
    for (signature, field) in [
        (
            "void *js_malloc_rt(JSRuntime *rt, size_t size)\n{",
            "malloc_calls",
        ),
        (
            "void *js_calloc_rt(JSRuntime *rt, size_t count, size_t size)\n{",
            "calloc_calls",
        ),
        (
            "void *js_realloc_rt(JSRuntime *rt, void *ptr, size_t size)\n{",
            "realloc_calls",
        ),
        ("void js_free_rt(JSRuntime *rt, void *ptr)\n{", "free_calls"),
    ] {
        replace(
            source,
            signature,
            &format!("{signature}\n    rt->embedts_diagnostics.{field}++;"),
        );
    }
}
