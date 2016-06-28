// Change '../' to 'monkster' to use this code outside of the package
var monkster = require('../');
var co = require('co');
var monk = require('monk');

// Initialize Monk with your MongoDB connection string
var db = monk('localhost/test');

// Initialize Monkster and customize its error handling behavior
var wrap = monkster({
    // If a query fails more than X times, give up on it (default: 5)
    maxTries: 5,
    // Number of milliseconds to wait before retrying a failed query (default: 100)
    retryInterval: 100
});

// Wrap your collections with monkster
var users = wrap(db.get('users'));

// ES6 generator control flow
co(function* () {
    // Run forever
    // Feel free to step down your replica set
    // or cut the network momentarily while this runs
    while (true) {
        try {
            // Insert a document into the collection
            yield users.insert({ name: 'Hello World' });

            // Count number of documents in the collection
            var count = yield users.count({});

            // Print current document count
            console.log('collection.count:', count);
        }
        catch (err) {
            // Query failed for more than X tries
            console.log('Query Failed', err);
        }
    }
});
