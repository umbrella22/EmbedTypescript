//! Direct interpreter measurements; no OS runner, UI, or fixed-duration sleeps.
use embedts_engine::{compile_module, CallState, Limits, Package, Vm, GLOBAL_ALLOCATOR};
use serde_json::json;
use std::time::Instant;

const SOURCE: &str = include_str!("../tests/fixtures/kernel-workloads.js");

fn expected(name: &str, count: i32) -> i32 {
    match name {
        "integer" => (0..count).fold(1_u64, |value, _| value * 48_271 % 2_147_483_647) as i32,
        "remainder" => (0..count).fold(0_u64, |sum, i| {
            (sum + (4_503_599_627_370_496 + (i as u64 & 1023)) % 1_000_000_007) % 1_000_000_007
        }) as i32,
        "signed" => (0..count).fold(0_i32, |sum, i| sum.wrapping_add(-i % 997)),
        "settled" | "pending" => count * (count - 1) / 2,
        "chain" => count * (count + 1) / 2,
        _ => unreachable!(),
    }
}

fn main() {
    let rounds: usize = std::env::args().nth(1).map_or(7, |v| v.parse().unwrap());
    assert!((1..=31).contains(&rounds));
    let bytes = compile_module(SOURCE).unwrap();
    let mut results = Vec::new();
    for (name, count) in [
        ("integer", 200_000),
        ("remainder", 200_000),
        ("signed", 200_000),
        ("settled", 8_192),
        ("pending", 4_096),
        ("chain", 8_192),
    ] {
        let mut samples = Vec::new();
        for sample in 0..=rounds {
            let mut vm = Vm::new(
                Box::new(()),
                Limits {
                    memory_bytes: 4 * 1024 * 1024,
                    interrupt_polls: 10_000_000,
                    ..Default::default()
                },
                &GLOBAL_ALLOCATOR,
            )
            .unwrap();
            // This module was compiled from the fixture in this process.
            unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
            let started = Instant::now();
            let mut state = vm.start(name, Some(count)).unwrap();
            let mut jobs = 0;
            while state == CallState::Pending {
                jobs += vm.drain_jobs(32).unwrap().executed;
                state = vm.entry_status().unwrap();
            }
            let elapsed_ns = started.elapsed().as_nanos() as u64;
            assert_eq!(state, CallState::Done(expected(name, count)), "{name}");
            let stats = vm.close();
            assert_eq!(stats.used, 0);
            assert_eq!(stats.failures, 0);
            if sample != 0 {
                samples.push(
                    json!({"elapsed_ns":elapsed_ns,"jobs":jobs,"peak_bytes":stats.peak,
                    "allocations":stats.allocations,"used_after_close":stats.used}),
                );
            }
        }
        results.push(
            json!({"case":name,"count":count,"expected":expected(name,count),"samples":samples}),
        );
    }
    println!(
        "{}",
        json!({"engine_id":embedts_engine::ENGINE_ID,"rounds":rounds,"warmups":1,"results":results})
    );
}
