// UTC worker calendar formatting, using the embedding C library.
#include <stdint.h>
#include <stddef.h>
#include <time.h>
size_t embedts_format_date(int64_t seconds, const char *format, char *out, size_t cap) {
    time_t at = (time_t)seconds;
    struct tm fields;
    if (!gmtime_r(&at, &fields)) return 0;
    return strftime(out, cap, format, &fields);
}
