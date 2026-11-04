use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[path = "build_support/patch.rs"]
mod patch;

const PATCHES: &[(&str, &str)] = &[
    (
        "0001-settled-promise-reactions",
        include_str!("patches/quickjs-ng/0001-settled-promise-reactions.patch"),
    ),
    (
        "0002-integer-remainder",
        include_str!("patches/quickjs-ng/0002-integer-remainder.patch"),
    ),
];

const SOURCES: &[&str] = &[
    "quickjs.c",
    "quickjs.h",
    "quickjs-atom.h",
    "quickjs-opcode.h",
    "quickjs-c-atomics.h",
    "cutils.h",
    "dtoa.c",
    "dtoa.h",
    "libregexp.c",
    "libregexp.h",
    "libregexp-opcode.h",
    "libunicode.c",
    "libunicode.h",
    "libunicode-table.h",
    "list.h",
    "builtin-array-fromasync.h",
    "builtin-iterator-zip.h",
    "builtin-iterator-zip-keyed.h",
];

fn replace_function(source: &mut String, name: &str, body: &str) {
    let signature = format!(" {name}(void)");
    let start = source
        .rfind(&signature)
        .expect("pinned portability function");
    let brace = start + source[start..].find('{').unwrap();
    let mut depth = 0;
    let mut end = brace;
    for (i, b) in source.as_bytes()[brace..].iter().enumerate() {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = brace + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    source.replace_range(brace..end, body);
}

fn main() {
    let device = std::env::var("CARGO_CFG_TARGET_OS").unwrap() == "none";
    let compiler = std::env::var_os("CARGO_FEATURE_COMPILER").is_some();
    assert!(
        !(device && compiler),
        "embedts-engine/compiler is host-only"
    );
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let mut digest = Sha256::new();
    digest.update(b"embedts-bytecode-v1:single-thread:no-atomics:host-abi-3");
    for name in SOURCES {
        let bytes = fs::read(format!("vendor/quickjs-ng/{name}")).unwrap();
        digest.update(name.as_bytes());
        digest.update(&bytes);
        fs::write(out.join(name), bytes).unwrap();
    }
    let profile =
        std::env::var("EMBEDTS_QJS_KERNEL_PROFILE").unwrap_or_else(|_| "optimized".into());
    assert!(matches!(profile.as_str(), "optimized" | "upstream"));
    digest.update(profile.as_bytes());
    if profile == "optimized" {
        let mut source = fs::read_to_string(out.join("quickjs.c")).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(source.as_bytes())),
            "57780ab2e02002161029992174fdcedb10bf668af51f45de4071c00d6bc9803c",
            "kernel patches require their pinned upstream source"
        );
        for (name, diff) in PATCHES {
            source = patch::apply(&source, diff).unwrap_or_else(|error| panic!("{name}: {error}"));
            digest.update(name.as_bytes());
            digest.update(diff.as_bytes());
        }
        fs::write(out.join("quickjs.c"), source).unwrap();
    }
    // Keep vendored sources byte-for-byte upstream. Portability edits apply to
    // the build copy, identically for host and device threading semantics.
    let mut utils = fs::read_to_string(out.join("cutils.h")).unwrap();
    utils = utils.replace("#if !defined(_WIN32) && !defined(EMSCRIPTEN) && !defined(__wasi__) && !defined(__DJGPP)", "#if !defined(EMBEDTS_QJS_SINGLE_THREAD) && !defined(_WIN32) && !defined(EMSCRIPTEN) && !defined(__wasi__) && !defined(__DJGPP)");
    utils = utils.replace("#if defined(EMSCRIPTEN) || defined(__wasi__) || defined(__DJGPP)", "#if defined(EMBEDTS_QJS_SINGLE_THREAD) || defined(EMSCRIPTEN) || defined(__wasi__) || defined(__DJGPP)");
    if device {
        replace_function(
            &mut utils,
            "js__hrtime_ns",
            "{ extern uint64_t embedts_platform_us(void); return embedts_platform_us() * 1000; }",
        );
        replace_function(
            &mut utils,
            "js__gettimeofday_us",
            "{ extern uint64_t embedts_platform_us(void); return embedts_platform_us(); }",
        );
    }
    fs::write(out.join("cutils.h"), utils).unwrap();
    // Changes to the bridge or its portability recipe also invalidate packages.
    digest.update(fs::read("csrc/bridge.c").unwrap());
    digest.update(fs::read("csrc/calendar.c").unwrap());
    digest.update(fs::read("build.rs").unwrap());
    digest.update(fs::read("build_support/patch.rs").unwrap());
    let id: [u8; 32] = digest.finalize().into();
    fs::write(
        out.join("engine_id.rs"),
        format!("pub const ENGINE_ID: [u8;32] = {id:?};\n"),
    )
    .unwrap();
    let optimization: u32 = std::env::var("EMBEDTS_QJS_OPT_LEVEL")
        .unwrap_or_else(|_| "2".into())
        .parse()
        .expect("EMBEDTS_QJS_OPT_LEVEL must be 2 or 3");
    assert!(matches!(optimization, 2 | 3));
    println!("cargo:rerun-if-env-changed=EMBEDTS_QJS_OPT_LEVEL");
    let mut build = cc::Build::new();
    build
        .include(&out)
        .define("EMBEDTS_QJS_SINGLE_THREAD", None)
        .define("__STDC_NO_ATOMICS__", "1")
        .define("NDEBUG", None)
        .flag_if_supported("-std=gnu11")
        .flag_if_supported("-ffunction-sections")
        .flag_if_supported("-fdata-sections")
        .warnings(false)
        .opt_level(optimization);
    if device {
        // GCC's freestanding stdint.h omits the newlib typedef markers that
        // inttypes.h needs for PRI*64. Import newlib's compatible integer
        // typedefs before the engine headers; retain -ffreestanding semantics.
        build.flag("-include").flag("sys/_stdint.h");
    }
    if compiler {
        build.define("EMBEDTS_COMPILER", None);
    } else {
        build.define("QJS_DISABLE_PARSER", None);
    }
    for name in ["quickjs.c", "libregexp.c", "libunicode.c", "dtoa.c"] {
        build.file(out.join(name));
    }
    build
        .file("csrc/calendar.c")
        .file("csrc/bridge.c")
        .compile("embedts");
    println!("cargo:rerun-if-changed=vendor");
    println!("cargo:rerun-if-changed=patches");
    println!("cargo:rerun-if-changed=build_support");
    println!("cargo:rerun-if-env-changed=EMBEDTS_QJS_KERNEL_PROFILE");
    println!("cargo:rerun-if-changed=csrc");
    println!("cargo:rerun-if-changed=build.rs");
}
