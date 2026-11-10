'use strict';

// Behavior and retention checks for monkster's query wrapper.
const assert = require('assert');
const monk = require('monk');

// Methods monkster wraps. Install mocks before Monkster() captures them.
const methodNames = [
    'aggregate',
    'bulkWrite',
    'count',
    'distinct',
    'find',
    'findOne',
    'findOneAndDelete',
    'findOneAndUpdate',
    'group',
    'insert',
    'remove',
    'update'
];

// Per-test implementations and call counts.
const impl = {};
const calls = {};

// Replace prototype methods so tests never open a real socket.
for (const name of methodNames) {
    // Default success result
    impl[name] = function () {
        return Promise.resolve(name);
    };

    // Count entries into the original method
    calls[name] = 0;

    // Prototype function captured by the wrapper as the original method
    monk.Collection.prototype[name] = function () {
        calls[name]++;
        return impl[name].apply(this, arguments);
    };
}

// Load after mocks so the wrapper closes over them
const monkster = require('../lib/monkster');

// Short retries so tests finish quickly and mid-flight checks have a window.
// Threshold below zero marks every attempt slow so the stack log can be asserted.
monkster({
    maxTries: 3,
    retryInterval: 40,
    logSlowQueries: true,
    logSlowQueryThreshold: -1
});

// Silence retry logs and slow-query logs unless a test records them
const originalLog = console.log;
const originalDebug = console.debug;
console.log = function () {};
console.debug = function () {};

// Fail the process on a leaked rejection
process.on('unhandledRejection', (err) => {
    console.error(err);
    process.exit(1);
});

// Collection stand-in. Queue patch reads manager.
function context(manager) {
    return { name: 'users', manager: manager };
}

// Open manager with an empty queue
function openManager() {
    return {
        _state: 'open',
        _queue: [],
        on: function () {}
    };
}

// Let promises and timers settle, then collect
async function drain() {
    for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        global.gc();
    }
}

// Reset counters between cases
function resetCalls() {
    for (const name of methodNames) {
        calls[name] = 0;
    }
}

