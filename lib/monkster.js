var monk = require('monk');

// Monk query methods
var methods = [
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
    let config = {
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
            config[k] = options[k];
        }
    }

    // Traverse colletion's query methods
    for (let i in methods) {
        // Keep track of method before overwriting it
        let originalMethod = monk.Collection.prototype[methods[i]];

        // Wrap the current method
        monk.Collection.prototype[methods[i]] = function () {
            // Retry counter
            let tries = 0;

            // Keep track of arguments passed in
            let args = Array.from(arguments);

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
                originalMethod.apply(this, args).then(resolve).catch((err) => {
                    // Ran out of retries?
                    if (tries >= config.maxTries) {
                        return reject(err);
                    }

                    // Try again
                    tries++;

                    // Add tries counter to args
                    args.push(tries);

                    // Log ignored error to console
                    console.log('[Monkster]', 'Ignoring Error', '(' + tries + '/' + config.maxTries + ')', err);

                    // Retry in X sconds
                    setTimeout(() => { monk.Collection.prototype[methods[i]].apply(this, args).then(resolve).catch(reject) }, config.retryInterval);
                });
            });
        }
    }
}

module.exports = Monkster;