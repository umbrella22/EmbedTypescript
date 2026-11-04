import{request,call}from'dango:host';export function main(){const a=call('args','[]');request(a.operation,a.args,new Uint8Array(a.bytes)).catch(()=>{});}
