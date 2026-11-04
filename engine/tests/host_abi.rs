#![cfg(feature = "compiler")]
use embedts_engine::{
    compile_module, CallState, Draw, Host, HostError, HostReply, Limits, Package, Request, Vm,
    GLOBAL_ALLOCATOR,
};

struct Services;
impl Host for Services {
    fn draw(&mut self, draw: Draw) -> Result<(), HostError> {
        assert_eq!(draw.operation, 5);
        assert_eq!(draw.coordinates, [i32::MIN, i32::MAX, 0, -7, 8, 9]);
        assert_eq!(draw.color, u32::MAX);
        assert_eq!((draw.start, draw.end), (-0.25, 1.5));
        Err(HostError::new(259, "display closed"))
    }
    fn now_ms(&mut self) -> Result<u64, HostError> {
        Ok(4_294_967_300)
    }
    fn call(&mut self, operation: &str, _: &str, _: &[u8]) -> Result<HostReply, HostError> {
        match operation {
            "value" => Ok(HostReply::json(
                "{\"text\":\"团子\\u0000os\",\"number\":42,\"empty\":null}",
            )),
            "bytes" => Ok(HostReply {
                json: "null".into(),
                bytes: vec![0, 255, 7],
            }),
            "empty" => Ok(HostReply {
                json: String::new(),
                bytes: Vec::new(),
            }),
            _ => Err(HostError::new(2, "missing\0item")),
        }
    }
}

