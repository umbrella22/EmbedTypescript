struct Printer;
impl embedts_engine::Host for Printer {
    fn emit(&mut self, value: i32) -> Result<(), embedts_engine::Error> {
        println!("emit={value}");
        Ok(())
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("usage: run INPUT.etb")?;
    let bytes = std::fs::read(path)?;
    let package = embedts_engine::Package::parse(&bytes)?;
    let mut vm = embedts_engine::Vm::new(
        Box::new(Printer),
        Default::default(),
        &embedts_engine::GLOBAL_ALLOCATOR,
    )?;
    // This development runner accepts artifacts from the local trusted compiler.
    unsafe {
        vm.load(package)?;
    }
    println!("main={:?}", vm.call("main", None)?);
    println!("jobs={:?}", vm.drain_jobs(64)?);
    println!("memory={:?}", vm.close());
    Ok(())
}
