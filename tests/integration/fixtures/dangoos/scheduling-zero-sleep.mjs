import{request}from'dango:host';export async function main(){for(let n=0;n<256;n++)await request('sleep','[0]');return 42;}
