/* JSValue lifetimes stay inside this bridge. Rust sees opaque runtimes and
 * copied scalar values, never QuickJS's architecture-dependent value layout. */
#include "quickjs.h"
#include <stdlib.h>
#include <string.h>

extern void *embedts_alloc(void *, size_t);
extern void *embedts_calloc(void *, size_t, size_t);
extern void *embedts_realloc(void *, void *, size_t);
extern void embedts_free(void *, void *);
extern size_t embedts_allocation_size(const void *);
extern int embedts_interrupt(JSContext *, void *);
extern int embedts_emit(void *, int32_t);

typedef struct Rejection {
    struct Rejection *next;
    JSValue promise, reason;
} Rejection;
typedef struct Waiter {
    struct Waiter *next;
    uint64_t id;
    JSValue resolve, reject;
    int mode;
} Waiter;
typedef struct { const uint8_t *json; size_t json_len; const uint8_t *bytes; size_t bytes_len; } ReplyView;
extern int embedts_host_call(void *, const uint8_t *, size_t, const uint8_t *, size_t, const uint8_t *, size_t, uint32_t, ReplyView *);
extern int embedts_host_request(void *, const uint8_t *, size_t, const uint8_t *, size_t, const uint8_t *, size_t, uint32_t, uint64_t *);
extern int embedts_host_delay(void *, uint64_t, uint64_t *);
extern int embedts_host_now_ms(void *, uint64_t *, ReplyView *);
typedef struct { int32_t operation, coordinates[6]; uint32_t color; double start, end; } Draw;
extern int embedts_host_draw(void *, const Draw *, ReplyView *);
typedef struct {
    JSRuntime *rt;
    JSContext *ctx;
    JSValue module;
    JSValue namespace;
    Rejection *rejections;
    Waiter *waiters;
    Waiter *slots, *available;
    JSValue entry;
} DangoTs;

static void track_rejection(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool handled, void *opaque) {
    DangoTs *vm = opaque;
    Rejection **item = &vm->rejections;
    while (*item && !JS_IsStrictEqual(ctx, (*item)->promise, promise)) item = &(*item)->next;
    if (handled) {
        if (*item) {
            Rejection *removed = *item;
            *item = removed->next;
            JS_FreeValue(ctx, removed->promise); JS_FreeValue(ctx, removed->reason);
            embedts_free(JS_GetRuntimeOpaque(vm->rt), removed);
        }
    } else if (!*item) {
        Rejection *added = embedts_alloc(JS_GetRuntimeOpaque(vm->rt), sizeof(*added));
        // The fallible allocator records OOM in Rust, which faults this call.
        if (!added) return;
        added->promise = JS_DupValue(ctx, promise);
        added->reason = JS_DupValue(ctx, reason);
        added->next = NULL;
        *item = added;
    }
}

