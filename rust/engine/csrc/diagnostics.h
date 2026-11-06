/* Internal diagnostic ABI: all fields are uint64_t on every target. */
#ifndef EMBEDTS_DIAGNOSTICS_H
#define EMBEDTS_DIAGNOSTICS_H
#include <stdint.h>
typedef struct {
    uint64_t opcodes[256];
    uint64_t dispatches;
    uint64_t compare_branches;
    uint64_t local_load_pairs;
    uint64_t multiply_remainders;
    uint64_t arithmetic_stores;
    uint64_t nullish_branches;
    uint64_t malloc_calls;
    uint64_t calloc_calls;
    uint64_t realloc_calls;
    uint64_t free_calls;
} EmbedTsInterpreterDiagnostics;
#endif