async function main() {
    // Exported monk is the module whose Collection.prototype gets wrapped
    assert.strictEqual(monkster.monk, monk);

    // Invalid options still throw after init
    assert.throws(() => monkster('nope'), /options argument/);

    // Successful query resolves and passes a numeric argument through
    {
        resetCalls();
        let seen;
        impl.find = function () {
            seen = Array.from(arguments);
            return Promise.resolve({ n: seen.length });
        };
        const value = await monk.Collection.prototype.find.call(context(openManager()), { a: 1 }, 5);
        assert.strictEqual(calls.find, 1);
        assert.deepStrictEqual(seen[0], { a: 1 });
        assert.strictEqual(seen[1], 5);
        assert.deepStrictEqual(value, { n: 2 });
    }

    // Non-thenable result is returned as-is
    {
        resetCalls();
        impl.find = function () {
            return 42;
        };
        const value = await monk.Collection.prototype.find.call(context(openManager()));
        assert.strictEqual(value, 42);
        assert.strictEqual(calls.find, 1);
    }

    // Sync throw is retried, then succeeds
    {
        resetCalls();
        impl.find = function () {
            if (calls.find < 3) {
                throw new Error('sync failure');
            }
            return Promise.resolve('recovered');
        };
        const value = await monk.Collection.prototype.find.call(context(openManager()));
        assert.strictEqual(value, 'recovered');
        assert.strictEqual(calls.find, 3);
    }

    // Async failures retry until success
    {
        resetCalls();
        impl.find = function () {
            if (calls.find < 3) {
                return Promise.reject(new Error('temporary'));
            }
            return Promise.resolve('ok');
        };
        const value = await monk.Collection.prototype.find.call(context(openManager()));
        assert.strictEqual(value, 'ok');
        assert.strictEqual(calls.find, 3);
    }

    // maxTries counts the first attempt plus retries (tries 0..maxTries)
    {
        resetCalls();
        impl.find = function () {
            return Promise.reject(new Error('permanent'));
        };
        await assert.rejects(monk.Collection.prototype.find.call(context(openManager())), /permanent/);
        assert.strictEqual(calls.find, 4);
    }

    // Interrupted operations are not retried
    {
        resetCalls();
        impl.find = function () {
            return Promise.reject(new Error('operation was interrupted'));
        };
        await assert.rejects(
            monk.Collection.prototype.find.call(context(openManager())),
            /operation was interrupted/
        );
        assert.strictEqual(calls.find, 1);
    }

    // A null rejection used to throw inside the catch and leave the outer promise pending
    {
        resetCalls();
        impl.find = function () {
            return Promise.reject(null);
        };
        await assert.rejects(monk.Collection.prototype.find.call(context(openManager())));
        assert.strictEqual(calls.find, 4);
    }

    // Duplicate key on _id is rewritten and retried
    {
        resetCalls();
        const doc = { _id: 'old', name: 'a' };
        impl.insert = function (document) {
            if (calls.insert === 1) {
                const err = new Error('E11000 duplicate key error collection: t.users index: _id_ dup key');
                err.code = 11000;
                return Promise.reject(err);
            }
            return Promise.resolve(document);
        };
        const saved = await monk.Collection.prototype.insert.call(context(openManager()), doc);
        assert.strictEqual(calls.insert, 2);
        assert.notStrictEqual(saved._id, 'old');
        assert.ok(saved._id);
    }

    // Bulk insert ids are regenerated together
    {
        resetCalls();
        const docs = [{ _id: 'a' }, { _id: 'b' }];
        impl.insert = function (documents) {
            if (calls.insert === 1) {
                const err = new Error('E11000 duplicate key error index: _id_');
                err.code = 11000;
                return Promise.reject(err);
            }
            return Promise.resolve(documents);
        };
        const saved = await monk.Collection.prototype.insert.call(context(openManager()), docs);
        assert.notStrictEqual(saved[0]._id, 'a');
        assert.notStrictEqual(saved[1]._id, 'b');
    }

    // find().each stays on the wrapper and is replayed for each retry
    {
        resetCalls();
        const applied = [];
        impl.find = function () {
            const failed = calls.find < 3;
            const operation = failed ? Promise.reject(new Error('stream ' + calls.find)) : Promise.resolve(['row']);
            operation.each = function (listener) {
                applied.push(listener);
                return operation;
            };
            return operation;
        };
        const query = monk.Collection.prototype.find.call(context(openManager()), {});
        const listener = function () {};
        const rows = await query.each(listener);
        assert.deepStrictEqual(rows, ['row']);
        assert.strictEqual(applied.length, 3);
        assert.ok(applied.every((fn) => fn === listener));
    }

    // A second Monkster() call must not stack another wrapper
    {
        resetCalls();
        monkster({ maxTries: 1, retryInterval: 1 });
        impl.find = function () {
            return Promise.resolve('once');
        };
        await monk.Collection.prototype.find.call(context(openManager()));
        assert.strictEqual(calls.find, 1);
    }

    // An already-open manager drops connect-time callbacks immediately
    {
        resetCalls();
        const manager = {
            _state: 'open',
            _queue: [function () {}, function () {}],
            on: function () {
                this.listeners = (this.listeners || 0) + 1;
            }
        };
        impl.find = function () {
            return Promise.resolve(true);
        };
        await monk.Collection.prototype.find.call(context(manager));
        await monk.Collection.prototype.find.call(context(manager));
        assert.strictEqual(manager._queue.length, 0);
        assert.strictEqual(manager.listeners, 1);
    }

    // Callbacks run on open, then the queue releases their payloads
    {
        resetCalls();
        const ran = [];
        const refs = [];
        const manager = {
            _state: 'opening',
            _queue: [],
            on: function (event, fn) {
                this.openListener = fn;
            }
        };
        for (let i = 0; i < 30; i++) {
            const payload = { buf: Buffer.alloc(64 * 1024, i + 1) };
            refs.push(new WeakRef(payload));
            manager._queue.push(function () {
                ran.push(payload.buf.length);
            });
        }
        impl.find = function () {
            return Promise.resolve(true);
        };
        const pending = monk.Collection.prototype.find.call(context(manager), { queued: true });
        assert.strictEqual(manager._queue.length, 30);
        manager._queue.slice().forEach((callback) => callback());
        manager.openListener.call(manager);
        assert.strictEqual(manager._queue.length, 0);
        assert.strictEqual(ran.length, 30);
        ran.length = 0;
        await pending;
        await drain();
        const alive = refs.filter((ref) => ref.deref()).length;
        assert.strictEqual(alive, 0);
    }

    // Query documents are not retained after the promise resolves, even if the caller keeps it.
    // The loop lives in a nested function so the async frame cannot pin the last document.
    {
        resetCalls();
        impl.find = function () {
            return Promise.resolve({ ok: true });
        };
        function startQueries() {
            const refs = [];
            const promises = [];
            for (let i = 0; i < 100; i++) {
                const doc = { i: i, buf: Buffer.alloc(32 * 1024, 7) };
                refs.push(new WeakRef(doc));
                promises.push(monk.Collection.prototype.find.call(context(openManager()), doc));
            }
            return { refs: refs, promises: promises };
        }
        const started = startQueries();
        await Promise.all(started.promises);
        await drain();
        const alive = started.refs.filter((ref) => ref.deref()).length;
        assert.strictEqual(alive, 0);
    }

    // Failed attempts are released once a later attempt replaces them
    {
        resetCalls();
        const refs = [];
        impl.find = function () {
            if (calls.find <= 3) {
                const payload = { n: calls.find, buf: Buffer.alloc(256 * 1024, calls.find) };
                refs.push(new WeakRef(payload));
                const err = new Error('temporary ' + calls.find);
                err.payload = payload;
                return Promise.reject(err);
            }
            return Promise.resolve('done');
        };
        const pending = monk.Collection.prototype.find.call(context(openManager()), { retry: true });
        await new Promise((resolve) => setTimeout(resolve, 70));
        global.gc();
        assert.ok(calls.find >= 2);
        assert.strictEqual(refs[0].deref(), undefined);
        const value = await pending;
        assert.strictEqual(value, 'done');
        await drain();
        const alive = refs.filter((ref) => ref.deref()).length;
        assert.strictEqual(alive, 0);
    }

    // Slow-query log keeps the original caller stack across retries
    {
        resetCalls();
        const lines = [];
        console.debug = function () {
            lines.push(Array.from(arguments).join(' '));
        };
        impl.find = function () {
            if (calls.find < 2) {
                return Promise.reject(new Error('slow then ok'));
            }
            return Promise.resolve('logged');
        };
        const value = await monk.Collection.prototype.find.call(context(openManager()));
        console.debug = function () {};
        assert.strictEqual(value, 'logged');
        assert.ok(lines.some((line) => line.includes('Slow query') && line.includes('users.find') && line.includes('leaks.js')));
    }

    console.log = originalLog;
    console.debug = originalDebug;
    console.log('leak tests passed');
}

main().catch((err) => {
    console.log = originalLog;
    console.debug = originalDebug;
    console.error(err);
    process.exit(1);
});