static JSValue emit(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    double number;
    if (argc != 1 || !JS_IsNumber(argv[0]) || JS_ToFloat64(ctx, &number, argv[0])
        || !isfinite(number) || number < INT32_MIN || number > INT32_MAX || number != (int32_t)number)
        return JS_ThrowTypeError(ctx, "emit expects one int32");
    if (embedts_emit(JS_GetRuntimeOpaque(JS_GetRuntime(ctx)), (int32_t)number))
        return JS_ThrowInternalError(ctx, "host emit failed");
    return JS_UNDEFINED;
}
enum { REPLY_JSON, REPLY_BYTES, REPLY_BOTH, REPLY_VOID, ASYNC = 4 };
static JSValue reply_value(JSContext *ctx, int code, const ReplyView *reply, int mode) {
    if (!code) {
        if (mode == REPLY_VOID) return JS_UNDEFINED;
        if (mode == REPLY_BYTES)
            return JS_NewUint8ArrayCopy(ctx, reply->bytes, reply->bytes_len);
        JSValue json = JS_ParseJSON(ctx, (const char *)reply->json, reply->json_len, "<host>");
        if (JS_IsException(json) || mode == REPLY_JSON) return json;
        JSValue value = JS_NewObject(ctx);
        if (JS_IsException(value)) { JS_FreeValue(ctx, json); return value; }
        if (JS_SetPropertyStr(ctx, value, "value", json) < 0) { JS_FreeValue(ctx,value); return JS_EXCEPTION; }
        JSValue data = JS_NewUint8ArrayCopy(ctx, reply->bytes, reply->bytes_len);
        if (JS_IsException(data) || JS_SetPropertyStr(ctx,value,"bytes",data) < 0) {
            JS_FreeValue(ctx,value); return JS_EXCEPTION;
        }
        return value;
    }
    JSValue value = JS_NewError(ctx);
    if (JS_IsException(value)) return value;
    JSValue text = JS_NewStringLen(ctx, (const char *)reply->json, reply->json_len);
    if (JS_IsException(text)) goto fail;
    if (JS_SetPropertyStr(ctx, value, "message", text) < 0) goto fail;
    JSValue data = JS_NewInt32(ctx, code);
    if (JS_IsException(data)) goto fail;
    if (JS_SetPropertyStr(ctx, value, "code", data) < 0) goto fail;
    return value;
fail:
    JS_FreeValue(ctx, value);
    return JS_EXCEPTION;
}
static void release_waiter(DangoTs *vm, Waiter *waiter) {
    JS_FreeValue(vm->ctx, waiter->resolve); JS_FreeValue(vm->ctx, waiter->reject);
    waiter->resolve = JS_UNDEFINED; waiter->reject = JS_UNDEFINED;
    waiter->next = vm->available; vm->available = waiter;
}
static JSValue request_promise(JSContext *ctx, int mode, const uint8_t *op, size_t op_len,
    const uint8_t *args, size_t args_len, const uint8_t *bytes, size_t size,
    int delay, uint64_t micros, int invalid) {
    DangoTs *vm = JS_GetContextOpaque(ctx);
    void *opaque = JS_GetRuntimeOpaque(vm->rt);
    JSValue functions[2];
    JSValue promise = JS_NewPromiseCapability(ctx, functions);
    if (JS_IsException(promise)) return promise;
    Waiter *waiter = vm->available;
    int code = invalid ? 0x102 : waiter ? 0 : 0x101;
    int reserved = 0;
    if (!code) {
        vm->available = waiter->next;
        reserved = 1;
        waiter->resolve = functions[0]; waiter->reject = functions[1]; waiter->mode = mode;
        code = delay ? embedts_host_delay(opaque,micros,&waiter->id)
            : embedts_host_request(opaque,op,op_len,args,args_len,bytes,size,(uint32_t)mode,&waiter->id);
        if (!code) {
            waiter->next = vm->waiters; vm->waiters = waiter;
            return promise;
        }
    }
    const char *message = invalid ? "delay must be a finite integer in range"
        : "host request rejected (queue, bytes or text encoding)";
    ReplyView reply = { (const uint8_t *)message, strlen(message), NULL, 0 };
    JSValue error = reply_value(ctx,code,&reply,REPLY_VOID);
    JSValue settled = JS_IsException(error) ? JS_EXCEPTION : JS_Call(ctx,functions[1],JS_UNDEFINED,1,&error);
    JS_FreeValue(ctx,error);
    int failed = JS_IsException(settled);
    JS_FreeValue(ctx,settled);
    if (reserved) release_waiter(vm,waiter);
    else { JS_FreeValue(ctx,functions[0]); JS_FreeValue(ctx,functions[1]); }
    if (failed) { JS_FreeValue(ctx,promise); return JS_EXCEPTION; }
    return promise;
}
static int exact_u32(JSContext *ctx, JSValueConst value, uint32_t *out) {
    if (JS_VALUE_GET_TAG(value) == JS_TAG_INT) {
        int32_t n = JS_VALUE_GET_INT(value);
        if (n < 0) return -1;
        *out = (uint32_t)n; return 0;
    }
    double n;
    if (!JS_IsNumber(value) || JS_ToFloat64(ctx,&n,value) || !isfinite(n)
        || n < 0 || n > 4294967295.0 || n != (uint32_t)n) return -1;
    *out = (uint32_t)n; return 0;
}
static int exact_i32(JSContext *ctx, JSValueConst value, int32_t *out) {
    if (JS_VALUE_GET_TAG(value) == JS_TAG_INT) { *out = JS_VALUE_GET_INT(value); return 0; }
    double n;
    if (!JS_IsNumber(value) || JS_ToFloat64(ctx,&n,value) || !isfinite(n)
        || n < INT32_MIN || n > INT32_MAX || n != (int32_t)n) return -1;
    *out = (int32_t)n; return 0;
}
static JSValue host_delay(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int microseconds) {
    uint32_t number = 0;
    int invalid = argc != 1 || exact_u32(ctx,argv[0],&number)
        || (microseconds && number > 1000000);
    uint64_t micros = invalid ? 0 : (uint64_t)number * (microseconds ? 1 : 1000);
    return request_promise(ctx,REPLY_VOID,NULL,0,NULL,0,NULL,0,1,micros,invalid);
}
static JSValue host_draw(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    Draw draw;
    int invalid = argc != 10;
    if (!invalid) {
        invalid = exact_i32(ctx,argv[0],&draw.operation) || exact_u32(ctx,argv[7],&draw.color);
        for (int i = 0; i < 6 && !invalid; i++) invalid = exact_i32(ctx,argv[i+1],&draw.coordinates[i]);
        for (int i = 8; i < 10 && !invalid; i++) {
            double n;
            invalid = !JS_IsNumber(argv[i]) || JS_ToFloat64(ctx,&n,argv[i]) || !isfinite(n);
            if (!invalid) { if (i == 8) draw.start = n; else draw.end = n; }
        }
    }
    ReplyView reply;
    int code;
    if (invalid) {
        const char *message = "draw expects int32 operation/coordinates, uint32 color and finite angles";
        reply = (ReplyView){ (const uint8_t *)message, strlen(message), NULL, 0 };
        code = 0x102;
    } else code = embedts_host_draw(JS_GetRuntimeOpaque(JS_GetRuntime(ctx)),&draw,&reply);
    if (!code) return JS_UNDEFINED;
    JSValue error = reply_value(ctx,code,&reply,REPLY_VOID);
    return JS_IsException(error) ? error : JS_Throw(ctx,error);
}
static JSValue host_now(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    uint64_t value = 0;
    ReplyView reply;
    int code = embedts_host_now_ms(JS_GetRuntimeOpaque(JS_GetRuntime(ctx)),&value,&reply);
    if (!code) return JS_NewNumber(ctx,(double)value);
    JSValue error = reply_value(ctx,code,&reply,REPLY_VOID);
    return JS_IsException(error) ? error : JS_Throw(ctx,error);
}
static JSValue host_call(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic) {
    if (argc < 2 || argc > 3 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(ctx, "host call expects operation, JSON and optional Uint8Array");
    JSValue buffer = JS_UNDEFINED;
    size_t offset = 0, size = 0, element = 0, capacity = 0;
    uint8_t *bytes = NULL;
    if (argc == 3 && !JS_IsUndefined(argv[2])) {
        if (JS_GetTypedArrayType(argv[2]) != JS_TYPED_ARRAY_UINT8)
            return JS_ThrowTypeError(ctx, "host bytes must be Uint8Array");
        buffer = JS_GetTypedArrayBuffer(ctx, argv[2], &offset, &size, &element);
        if (JS_IsException(buffer)) return JS_EXCEPTION;
        bytes = JS_GetArrayBuffer(ctx, &capacity, buffer);
        if (!bytes && JS_HasException(ctx)) {JS_FreeValue(ctx,buffer); return JS_EXCEPTION;}
        if (offset > capacity || size > capacity-offset) {
            JS_FreeValue(ctx, buffer); return JS_ThrowTypeError(ctx, "invalid byte view");
        }
        if (bytes) bytes += offset;
    }
    size_t op_len, args_len;
    const char *op = JS_ToCStringLen(ctx, &op_len, argv[0]);
    const char *args = JS_ToCStringLen(ctx, &args_len, argv[1]);
    if (!op || !args) {
        if (op) JS_FreeCString(ctx, op); if (args) JS_FreeCString(ctx,args);
        JS_FreeValue(ctx,buffer); return JS_EXCEPTION;
    }
    void *opaque = JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    JSValue result;
    int mode = magic & 3;
    if (magic & ASYNC) {
        result = request_promise(ctx,mode,(const uint8_t *)op,op_len,(const uint8_t *)args,args_len,bytes,size,0,0,0);
    } else {
        ReplyView reply;
        int code = embedts_host_call(opaque, (const uint8_t *)op, op_len, (const uint8_t *)args, args_len, bytes, size, (uint32_t)mode, &reply);
        result = reply_value(ctx, code, &reply, mode);
        if (code && !JS_IsException(result)) result = JS_Throw(ctx,result);
    }
    JS_FreeCString(ctx,op); JS_FreeCString(ctx,args); JS_FreeValue(ctx,buffer);
    return result;
}
static const JSCFunctionListEntry host_exports[] = {
    JS_CFUNC_DEF("emit",1,emit),
    JS_CFUNC_DEF("nowMs",0,host_now),
    JS_CFUNC_DEF("draw",10,host_draw),
    JS_CFUNC_MAGIC_DEF("sleep",1,host_delay,0),
    JS_CFUNC_MAGIC_DEF("delayUs",1,host_delay,1),
    JS_CFUNC_MAGIC_DEF("call",3,host_call,REPLY_JSON),
    JS_CFUNC_MAGIC_DEF("callBytes",3,host_call,REPLY_BYTES),
    JS_CFUNC_MAGIC_DEF("callVoid",3,host_call,REPLY_VOID),
    JS_CFUNC_MAGIC_DEF("request",3,host_call,ASYNC|REPLY_JSON),
    JS_CFUNC_MAGIC_DEF("requestBytes",3,host_call,ASYNC|REPLY_BYTES),
    JS_CFUNC_MAGIC_DEF("requestReply",3,host_call,ASYNC|REPLY_BOTH),
    JS_CFUNC_MAGIC_DEF("requestVoid",3,host_call,ASYNC|REPLY_VOID),
};
static int host_init(JSContext *ctx, JSModuleDef *module) {
    return JS_SetModuleExportList(ctx,module,host_exports,sizeof(host_exports)/sizeof(*host_exports));
}
static JSModuleDef *load_module(JSContext *ctx, const char *name, void *opaque) {
    if (strcmp(name, "dango:host")) {
        JS_ThrowReferenceError(ctx, "unsupported native module: %s", name);
        return NULL;
    }
    JSModuleDef *m = JS_NewCModule(ctx, name, host_init);
    if (!m || JS_AddModuleExportList(ctx,m,host_exports,sizeof(host_exports)/sizeof(*host_exports))) return NULL;
    return m;
}
static void error_text(JSContext *ctx, char *out, size_t cap) {
    JSValue ex = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, ex);
    if (cap) {
        const char *text = message ? message : "QuickJS exception";
        size_t n = strlen(text);
        if (n >= cap) n = cap-1;
        memcpy(out, text, n); out[n] = 0;
    }
    if (message) JS_FreeCString(ctx, message);
    JS_FreeValue(ctx, ex);
}
void embedts_destroy(DangoTs *vm) {
    if (!vm) return;
    JS_SetHostPromiseRejectionTracker(vm->rt, NULL, NULL);
    while (vm->rejections) {
        Rejection *item = vm->rejections;
        vm->rejections = item->next;
        JS_FreeValue(vm->ctx, item->promise); JS_FreeValue(vm->ctx, item->reason);
        embedts_free(JS_GetRuntimeOpaque(vm->rt), item);
    }
    while (vm->waiters) {
        Waiter *item = vm->waiters; vm->waiters = item->next;
        JS_FreeValue(vm->ctx,item->resolve); JS_FreeValue(vm->ctx,item->reject);
    }
    embedts_free(JS_GetRuntimeOpaque(vm->rt),vm->slots);
    JS_FreeValue(vm->ctx,vm->entry);
    JS_FreeValue(vm->ctx, vm->namespace);
    JS_FreeValue(vm->ctx, vm->module);
    JS_FreeContext(vm->ctx);
    JS_FreeRuntime(vm->rt);
    /* The wrapper uses the same fallible allocator as the engine. */
}
DangoTs *embedts_create(void *opaque, size_t stack, size_t pending) {
    JSMallocFunctions mf = { embedts_calloc, embedts_alloc, embedts_free,
        embedts_realloc, embedts_allocation_size };
    DangoTs *vm = embedts_calloc(opaque, 1, sizeof(*vm));
    if (!vm) return NULL;
    vm->module = JS_UNDEFINED; vm->namespace = JS_UNDEFINED; vm->entry = JS_UNDEFINED;
    vm->rt = JS_NewRuntime2(&mf, opaque);
    if (!vm->rt) { embedts_free(opaque,vm); return NULL; }
    JS_SetRuntimeOpaque(vm->rt,opaque);
    /* The backing allocator enforces the limit, including arena/header bytes.
     * An additional QuickJS limit could reject before recording terminal OOM. */
    JS_SetMaxStackSize(vm->rt,stack);
    JS_SetInterruptHandler(vm->rt,embedts_interrupt,opaque);
    JS_SetModuleLoaderFunc(vm->rt,NULL,load_module,NULL);
    vm->ctx = JS_NewContextRaw(vm->rt);
    if (!vm->ctx) { JS_FreeRuntime(vm->rt); embedts_free(opaque,vm); return NULL; }
    JS_SetContextOpaque(vm->ctx,vm);
    vm->slots = embedts_calloc(opaque,pending,sizeof(*vm->slots));
    if (!vm->slots) { embedts_destroy(vm); embedts_free(opaque,vm); return NULL; }
    for (size_t i = 0; i < pending; i++) {
        Waiter *slot = &vm->slots[i];
        slot->resolve = JS_UNDEFINED; slot->reject = JS_UNDEFINED;
        slot->next = vm->available; vm->available = slot;
    }
    if (JS_AddIntrinsicBaseObjects(vm->ctx) || JS_AddIntrinsicJSON(vm->ctx)
        || JS_AddIntrinsicMapSet(vm->ctx) || JS_AddIntrinsicTypedArrays(vm->ctx)
        || JS_AddIntrinsicPromise(vm->ctx)) {
        embedts_destroy(vm); embedts_free(opaque,vm); return NULL;
    }
    JS_SetHostPromiseRejectionTracker(vm->rt, track_rejection, vm);
    return vm;
}
void embedts_drop(DangoTs *vm) {
    void *opaque = JS_GetRuntimeOpaque(vm->rt);
    embedts_destroy(vm);
    embedts_free(opaque,vm);
}
int embedts_load(DangoTs *vm, const uint8_t *bytes, size_t len, char *error, size_t cap) {
    JSValue obj = JS_ReadObject(vm->ctx,bytes,len,JS_READ_OBJ_BYTECODE);
    if (JS_IsException(obj)) goto fail;
    if (JS_VALUE_GET_TAG(obj) != JS_TAG_MODULE) {
        JS_FreeValue(vm->ctx,obj);
        JS_ThrowTypeError(vm->ctx,"entry bytecode must be an ES module"); goto fail;
    }
    if (JS_ResolveModule(vm->ctx,obj)) { JS_FreeValue(vm->ctx,obj); goto fail; }
    vm->module = JS_DupValue(vm->ctx,obj);
    JSValue result = JS_EvalFunction(vm->ctx,obj); /* consumes obj */
    if (JS_IsException(result)) goto fail;
    if (JS_IsPromise(result) && JS_PromiseState(vm->ctx,result) != JS_PROMISE_FULFILLED) {
        JS_FreeValue(vm->ctx,result);
        JS_ThrowTypeError(vm->ctx,"asynchronous module initialization is unsupported"); goto fail;
    }
    JS_FreeValue(vm->ctx,result);
    vm->namespace = JS_GetModuleNamespace(vm->ctx,JS_VALUE_GET_PTR(vm->module));
    if (JS_IsException(vm->namespace)) { vm->namespace = JS_UNDEFINED; goto fail; }
    return 0;
fail: error_text(vm->ctx,error,cap); return -1;
}
static int scalar_result(JSContext *ctx, JSValue result, int32_t *out) {
    if (JS_IsUndefined(result)) *out = 0;
    else {
        double number;
        if (!JS_IsNumber(result) || JS_ToFloat64(ctx,&number,result) || !isfinite(number)
            || number < INT32_MIN || number > INT32_MAX || number != (int32_t)number) {
            JS_ThrowTypeError(ctx,"entry must return void or int32"); return -1;
        }
        *out = (int32_t)number;
    }
    return 0;
}
static int invoke(DangoTs *vm,const char *name,int has_arg,int32_t arg,int32_t *out,char *error,size_t cap,int asynchronous) {
    if (!JS_IsUndefined(vm->entry)) { JS_ThrowTypeError(vm->ctx,"an entry is already pending"); goto fail; }
    JSValue fn = JS_GetPropertyStr(vm->ctx,vm->namespace,name);
    if (JS_IsException(fn)) goto fail;
    if (JS_IsUndefined(fn)) { JS_FreeValue(vm->ctx,fn); return 1; }
    if (!JS_IsFunction(vm->ctx,fn)) { JS_FreeValue(vm->ctx,fn); JS_ThrowTypeError(vm->ctx,"export is not callable"); goto fail; }
    JSValue input = JS_NewInt32(vm->ctx,arg);
    JSValue result = JS_Call(vm->ctx,fn,JS_UNDEFINED,has_arg,&input);
    JS_FreeValue(vm->ctx,fn);
    if (JS_IsException(result)) goto fail;
    if (asynchronous && JS_IsPromise(result)) {
        vm->entry = result;
        JS_PromiseMarkAsHandled(vm->ctx,result);
        return 2;
    }
    int status = scalar_result(vm->ctx,result,out);
    JS_FreeValue(vm->ctx,result);
    if (status < 0) goto fail;
    return 0;
fail: error_text(vm->ctx,error,cap); return -1;
}
int embedts_call(DangoTs *vm,const char *name,int has_arg,int32_t arg,int32_t *out,char *error,size_t cap) {
    return invoke(vm,name,has_arg,arg,out,error,cap,0);
}
int embedts_start(DangoTs *vm,const char *name,int has_arg,int32_t arg,int32_t *out,char *error,size_t cap) {
    return invoke(vm,name,has_arg,arg,out,error,cap,1);
}
int embedts_entry(DangoTs *vm,int32_t *out,char *error,size_t cap) {
    if (JS_IsUndefined(vm->entry)) return 1;
    int state = JS_PromiseState(vm->ctx,vm->entry);
    if (state == JS_PROMISE_PENDING) return 2;
    JSValue result = JS_PromiseResult(vm->ctx,vm->entry);
    JS_FreeValue(vm->ctx,vm->entry); vm->entry = JS_UNDEFINED;
    if (state == JS_PROMISE_REJECTED) {
        JS_Throw(vm->ctx,result); error_text(vm->ctx,error,cap); return -1;
    }
    int status = scalar_result(vm->ctx,result,out);
    JS_FreeValue(vm->ctx,result);
    if (status < 0) error_text(vm->ctx,error,cap);
    return status;
}
int embedts_complete(DangoTs *vm,uint64_t id,int code,const ReplyView *reply,char *error,size_t cap) {
    Waiter **item = &vm->waiters;
    while (*item && (*item)->id != id) item = &(*item)->next;
    if (!*item) { JS_ThrowTypeError(vm->ctx,"unknown host completion"); goto fail; }
    Waiter *waiter = *item; *item = waiter->next;
    JSValue value = reply_value(vm->ctx,code,reply,waiter->mode);
    JSValue settled = JS_IsException(value) ? JS_EXCEPTION
        : JS_Call(vm->ctx,code ? waiter->reject : waiter->resolve,JS_UNDEFINED,1,&value);
    JS_FreeValue(vm->ctx,value);
    release_waiter(vm,waiter);
    if (JS_IsException(settled)) goto fail;
    JS_FreeValue(vm->ctx,settled);
    return 0;
fail: error_text(vm->ctx,error,cap); return -1;
}
int embedts_job(DangoTs *vm,char *error,size_t cap) {
    JSContext *ctx = NULL;
    int result = JS_ExecutePendingJob(vm->rt,&ctx);
    if (result < 0) error_text(ctx ? ctx : vm->ctx,error,cap);
    return result;
}
int embedts_pending(DangoTs *vm) { return JS_IsJobPending(vm->rt); }
/* Rejection reporting occurs after a pump exhausts the queue, allowing handlers
 * attached by jobs in that queue to run before the unhandled checkpoint. */
int embedts_rejections(DangoTs *vm, char *error, size_t cap) {
    if (!vm->rejections) return 0;
    JS_Throw(vm->ctx, JS_DupValue(vm->ctx, vm->rejections->reason));
    error_text(vm->ctx, error, cap);
    return -1;
}
#ifdef EMBEDTS_COMPILER
int embedts_compile(DangoTs *vm,const char *source,size_t len,uint8_t **out,size_t *size,char *error,size_t cap) {
    JS_AddIntrinsicEval(vm->ctx);
    JSValue module = JS_Eval(vm->ctx,source,len,"app.mjs",JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(module)) { error_text(vm->ctx,error,cap); return -1; }
    *out = JS_WriteObject(vm->ctx,size,module,JS_WRITE_OBJ_BYTECODE|JS_WRITE_OBJ_STRIP_SOURCE);
    JS_FreeValue(vm->ctx,module);
    if (!*out) { error_text(vm->ctx,error,cap); return -1; }
    return 0;
}
void embedts_compiled_free(DangoTs *vm,uint8_t *buffer) { js_free(vm->ctx,buffer); }
#endif
