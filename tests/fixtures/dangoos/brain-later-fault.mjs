import{call}from'dango:host';let n=0;export function main(){}export function onEvent(){if(n++)throw Error('later failure');call('brain.respond','[null]');}
