/* Included after QuickJS's runtime and opcode definitions in diagnostic builds. */
static const uint8_t embedts_opcode_sizes[256] = {
#define DEF(id, size, n_pop, n_push, f) size,
#define def(id, size, n_pop, n_push, f)
#include "quickjs-opcode.h"
};

const char *embedts_qjs_opcode_name(unsigned opcode)
{
    static const char *const names[] = {
#define DEF(id, size, n_pop, n_push, f) #id,
#define def(id, size, n_pop, n_push, f)
#include "quickjs-opcode.h"
    };
    return opcode < OP_COUNT ? names[opcode] : NULL;
}

void embedts_qjs_diagnostics(JSRuntime *rt, EmbedTsInterpreterDiagnostics *out,
                            int reset)
{
    *out = rt->embedts_diagnostics;
    if (reset)
        memset(&rt->embedts_diagnostics, 0, sizeof(rt->embedts_diagnostics));
}

static bool embedts_is_local_load(unsigned op)
{
    return op == OP_get_loc || op == OP_get_loc8 ||
        (op >= OP_get_loc0 && op <= OP_get_loc3);
}

static bool embedts_is_local_store(unsigned op)
{
    return op == OP_put_loc || op == OP_put_loc8 ||
        (op >= OP_put_loc0 && op <= OP_put_loc3);
}

static void embedts_note_opcode(JSRuntime *rt, const uint8_t *pc,
                               const uint8_t *end, int dispatched)
{
    EmbedTsInterpreterDiagnostics *d = &rt->embedts_diagnostics;
    unsigned op = *pc, size = embedts_opcode_sizes[op], next;
    d->opcodes[op]++;
    d->dispatches += dispatched;
    /* These are adjacent candidate sequences, including throwing operations.
     * A candidate's second instruction need not actually execute. */
    if (!size || end - pc <= size)
        return;
    next = pc[size];
    if (((op >= OP_lt && op <= OP_gte) ||
         (op >= OP_eq && op <= OP_strict_neq)) &&
        (next == OP_if_true || next == OP_if_false ||
         next == OP_if_true8 || next == OP_if_false8))
        d->compare_branches++;
    if (embedts_is_local_load(op) && embedts_is_local_load(next))
        d->local_load_pairs++;
    if (op == OP_mul && next == OP_mod)
        d->multiply_remainders++;
    if (op >= OP_mul && op <= OP_pow && embedts_is_local_store(next))
        d->arithmetic_stores++;
    if (op == OP_dup && next == OP_is_undefined_or_null && end - pc > 2 &&
        (pc[2] == OP_if_true || pc[2] == OP_if_false ||
         pc[2] == OP_if_true8 || pc[2] == OP_if_false8))
        d->nullish_branches++;
}
