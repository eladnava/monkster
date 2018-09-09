# monkster
[![npm version](https://badge.fury.io/js/monkster.svg)](https://www.npmjs.com/package/monkster)

A Node.js package that provides high availability for [Monk](https://github.com/Automattic/monk), the wise MongoDB API. It implements smart error handling and retry logic to handle temporary network connectivity issues and replica set step-downs seamlessly.

## Motivations

* Unexpected network connectivity / DNS server issues could cause queries to fail every once in a while
* Replica set step-downs would cause outstanding queries to fail with "Could not locate any valid servers in initial seed list", "sockets closed", and "ECONNRESET" before additional queries would get buffered up even though `bufferMaxEntries` is correctly configured

## Usage

First, install the package using npm:

```shell
npm install monkster --save
```

Then, require `monkster` and wrap your collections with it, as demonstrated here:

```js
var monk = require('monk');
var monkster = require('monkster');

// Initialize Monk with your MongoDB connection string
var db = monk('localhost/test');

// Initialize Monkster and customize its error handling behavior
var wrap = monkster({
    // If a query fails more than X times, give up on it (default: 60)
    maxTries: 60,
    // Number of milliseconds to wait before retrying a failed query (default: 1000)
    retryInterval: 1000
});

// Wrap your collections with monkster
var logs = wrap(db.get('logs'));
var users = wrap(db.get('users'));
```

Finally, invoke your queries as you are used to -- Monkster will take care of the error handling and retry logic for you. Feel free to use ES6 generators to achieve this.

```js
try {
    // Insert a document into the collection (with generators)
    yield users.insert({ name: 'Hello World' });
}
catch (err) {
    // Query failed for more than "maxTries" number of tries
}

// Count number of documents in the collection (with promises)
var count = users.count({})
    .then(function (count) {
        // Query succeeded
        console.log('Number of documents', count);
    }).catch(function (err) {
        // Query failed for more than "maxTries" number of tries
    });
```

Check out [`examples/basic.js`](examples/basic.js) for a more complete example.

## Configuration

Monkster supports the following configuration, passed in when invoking `monkster`:

```js
var options = {
    // If a query fails more than X times, give up on it
    maxTries: 60,
    // Number of milliseconds to wait before retrying a failed query
    retryInterval: 1000
}

var wrap = monkster(options);
```

## License

Apache 2.0
