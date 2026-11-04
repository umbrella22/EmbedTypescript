#![cfg(feature = "compiler")]
use embedts_engine::{
    compile_module, workers::Group, CallState, Limits, Package, Vm, GLOBAL_ALLOCATOR,
};
#[test]
fn ready_work_distinguishes_worker_yields_from_real_waits() {
    let parent = compile_module("import{request}from'dango:host';export async function main(){await request('thread.run','[\"/w.etb\",null,{\"timeout_ms\":0}]');return 42;}").unwrap();
    let child = compile_module("import{sleep,delayUs,nowMs}from'dango:host';export async function main(){for(let i=0;i<7;i++)await sleep(0);await delayUs(0);if(nowMs()!==0)throw Error('worker clock');await delayUs(1000000);if(nowMs()!==1000)throw Error('worker timer');await sleep(9000);}").unwrap();
    let mut vm = Vm::new(Box::new(()), Limits::default(), &GLOBAL_ALLOCATOR).unwrap();
    unsafe { vm.load(Package::parse(&parent).unwrap()) }.unwrap();
    assert_eq!(vm.start("main", None).unwrap(), CallState::Pending);
    let mut group = Group::new(Limits::default(), &GLOBAL_ALLOCATOR);
    assert!(!group.has_ready_work(0));
    let mut request = take_host(&mut vm);
    request.bytes = child;
    group.command(request, 0);
    // Initial sleep request is already queued, before the first group poll.
    assert!(group.has_ready_work(0));
    for _ in 0..8 {
        group.poll_us(0);
        assert!(group.has_ready_work(0));
    }
    group.poll_us(0);
    assert!(group.active());
    assert!(!group.has_ready_work(0));
    assert!(!group.has_ready_work(999_999));
    assert!(group.has_ready_work(1_000_000));
    group.poll_us(1_000_000);
    assert!(group.active());
    assert!(!group.has_ready_work(9_999_999));
    assert!(group.has_ready_work(10_000_000));
    group.poll_us(10_000_000);
    // The parent completion is delivered on the following synchronization pass.
    group.poll_us(10_000_000);
    let (id, reply) = group.take_completion().unwrap();
    vm.complete(id, Ok(reply)).unwrap();
    vm.drain_jobs(32).unwrap();
    assert_eq!(vm.entry_status().unwrap(), CallState::Done(42));
    assert!(!group.has_ready_work(10_000_000));
    assert_eq!(vm.close().used, 0);
}
fn run(parent: &str, child: &str) -> i32 {
    let package = compile_module(parent).unwrap();
    let child = compile_module(child).unwrap();
    let mut vm = Vm::new(Box::new(()), Limits::default(), &GLOBAL_ALLOCATOR).unwrap();
    unsafe { vm.load(Package::parse(&package).unwrap()) }.unwrap();
    assert_eq!(vm.start("main", None).unwrap(), CallState::Pending);
    let mut group = Group::new(Limits::default(), &GLOBAL_ALLOCATOR);
    for now in 0..10000 {
        vm.drain_jobs(32).unwrap();
        while let Some(queued) = vm.take_request() {
            let mut r = match queued {
                embedts_engine::Request::Delay { id, .. } => {
                    vm.complete_void(id).unwrap();
                    continue;
                }
                embedts_engine::Request::Host(request) => request,
            };
            if matches!(r.operation.as_str(), "thread.start" | "thread.run") {
                r.bytes = child.clone();
            }
            group.command(r, now);
        }
        group.poll(now);
        while let Some((id, r)) = group.take_completion() {
            vm.complete(id, Ok(r)).unwrap();
        }
        match vm.entry_status().unwrap() {
            CallState::Done(n) => {
                drop(group);
                assert_eq!(vm.close().used, 0);
                return n;
            }
            CallState::Pending => {}
            other => panic!("{other:?}"),
        }
    }
    panic!("worker scenario failed to complete");
}
const HELPERS:&str="import{requestReply as request,call}from'dango:host';async function cmd(op,args=[],bytes){let r=await request('thread.'+op,JSON.stringify(args),bytes);return [r.value,r.bytes]}function yes(v){if(v[0].values[0]!==true)throw Error(JSON.stringify(v[0]))}";
#[test]
fn isolated_worker_passes_binary_queue_and_semaphore_while_parent_waits() {
    let p=format!("{HELPERS}export async function main(){{yes(await cmd('queue_create',['q',{{depth:1,item_size:3}}]));yes(await cmd('sem_create',['s',{{max:1}}]));yes(await cmd('start',['/w.etb',{{value:42}},{{name:'worker'}}]));yes(await cmd('sem_take',['s',1000]));let r=await cmd('queue_recv',['q',1000]);if(!r[0].binary||r[1].length!==3||r[1][0]!==0||r[1][1]!==255)throw Error('bytes');yes(await cmd('queue_delete',['q']));yes(await cmd('sem_delete',['s']));return 42;}}");
    let c=format!("{HELPERS}export async function main(){{if(call('args','[]').value!==42)throw Error('args');for(const op of ['hardware','services','storage_root','image.info']){{let denied=false;try{{call(op,'[]')}}catch(e){{denied=true}}if(!denied)throw Error('escape');}}let nested=await cmd('start',['/w.etb',null,{{}}]);if(nested[0].values[0]===true)throw Error('nested');yes(await cmd('queue_send',['q',100],new Uint8Array([0,255,0])));yes(await cmd('sem_give',['s']));}}");
    assert_eq!(run(&p, &c), 42);
}
#[test]
fn locks_release_on_worker_timeout_and_stop_and_waiter_deletion_is_busy() {
    let p=format!("{HELPERS}export async function main(){{yes(await cmd('lock_create',['l']));yes(await cmd('sem_create',['ready',{{}}]));yes(await cmd('queue_create',['q',{{}}]));yes(await cmd('start',['/w.etb',null,{{name:'one',timeout_ms:30}}]));yes(await cmd('sem_take',['ready',1000]));let no=await cmd('unlock',['l']);if(no[0].values[0]!==false||no[0].values[1]!=='not_owner')throw Error('ownership');let busy=await cmd('queue_delete',['q']);if(busy[0].values[1]!=='busy')throw Error('waiter deletion');yes(await cmd('lock',['l',1000]));yes(await cmd('unlock',['l']));let timed=await cmd('get',['one']);if(!timed[0].values[1].includes('status=timeout'))throw Error('deadline');yes(await cmd('start',['/w.etb',null,{{name:'two',timeout_ms:0}}]));yes(await cmd('sem_take',['ready',1000]));yes(await cmd('stop',['two']));yes(await cmd('lock',['l',0]));yes(await cmd('unlock',['l']));yes(await cmd('lock_delete',['l']));yes(await cmd('queue_delete',['q']));return 42;}}");
    let c=format!("{HELPERS}export async function main(){{yes(await cmd('lock',['l',1000]));yes(await cmd('sem_give',['ready']));await cmd('queue_recv',['q',10000]);}}");
    assert_eq!(run(&p, &c), 42);
}
#[test]
fn worker_faults_finish_run_without_losing_parent_and_replacements_obey_names() {
    let p=format!("{HELPERS}export async function main(){{let r=await cmd('run',['/w.etb',null,{{name:'fault'}}]);if(r[0].values[0]!==null||!r[0].values[1].includes('boom'))throw Error('fault receipt');yes(await cmd('queue_create',['q',{{depth:1,item_size:1}}]));let empty=await cmd('queue_recv',['q',0]);if(empty[0].values[1]!=='timeout')throw Error('nonblocking');yes(await cmd('queue_send',['q',0],new Uint8Array([0])));let full=await cmd('queue_send',['q',0],new Uint8Array([1]));if(full[0].values[0]!==false)throw Error('full');let conflict=await cmd('sem_create',['q',{{}}]);if(!conflict[0].error)throw Error('type conflict');return 42;}}");
    assert_eq!(run(&p, "export function main(){throw Error('boom')};"), 42);
}
#[test]
fn worker_capacity_replacement_history_and_queue_reservations_are_bounded() {
    let parent = format!(
        "{HELPERS}{}",
        r#"export async function main(){
  for(let i=0;i<8;i++)yes(await cmd('start',['/w.etb',null,{name:'w'+i,timeout_ms:0}]));
  if((await cmd('start',['/w.etb',null,{name:'ninth'}]))[0].values[0]===true)throw Error('worker capacity');
  if((await cmd('start',['/w.etb',null,{name:'w0'}]))[0].values[0]===true)throw Error('name conflict');
  yes(await cmd('start',['/w.etb',null,{name:'w0',replace:true,timeout_ms:0}]));
  let stopped=await cmd('list',['stopped']);if(!stopped[0].values[1].includes('name=w0 status=stopped'))throw Error('replacement');
  for(let i=0;i<8;i++)yes(await cmd('stop',['w'+i]));
  for(let i=0;i<40;i++){yes(await cmd('start',['/w.etb',null,{name:'history'+i,exclusive:'group',timeout_ms:0}]));yes(await cmd('stop',['history'+i]));}
  let old=await cmd('get',['history0']);if(old[0].values[0]===true)throw Error('unbounded history');yes(await cmd('get',['history39']));
  yes(await cmd('queue_create',['a',{depth:32,item_size:4096}]));yes(await cmd('queue_create',['b',{depth:32,item_size:4096}]));
  if((await cmd('queue_create',['c',{depth:1,item_size:1}]))[0].values[0]===true)throw Error('queue budget');
  yes(await cmd('queue_delete',['a']));yes(await cmd('queue_create',['c',{depth:1,item_size:1}]));return 42;
 }"#
    );
    assert_eq!(run(&parent,"import{request}from'dango:host';export async function main(){await request('sleep','[10000]')}"),42);
}

fn take_host(vm: &mut Vm) -> embedts_engine::HostRequest {
    match vm.take_request().unwrap() {
        embedts_engine::Request::Host(request) => request,
        other => panic!("expected host request, got {other:?}"),
    }
}
