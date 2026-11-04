-- Paired with ts/main.ts. A unit is bounded; a sample repeats many units.
local system = require("system")
local json = require("json")
local MOD = 1000000007

local function integer(unit)
    local state = unit + 1
    for _ = 1, 128 do state = (state * 48271) % 2147483647 end
    return state % MOD
end

local function mandelbrot(unit)
    local checksum = 0
    for pixel = 0, 1 do
        local index = (unit * 2 + pixel) % 16384
        local cx = (index % 128) * (3.5 / 127) - 2.5
        local cy = math.floor(index / 128) * (2.0 / 127) - 1.0
        local zr, zi, count = 0.0, 0.0, 0
        while count < 64 and zr * zr + zi * zi <= 4.0 do
            local next_r = zr * zr - zi * zi + cx
            zi = 2.0 * zr * zi + cy
            zr = next_r
            count = count + 1
        end
        checksum = checksum + count * (pixel * 64 + 1)
    end
    return checksum
end

local function primes(unit)
    local checksum = 0
    for offset = 0, 7 do
        local n = 10001 + (unit % 4096) * 16 + offset * 2
        local divisor, prime = 3, true
        while divisor * divisor <= n do
            if n % divisor == 0 then prime = false; break end
            divisor = divisor + 2
        end
        if prime then checksum = checksum + n end
    end
    return checksum
end

-- Setup is outside every timed sample. Powers of two make the reference exact.
local a, b = {}, {}
for i = 0, 143 do
    a[i + 1] = ((i * 17 + 3) % 101) / 32.0
    b[i + 1] = ((i * 29 + 7) % 103) / 16.0
end
local function matrix(unit)
    local row, checksum = unit % 12, 0.0
    for column = 0, 11 do
        local value = 0.0
        for k = 0, 11 do value = value + a[row * 12 + k + 1] * b[k * 12 + column + 1] end
        checksum = checksum + value * (column + 1)
    end
    return math.floor(checksum * 512.0)
end

local function sort(unit)
    local values, state = {}, unit + 1
    for i = 1, 32 do
        state = (state * 48271) % 2147483647
        values[i] = state % 65536
    end
    for i = 2, 32 do
        local value, j = values[i], i - 1
        while j >= 1 and values[j] > value do
            values[j + 1] = values[j]
            j = j - 1
        end
        values[j + 1] = value
    end
    local checksum = 0
    for i = 1, 32 do checksum = checksum + values[i] * i end
    return checksum
end

local function objects(unit)
    local particles = {}
    for i = 0, 15 do
        particles[i + 1] = {x = (unit + i) % 97, y = (unit * 3 + i) % 89,
                            vx = (i % 7) - 3, vy = (i % 5) - 2}
    end
    for _ = 1, 4 do
        for i = 1, 16 do
            local p = particles[i]
            particles[i] = {x = p.x + p.vx, y = p.y + p.vy, vx = p.vx, vy = p.vy}
        end
    end
    local checksum = 0
    for i = 1, 16 do
        local p = particles[i]
        checksum = checksum + (p.x + 128) * (p.y + 128) * i
    end
    return checksum
end

local event_id = 0
local function emit(value)
    local encoded = json.encode(value)
    event_id = event_id + 1
    local total = math.ceil(#encoded / 64)
    for part = 1, total do
        print("DANGO_BENCH_PART " .. event_id .. "/" .. part .. "/" .. total .. " " ..
              string.sub(encoded, (part - 1) * 64 + 1, part * 64))
    end
end
local function number(value, low, high)
    assert(type(value) == "number" and value == math.floor(value) and value >= low and value <= high,
           "invalid benchmark number")
    return value
end
local function text(value)
    assert(type(value) == "string" and #value > 0, "missing benchmark identity")
    return value
end
assert(type(args) == "table" and args.suite == "script-engines-v1", "build the benchmark payload first")
local profile, fingerprint, run_id = text(args.profile), text(args.fingerprint), text(args.run_id)
local samples = number(args.samples, 1, 9)
local yield_every = number(args.yield_every, 1, 32)
assert(type(args.units) == "table" and #args.units == 6 and type(args.expected) == "table" and #args.expected == 6,
       "six workloads required")
local names = {"integer", "mandelbrot", "primes", "matrix", "sort", "objects"}
local kernels = {integer, mandelbrot, primes, matrix, sort, objects}
for i = 1, 6 do number(args.units[i], 1, 1000000); number(args.expected[i], 0, MOD - 1) end
emit({event = "start", engine = "lua", suite = args.suite, profile = profile, fingerprint = fingerprint,
      run_id = run_id, samples = samples, warmup = 1, yield_every = yield_every, units = args.units})
for i = 1, 6 do
    local kernel, count, target, name = kernels[i], args.units[i], args.expected[i], names[i]
    for sample = -1, samples - 1 do
        if sample >= 0 then emit({event = "begin", case = name, sample = sample, units = count}) end
        local started, checksum = system.millis(), 0
        for unit = 0, count - 1 do
            checksum = (checksum + kernel(unit)) % MOD
            -- delay_ms(0) is a no-op in this runtime; yield explicitly.
            if (unit + 1) % yield_every == 0 then coroutine.yield() end
        end
        local elapsed = system.millis() - started
        assert(checksum == target, "checksum mismatch: " .. name)
        emit({event = sample < 0 and "warmup" or "sample", case = name, sample = sample,
              units = count, checksum = checksum, elapsed_ms = elapsed})
    end
end
emit({event = "done", samples = samples * 6})
