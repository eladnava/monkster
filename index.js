var Monkster = require('./lib/monkster');

module.exports = function (options) {
    // Instantiate a new instance of Monkster
    var instance = new Monkster(options);

    // Expose the collection wrapping function
    return function(collection) {
        // Wrap the collection object and return it
        return instance.wrapCollection(collection);
    };
};