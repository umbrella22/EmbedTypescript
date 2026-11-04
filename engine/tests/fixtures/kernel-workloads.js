export function integer(n) {
    let state = 1;
    for (let i = 0; i < n; i++) state = (state * 48271) % 2147483647;
    return state;
}

export function remainder(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const value = 4503599627370496 + (i & 1023);
        sum = (sum + value % 1000000007) % 1000000007;
    }
    return sum;
}

export function signed(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum = (sum + (-i % 997)) | 0;
    return sum;
}

export async function settled(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += await Promise.resolve(i);
    return sum;
}

export async function pending(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += await new Promise(resolve => {
            Promise.resolve().then(() => resolve(i));
        });
    }
    return sum;
}

export async function chain(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += await Promise.resolve(i).then(x => x + 1);
    return sum;
}
