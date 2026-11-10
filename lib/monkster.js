const monk = require('monk');

// Monk query methods
const methods = [
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

// Constructor
function Monkster(options) {
    // Default config
    const config = {
        // If a query fails more than X times, give up on it
        maxTries: 60,
        // Number of milliseconds to wait before retrying a failed query
        retryInterval: 1000
    };

    // Options provided?
    if (options) {
        // Options argument must be an object
        if (typeof options !== 'object') {
            throw new Error('Please provide the options argument as an object.');
        }

        // Overwrite default config with user-provided options
        for (const k in options) {
            config[k] = options[k];
        }
    }

    // Traverse collection's query methods
    for (const methodName of methods) {
        // Keep track of method before overwriting it
        const originalMethod = monk.Collection.prototype[methodName];

        // Already wrapped, or not a function on this Monk version
        if (typeof originalMethod !== 'function' || originalMethod.__monksterWrapped) {
            continue;
        }

        // Wrap the current method. One outer promise per call; retries must not chain new promises.
        // Strict mode so the arguments object is not retained by the retry closures.
        function wrappedQuery() {
            'use strict';

            // Shallow copy of the argument list (document objects stay shared so _id regeneration is visible)
            let args = Array.from(arguments);

            // Retry counter, slow query log tracking, and the in-flight operation
            let tries = 0;
            let start = 0;
            let callStack;
            let operationPromise;
            let eachListener;
            let retryTimer = null;
            let settled = false;
            let resolveQuery;
            let rejectQuery;

            // Release documents, stacks, and timer handles as soon as the call is finished
            function release() {
                // Ignore a late attempt after the outer promise is already settled
                if (settled) {
                    return false;
                }

                // Mark settled before dropping state
                settled = true;

                // Drop the Timeout object so its callback closure can be collected
                if (retryTimer) {
                    clearTimeout(retryTimer);
                    retryTimer = null;
                }

                // Drop per-query state even if the caller retains the promise
                args = null;
                callStack = null;
                operationPromise = null;
                eachListener = null;

                return true;
            }

            // Log slow queries and complete the outer promise
            const handleSuccess = (result) => {
                // Log slow queries (if enabled)
                if (config.logSlowQueries) {
                    // Calculate query execution time in ms
                    const executionTime = new Date().getTime() - start;

                    // Time took longer than slow query threshold?
                    if (executionTime > config.logSlowQueryThreshold) {
                        // Log slow query and the time it took
                        console.debug('[Monkster]', `Slow query: db.${this.name}.${methodName} took ${executionTime} miliseconds: ${callStack}`);
                    }
                }

                // Resolve query. A null result is still success.
                if (release()) {
                    resolveQuery(result);
                }
            };

            // Retry inside this call. Returning a new chained promise here retains every failed attempt.
            const handleFailure = (err) => {
                // Read the message without assuming err is always an Error
                const message = err && typeof err.toString === 'function' ? err.toString() : '';

                // Can we retry? (don't retry if operation was interrupted/killed by server or admin)
                if (tries >= config.maxTries || message.includes('operation was interrupted')) {
                    // Reject even when err is null or undefined
                    if (release()) {
                        rejectQuery(err);
                    }
                    return;
                }

                // Try again
                tries++;

                // Log ignored error to console
                console.log('[Monkster]', 'Ignoring Error', '(' + tries + '/' + config.maxTries + ')', err);

                // Resolve duplicate key error / Cannot read property 'socketTimeout'
                try {
                    resolveIrrecoverableErrors(err, args);
                } catch (repairErr) {
                    // A throw here used to leave the outer promise pending forever
                    if (release()) {
                        rejectQuery(repairErr);
                    }
                    return;
                }

                // Retry in X seconds against the original method, not the wrapper
                retryTimer = setTimeout(() => {
                    // Timer fired; drop the Timeout object before the next attempt allocates anything
                    retryTimer = null;

                    // Next attempt settles the same outer promise
                    attempt();
                }, config.retryInterval);

                // Drop the failed operation after find().each() has had its synchronous turn.
                // The rejection holds the driver error, which can reference the pool and cursor.
                Promise.resolve().then(() => {
                    // Leave it in place once the call has finished or the next attempt replaced it
                    if (!settled && retryTimer) {
                        operationPromise = null;
                    }
                });
            };

            // Run one attempt against the original Monk method
            const attempt = () => {
                // If log slow queries is enabled, track start time for this attempt only
                if (config.logSlowQueries) {
                    start = new Date().getTime();
                }

                // Call original method
                let operation;
                try {
                    operation = originalMethod.apply(this, args);
                } catch (err) {
                    // Sync failures follow the same retry path
                    handleFailure(err);
                    return;
                }

                // Keep the current operation so find().each() can attach before the cursor starts
                operationPromise = operation;

                // Re-apply a streaming listener on retries; the caller attaches it for the first attempt
                if (tries > 0 && eachListener && operation && typeof operation.each === 'function') {
                    operation.each(eachListener);
                }

                // Non-thenable results are already complete
                if (!operation || typeof operation.then !== 'function') {
                    handleSuccess(operation);
                    return;
                }

                // Second callback is the rejection handler, so a failure does not grow a promise chain
                operation.then(handleSuccess, handleFailure);
            };

            // Monk keeps every connect-time callback in manager._queue; drop those once the connection is open
            if (this && this.manager) {
                patchManagerQueue(this.manager);
            }

            // Capture the caller stack once. Retry timers would only record themselves.
            if (config.logSlowQueries) {
                callStack = Error().stack;
            }

            // Return promise. The executor runs now, so resolve/reject exist before the first attempt.
            const promise = new Promise((resolve, reject) => {
                // Hold the settlors for later attempts
                resolveQuery = resolve;
                rejectQuery = reject;

                // First attempt
                attempt();
            });

            // Preserve collection.find().each(), which only exists on Monk's promise
            if (operationPromise && typeof operationPromise.each === 'function') {
                promise.each = function (listener) {
                    // Remember the listener so a retry streams instead of buffering every document
                    eachListener = listener;

                    // Delegate before Monk starts the cursor
                    if (operationPromise && typeof operationPromise.each === 'function') {
                        operationPromise.each(listener);
                    }

                    // Keep the wrapper promise so retries still apply
                    return promise;
                };
            }

            return promise;
        }

        // Mark so a second Monkster() call does not stack wrappers
        wrappedQuery.__monksterWrapped = true;

        // Install wrapper
        monk.Collection.prototype[methodName] = wrappedQuery;
    }
}

// Monk pushes one callback per query into manager._queue while connecting and never removes them.
// Each callback retains that query for the life of the process.
function patchManagerQueue(manager) {
    // One patch per manager
    if (!manager || manager.__monksterQueuePatched) {
        return;
    }

    // Remember that this manager already drops drained callbacks
    manager.__monksterQueuePatched = true;

    // Connection is already up: queued callbacks have already been invoked
    if (manager._state === 'open' && Array.isArray(manager._queue) && manager._queue.length > 0) {
        manager._queue.length = 0;
    }

    // Monk registers its flush listener in the constructor, so it runs before this one
    if (typeof manager.on === 'function') {
        manager.on('open', function () {
            // Drop drained callbacks so query arguments can be collected
            if (Array.isArray(this._queue)) {
                this._queue.length = 0;
            }
        });
    }
}

function resolveIrrecoverableErrors(err, args) {
    // Query execution failed?
    if (err) {
        // Manually intervene for irrecoverable errors
        if (err && err.message) {
            // Work around for extremely rare duplicate key error on _id_ index (ObjectId)
            if (err.code === 11000 && err.message.includes('duplicate key error') && err.message.includes('index: _id_')) {
                // Make sure we have a document to modify
                if (args && args[0]) {
                    // Object (single document)?
                    if (Object.prototype.toString.call(args[0]) === '[object Object]') {
                        // Override with new unique ObjectId and try inserting again
                        args[0]._id = monk.id();
                    }
                    // Support for bulk insert operations
                    else if (Array.isArray(args[0])) {
                        // Re-generate all IDs to avoid multiple collisions
                        for (const item of args[0]) {
                            // Override document ID with new unique ObjectId and try inserting again
                            item._id = monk.id();
                        }
                    }
                }
            }

            // Workaround for "Cannot read property 'socketTimeout' of null"
            // The only way to recover from this MongoDB driver error is to restart the process
            if (err.message.includes("Cannot read property 'socketTimeout' of null")) {
                // Log to console & restart process
                console.log('[Monkster]', 'Restarting process due to unrecoverable error:', err);
                return process.exit(0);
            }
        }
    }
}

// Share the monk module whose Collection.prototype this file wraps
Monkster.monk = monk;

module.exports = Monkster;
