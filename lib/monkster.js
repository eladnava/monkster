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

    // Traverse colletion's query methods
    for (const i in methods) {
        // Keep track of method before overwriting it
        const originalMethod = monk.Collection.prototype[methods[i]];

        // Keep track of method name
        const originalMethodName = methods[i];

        // Wrap the current method
        monk.Collection.prototype[methods[i]] = function () {
            // Retry counter, slow query log tracking
            let tries = 0, start, callStack;

            // Keep track of arguments passed in
            const args = Array.from(arguments);

            // If log slow queries is enabled, track start time and get call stack
            if (config.logSlowQueries) {
                // Save start time
                start = new Date().getTime();

                // Save reference to call stack
                callStack = Error().stack;
            }

            // Last argument is a number?
            if (args.length > 0 && typeof args[args.length - 1] === 'number') {
                // It must be the retry counter
                tries = args[args.length - 1];

                // Remove tries argument (don't send it to DB driver)
                args.pop();
            }

            // Return promise
            return new Promise((resolve, reject) => {
                // Call original method
                originalMethod.apply(this, args).then((...args) => {
                    // Log slow queries (if enabled)
                    if (config.logSlowQueries) {
                        // Calculate query execution time in ms
                        const executionTime = new Date().getTime() - start;

                        // Time took longer than slow query threshold?
                        if (executionTime > config.logSlowQueryThreshold) {
                            // Log slow query and the time it took
                            console.debug('[Monkster]', `Slow query: db.${this.name}.${originalMethodName} took ${executionTime} miliseconds: ${callStack}`);
                        }
                    }

                    // Resolve query
                    resolve(...args);
                }).catch((err) => {
                    // Can we retry? (don't retry if operation was interrupted/killed by server or admin)
                    if (tries >= config.maxTries || err.toString().includes('operation was interrupted')) {
                        return reject(err);
                    }

                    // Try again
                    tries++;

                    // Add tries counter to args
                    args.push(tries);

                    // Log ignored error to console
                    console.log('[Monkster]', 'Ignoring Error', '(' + tries + '/' + config.maxTries + ')', err);

                    // Resolve duplicate key error / Cannot read property 'socketTimeout'
                    resolveIrrecoverableErrors(err, args);

                    // Retry in X sconds
                    setTimeout(() => { monk.Collection.prototype[methods[i]].apply(this, args).then(resolve).catch(reject) }, config.retryInterval);
                });
            });
        }
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
                if (args[0]) {
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

module.exports = Monkster;