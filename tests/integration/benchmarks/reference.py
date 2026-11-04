"""Independent exact/checksum references; never used inside a timed VM."""
import functools
import math

MOD = 1000000007
CASES = ("integer", "mandelbrot", "primes", "matrix", "sort", "objects")


@functools.lru_cache(maxsize=None)
def expected(case: str, units: int) -> int:
    if case == "integer":
        jump = pow(48271, 128, 2147483647)
        return sum(((unit + 1) * jump) % 2147483647 % MOD for unit in range(units)) % MOD
    if case == "mandelbrot":
        counts = []
        for index in range(16384):
            c = complex((index % 128) * (3.5 / 127) - 2.5, (index // 128) * (2.0 / 127) - 1.0)
            z, count = 0j, 0
            while count < 64 and z.real * z.real + z.imag * z.imag <= 4.0:
                z = z * z + c
                count += 1
            counts.append(count)
        return sum(counts[(u * 2) % 16384] + 65 * counts[(u * 2 + 1) % 16384] for u in range(units)) % MOD
    if case == "primes":
        # The VM uses trial division; the reference uses Eratosthenes.
        limit = 75535
        sieve = bytearray([1]) * (limit + 1)
        sieve[0:2] = b"\0\0"
        for p in range(2, math.isqrt(limit) + 1):
            if sieve[p]:
                sieve[p * p::p] = b"\0" * ((limit - p * p) // p + 1)
        return sum(n for u in range(units) for n in range(10001 + (u % 4096) * 16, 10017 + (u % 4096) * 16, 2) if sieve[n]) % MOD
    if case == "matrix":
        # Integer numerators prove the floating-point /512 checksum exactly.
        rows = [sum(sum(((r * 12 + k) * 17 + 3) % 101 * (((k * 12 + c) * 29 + 7) % 103)
                        for k in range(12)) * (c + 1) for c in range(12)) for r in range(12)]
        return sum(rows[u % 12] for u in range(units)) % MOD
    if case == "sort":
        total = 0
        for u in range(units):
            state, values = u + 1, []
            for _ in range(32):
                state = state * 48271 % 2147483647
                values.append(state % 65536)
            total += sum(i * value for i, value in enumerate(sorted(values), 1))
        return total % MOD
    if case == "objects":
        # Closed form of four integration steps, without creating particles.
        return sum(((u + i) % 97 + 4 * (i % 7 - 3) + 128) *
                   ((u * 3 + i) % 89 + 4 * (i % 5 - 2) + 128) * (i + 1)
                   for u in range(units) for i in range(16)) % MOD
    raise ValueError(f"unknown workload: {case}")