#[test]
fn scalar_draw_preserves_layout_and_rejects_coercion_before_the_host() {
    let mut vm = vm(r#"
        import {draw} from 'dango:host';
        export function main(){
            for(const bad of [-2147483649,2147483648,0.5,NaN,Infinity,'0',null,true,{}]){
                let rejected=false;try{draw(0,bad,0,0,0,0,0,0,0,0)}catch(e){rejected=e.code===258}
                if(!rejected)throw Error('coordinate validation');
            }
            for(const bad of [-1,4294967296,0.5,NaN,Infinity,'0']){
                let rejected=false;try{draw(0,0,0,0,0,0,0,bad,0,0)}catch(e){rejected=e.code===258}
                if(!rejected)throw Error('color validation');
            }
            for(const bad of [NaN,Infinity,-Infinity,'0']){
                let rejected=false;try{draw(0,0,0,0,0,0,0,0,bad,0)}catch(e){rejected=e.code===258}
                if(!rejected)throw Error('angle validation');
            }
            let caught=false;
            try{draw(5,-2147483648,2147483647,0,-7,8,9,4294967295,-0.25,1.5)}
            catch(e){caught=e.code===259 && e.message==='display closed'}
            if(!caught)throw Error('service error');
            return 42;
        }
    "#);
    assert_eq!(vm.start("main", None).unwrap(), CallState::Done(42));
    assert_eq!(vm.profile().draws, 1);
    let stats = vm.close();
    assert_eq!(stats.used, 0);
    assert_eq!(stats.failures, 0);
}
fn vm(source: &str) -> Vm {
    let bytes = compile_module(source).unwrap();
    let mut vm = Vm::new(
        Box::new(Services),
        Limits {
            pending_requests: 1,
            ..Default::default()
        },
        &GLOBAL_ALLOCATOR,
    )
    .unwrap();
    unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
    vm
}

#[test]
fn native_modes_preserve_unicode_binary_and_service_failures() {
    let mut vm = vm(r#"
        import {call,callBytes,callVoid,nowMs,requestReply,requestVoid} from 'dango:host';
        export async function main(){
            const r=call('value','[]');
            if(r.text!=='团子\0os'||r.number!==42||r.empty!==null)throw Error('value');
            const b=callBytes('bytes','[]');
            if(b.length!==3||b[0]!==0||b[1]!==255||b[2]!==7)throw Error('bytes');
            if(callBytes('empty','[]').length!==0||callVoid('empty','[]')!==undefined)throw Error('empty');
            if(nowMs()!==4294967300)throw Error('clock width');
            try{call('missing','[]');throw Error('missing rejection');}
            catch(e){if(e.code!==2||e.message!=='missing\0item')throw e;}
            const reply=await requestReply('async','[]');
            if(reply.value.text!=='团子\0os'||reply.bytes[1]!==255)throw Error('reply');
            if(await requestVoid('void','[]')!==undefined)throw Error('void');
            return 42;
        }
    "#);
    assert_eq!(vm.start("main", None).unwrap(), CallState::Pending);
    let Request::Host(request) = vm.take_request().unwrap() else {
        panic!()
    };
    vm.complete(
        request.id,
        Ok(HostReply {
            json: "{\"text\":\"团子\\u0000os\"}".into(),
            bytes: vec![0, 255],
        }),
    )
    .unwrap();
    vm.drain_jobs(32).unwrap();
    let Request::Host(request) = vm.take_request().unwrap() else {
        panic!()
    };
    vm.complete_void(request.id).unwrap();
    vm.drain_jobs(32).unwrap();
    assert_eq!(vm.entry_status().unwrap(), CallState::Done(42));
    assert_eq!(vm.profile().clocks, 1);
    assert_eq!(vm.close().used, 0);
}

#[test]
fn typed_delays_validate_numbers_preserve_units_and_reuse_the_single_slot() {
    let mut vm = vm(r#"
        import {sleep,delayUs} from 'dango:host';
        export async function main(){
            for(const value of [-1,0.5,NaN,Infinity,4294967296,'0']){
                const p=sleep(value);
                if(!(p instanceof Promise))throw Error('async validation');
                let rejected=false;try{await p}catch(e){rejected=e.code===258}
                if(!rejected)throw Error('delay range');
            }
            for(const value of [-1,0.5,NaN,Infinity,1000001]){
                let rejected=false;try{await delayUs(value)}catch(e){rejected=e.code===258}
                if(!rejected)throw Error('microsecond range');
            }
            await sleep(4294967295);
            await delayUs(1000000);
            for(let i=0;i<128;i++)await sleep(0);
            return 42;
        }
    "#);
    assert_eq!(vm.start("main", None).unwrap(), CallState::Pending);
    let mut delays = Vec::new();
    let mut done = false;
    for _ in 0..140 {
        vm.drain_jobs(32).unwrap();
        while let Some(request) = vm.take_request() {
            let Request::Delay { id, micros } = request else {
                panic!("typed request expected")
            };
            assert_eq!(vm.transport_bytes(), 8);
            delays.push(micros);
            vm.complete_void(id).unwrap();
        }
        if vm.entry_status().unwrap() == CallState::Done(42) {
            done = true;
            break;
        }
    }
    assert!(done);
    assert_eq!(&delays[..2], &[4_294_967_295_000, 1_000_000]);
    assert_eq!(delays.len(), 130);
    assert!(delays[2..].iter().all(|value| *value == 0));
    assert_eq!(vm.profile().delays, 130);
    assert_eq!(vm.profile().requests, 0);
    assert_eq!(vm.transport_bytes(), 0);
    let stats = vm.close();
    assert_eq!(stats.used, 0);
    assert_eq!(stats.failures, 0);
}

#[test]
fn typed_delay_capacity_and_stale_completion_remain_bounded() {
    let mut first=vm("import{sleep}from'dango:host';export async function main(){const a=sleep(0);try{await sleep(0);throw Error('capacity')}catch(e){if(e.code!==257)throw e}await a;return 42;}");
    first.start("main", None).unwrap();
    first.drain_jobs(32).unwrap();
    let Request::Delay { id, .. } = first.take_request().unwrap() else {
        panic!()
    };
    assert_eq!(first.close().used, 0);
    let mut second =
        vm("import{sleep}from'dango:host';export async function main(){await sleep(0);return 7;}");
    second.start("main", None).unwrap();
    assert!(second.complete_void(id).is_err());
    let Request::Delay { id, .. } = second.take_request().unwrap() else {
        panic!()
    };
    second.complete_void(id).unwrap();
    second.drain_jobs(32).unwrap();
    assert_eq!(second.entry_status().unwrap(), CallState::Done(7));
    assert_eq!(second.close().used, 0);
}
