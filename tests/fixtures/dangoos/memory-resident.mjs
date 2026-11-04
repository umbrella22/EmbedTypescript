
import {emit} from 'dango:host';
export function main() {
    const live = [];
    for(let i=0;i<32;i++) live.push('x'.repeat(1024+i*31));
    emit(-1);
    for(let n=0;n<4096;n++) {
        const temporary = [];
        for(let i=0;i<64;i++) temporary.push('x'.repeat(32+(i*193+n*31)%4096));
        const objects=[];
        for(let i=0;i<128;i++) objects.push({x:i,y:n,text:temporary[i%64]});
        live[n%32] = 'x'.repeat(128+(n*97)%8192);
        if(objects[127].x!==127 || temporary.length!==64) throw new Error('churn');
        if(n%64===63)emit(n);
    }
    emit(4096);
    return 42;
}
