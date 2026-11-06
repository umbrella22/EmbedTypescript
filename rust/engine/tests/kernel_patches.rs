#[path = "../build_support/patch.rs"]
mod patch;

#[test]
fn pinned_diffs_require_exact_positions_context_and_counts() {
    let source = "one\ntwo\nthree\n";
    let diff =
        "--- a/quickjs.c\n+++ b/quickjs.c\n@@ -1,3 +1,4 @@\n one\n-two\n+second\n+extra\n three\n";
    assert_eq!(
        patch::apply(source, diff).unwrap(),
        "one\nsecond\nextra\nthree\n"
    );
    for changed in [
        diff.replace(" two", " other").replace("-two", "-other"),
        diff.replace("-1,3", "-2,3"),
        diff.replace("+1,4", "+2,4"),
        diff.replace("-1,3", "-1,2"),
        diff.replace("b/quickjs.c", "b/other.c"),
    ] {
        assert!(patch::apply(source, &changed).is_err(), "{changed}");
    }
    assert!(patch::apply(source, "--- a/quickjs.c\n+++ b/quickjs.c\n").is_err());
}

#[test]
fn upstream_source_and_ordered_patch_series_match_the_pinned_manifest() {
    use sha2::{Digest, Sha256};
    let mut source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/vendor/quickjs-ng/quickjs.c"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(source.as_bytes())),
        "57780ab2e02002161029992174fdcedb10bf668af51f45de4071c00d6bc9803c"
    );
    for diff in [
        include_str!("../patches/quickjs-ng/0001-settled-promise-reactions.patch"),
        include_str!("../patches/quickjs-ng/0002-integer-remainder.patch"),
        include_str!("../patches/quickjs-ng/0003-numeric-comparisons.patch"),
        include_str!("../patches/quickjs-ng/0004-nullish-branches.patch"),
    ] {
        source = patch::apply(&source, diff).unwrap();
        assert!(
            patch::apply(&source, diff).is_err(),
            "patch must not apply twice"
        );
    }
    assert!(source.contains("static bool js_float64_mod_int32"));
    assert!(source.contains("Settled promises do not need"));
}
