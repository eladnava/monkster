// Monk query methods
var methods = [
    'aggregate',
    'bulkWrite',
    'count',
    'distinct',
    'drop',
    'dropIndex',
    'dropIndexes',
    'ensureIndex',
    'find',
    'findOne',
    'findOneAndDelete',
    'findOneAndUpdate',
    'group',
    'indexes',
    'insert',
    'remove',
    'update',
    'updateById',
    'findById',
    'findAndModify',
];

// Constructor
function Monkster(options) {
    // Default config
    this.config = {
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
        for (var k in options) {
            this.config[k] = options[k];
        }
    }
}

// Wraps a collection's query methods with monkster error handling logic
Monkster.prototype.wrapCollection = function (collection) {
    // Traverse colletion's query methods
    for (var i in methods) {
        // Wrap the current method
        collection[methods[i]] = this.wrapMethod(collection, collection[methods[i]]);
    }

    return collection;
};

Monkster.prototype.wrapMethod = function (collection, originalMethod) {
    // Keep track of Monkster instance config
    var config = this.config;

    // Define a function that will return a promise when the query methods are invoked
    return function () {
        // Try counter
        var tries = 0;

        // Obtain function arguments dynamically
        var originalArgs = [].slice.call(arguments);

        // Save reference to calling method (third line in stack trace)
        var calling = Error().stack.split('\n')[3];

        // Main query execution logic
        var executeQuery = function (resolve, reject) {
            // Increment current tries
            tries++;

            // Clone the original args array
            var args = originalArgs.slice();

            // Handle various query errors
            var handleErrors = function (err) {
                // Can we retry? (don't retry if operation was interrupted/killed by server or admin)
                if (!err.toString().includes('operation was interrupted') && tries <= config.maxTries) {
                    // Log ignored error to console
                    console.log('[Monkster]', 'Ignoring Error', '(' + tries + '/' + config.maxTries + ')', err);

                    // Retry the query (after sleeping for X ms)
                    return setTimeout(function () { executeQuery(resolve, reject); }, config.retryInterval);
                }

                // Reject the promise
                reject(err);
            };

            // Error opening listener
            var connectionErrorOpeningListener = function (err) {
                // Unregister listener
                collection.manager.removeListener('error-opening', connectionErrorOpeningListener);

                // Handle connection error
                handleErrors(err);
            };

            // Save start time
            var start = new Date().getTime();

            // Add our own callback to provided args
            args.push(function (err, result) {
                // Query execution failed?
                if (err) {
                    return handleErrors(err);
                }

                // Unregister connection errors listener
                collection.manager.removeListener('error-opening', connectionErrorOpeningListener);

                // Calculate query execution time in ms
                var executionTime = new Date().getTime() - start;

                // Log slow queries (if enabled)
                if (config.logSlowQueries && executionTime > config.logSlowQueryThreshold) {
                    console.debug('[Monkster]', `Finished operation on db.${collection.name} in ${executionTime} miliseconds: ${calling}` );
                }

                // Success, resolve the promise with the query result
                resolve(result);
            });

            // Listen for connection errors (these are not returned by Monk in the standard error callback)
            collection.manager.on('error-opening', connectionErrorOpeningListener);

            // Call original query function with our custom callback
            originalMethod.apply(collection, args);
        };

        // Return a new promise for the query to be resolved or rejected
        return new Promise(function (resolve, reject) {
            // Attempt to execute the query with our improved error handling logic (recursive)
            executeQuery(resolve, reject);
        });
    };
};

module.exports = Monkster;