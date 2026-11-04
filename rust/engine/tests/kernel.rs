#![cfg(feature = "compiler")]
use embedts_engine::{compile_module, CallState, Limits, Package, Vm, GLOBAL_ALLOCATOR};

fn run(source: &str) {
    let bytes = compile_module(source).unwrap();
    let mut vm = Vm::new(
        Box::new(()),
        Limits {
            interrupt_polls: 100_000,
            memory_bytes: 4 * 1024 * 1024,
            ..Default::default()
        },
        &GLOBAL_ALLOCATOR,
    )
    .unwrap();
    // All bytecode comes from this test's trusted compiler.
    unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
    let mut state = vm.start("main", None).unwrap();
    for _ in 0..10_000 {
        if state != CallState::Pending {
            break;
        }
        vm.drain_jobs(1).unwrap();
        state = vm.entry_status().unwrap();
    }
    assert_eq!(state, CallState::Done(42));
    assert!(!vm.drain_jobs(100).unwrap().pending);
    let stats = vm.close();
    assert_eq!(stats.used, 0);
    assert_eq!(stats.failures, 0);
}

fn literal(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value == f64::INFINITY {
        "Infinity".into()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".into()
    } else if value == 0.0 && value.is_sign_negative() {
        "-0".into()
    } else {
        value.to_string()
    }
}

#[test]
fn numeric_remainder_matches_independent_ieee_reference() {
    let mut source = String::from(
        "function check(a,b,r){if(!Object.is(a%b,r))throw Error(String(a)+' % '+String(b));} export function main(){",
    );
    let dividends = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        1.5,
        -1.5,
        2_147_483_647.0,
        -2_147_483_648.0,
        2_147_483_648.0,
        -2_147_483_649.0,
        4_294_967_295.0,
        4_294_967_296.0,
        -4_294_967_296.0,
        4_503_599_627_370_496.0,
        -4_503_599_627_370_496.0,
        9_007_199_254_740_991.0,
        -9_007_199_254_740_991.0,
        9_007_199_254_740_992.0,
        -9_007_199_254_740_992.0,
        f64::MAX,
        f64::MIN_POSITIVE,
        f64::from_bits(1),
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];
    let divisors = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        2.0,
        -3.0,
        997.0,
        -997.0,
        2_147_483_647.0,
        -2_147_483_648.0,
        2_147_483_648.0,
        0.5,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut check = |a: f64, b: f64| {
        source.push_str(&format!(
            "check(Number('{}'),Number('{}'),{});",
            literal(a),
            literal(b),
            literal(a % b)
        ));
    };
    for a in dividends {
        for b in divisors {
            check(a, b);
        }
    }
    for exponent in 0..=53 {
        let power = 2_f64.powi(exponent);
        for magnitude in [power, power - 1.0, power + 1.0, power + 0.5] {
            for divisor in [1.0, -1.0, 997.0, -997.0, 2_147_483_647.0, -2_147_483_648.0] {
                check(magnitude, divisor);
                check(-magnitude, divisor);
            }
        }
    }
    let mut state = 0x4a32_19bd_8ef5_6301_u64;
    for _ in 0..512 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let magnitude = (state & ((1_u64 << 53) - 1)) as f64;
        let a = if state & (1 << 63) == 0 {
            magnitude
        } else {
            -magnitude
        };
        check(a, (state as i32) as f64);
        check(f64::from_bits(state), (state.rotate_left(17) as i32) as f64);
    }
    source.push_str("return 42;}");
    run(&source);
}

#[test]
fn remainder_preserves_coercions_bigints_and_exception_order() {
    run(r#"
        export function main() {
            let seen = '';
            const a = {valueOf(){seen+='a';return -2147483648;}};
            const b = {valueOf(){seen+='b';return -1;}};
            if (!Object.is(a % b, -0) || seen !== 'ab') throw Error('coercion');
            if ((-9007199254740991n % 997n) !== -663n) throw Error('bigint');
            try { 1n % 2; throw Error('mixed bigint accepted'); }
            catch (e) { if (!(e instanceof TypeError)) throw e; }
            if ('4294967296' % '997' !== 966) throw Error('string');
            if (!Number.isNaN(1 % 0) || !Object.is(-4 % 2, -0)) throw Error('zero');
            return 42;
        }
    "#);
}

#[test]
fn settled_and_pending_promises_preserve_jobs_handlers_and_species() {
    run(r#"
        function check(value, message) { if (!value) throw Error(message); }
        export async function main() {
            let called = false;
            const settled = Promise.resolve(3).then(v => { called = true; return v + 1; });
            check(!called, 'handler ran synchronously');
            check(await settled === 4 && called, 'fulfilled');
            let resolve;
            const pending = new Promise(r => { resolve = r; });
            let count = 0;
            const subscribers = [pending.then(v => {count++;return v;}), pending.then(v => v+1)];
            resolve(7);
            check(count === 0, 'pending handler ran synchronously');
            check((await Promise.all(subscribers)).join(',') === '7,8' && count === 1, 'pending');
            const reason = {code: 9};
            check(await Promise.reject(reason).then(null, e => e) === reason, 'rejection');
            check(await Promise.resolve(11).then({}) === 11, 'non callable fulfillment');
            check(await Promise.reject(reason).then(null, {}).catch(e => e) === reason, 'non callable rejection');
            const order = [];
            const first = Promise.resolve().then(() => order.push('first'));
            const second = Promise.resolve().then(() => order.push('second'));
            order.push('sync');
            await Promise.all([first, second]);
            check(order.join(',') === 'sync,first,second', 'job order');
            let gets = 0;
            const thenable = {get then(){gets++;return r => r(23);}};
            check(await thenable === 23 && gets === 1, 'thenable');
            check(await Promise.resolve(1).then(() => {throw reason;}).catch(e => e) === reason, 'throw');
            let final = 0;
            check(await Promise.resolve(5).finally(() => final++) === 5 && final === 1, 'finally');
            class Derived extends Promise {}
            const derived = Derived.resolve(8).then(v => v + 1);
            check(derived instanceof Derived && await derived === 9, 'species');
            return 42;
        }
    "#);
}

#[test]
fn promise_reaction_oom_releases_both_pending_and_queued_reactions() {
    for promise in ["Promise.resolve(1)", "new Promise(() => {})"] {
        let source = format!(
            "export function main(){{const p={promise}; const keep=[]; for(let i=0;i<100000;i++)keep.push(p.then(v=>v));return 1;}}"
        );
        let bytes = compile_module(&source).unwrap();
        let mut vm = Vm::new(
            Box::new(()),
            Limits {
                memory_bytes: 256 * 1024,
                interrupt_polls: 100_000,
                ..Default::default()
            },
            &GLOBAL_ALLOCATOR,
        )
        .unwrap();
        // The trusted compiler in this test produced the complete package.
        unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
        assert_eq!(
            vm.start("main", None).unwrap_err().kind,
            embedts_engine::ErrorKind::Memory
        );
        let stats = vm.close();
        assert_eq!(stats.used, 0);
        assert!(stats.failures > 0);
    }
}
