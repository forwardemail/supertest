'use strict';

/**
 * Module dependencies.
 */
const methods = require('methods');
const http = require('http');
let http2;
try {
  http2 = require('http2'); // eslint-disable-line global-require
} catch (_) {
  // eslint-disable-line no-empty
}
const Test = require('./lib/test.js');
const agent = require('./lib/agent.js');
const cookies = require('./lib/cookies');

/**
 * Test against the given `app`,
 * returning a new `Test`.
 *
 * @param {Function|Server|String} app
 * @return {Test}
 * @api public
 */
module.exports = function(app, options = {}) {
  const obj = {};

  if (typeof app === 'function') {
    if (options.http2) {
      if (!http2) {
        throw new Error(
          'supertest: this version of Node.js does not support http2'
        );
      }
    }
  }

  methods.forEach(function(method) {
    obj[method] = function(url) {
      var test = new Test(app, method, url, options.http2);
      if (options.http2) {
        test.http2();
      }
      return test;
    };
  });

  // Support previous use of del
  obj.del = obj.delete;

  /**
   * Run `n` requests concurrently against a single shared server and resolve
   * with the responses in build order. `build` is called with a request
   * instance bound to that server and the request index.
   *
   *   const responses = await request(app)
   *     .concurrently(2, (r, i) => r.post('/payments').send(body));
   *
   * @param {Number} n number of concurrent requests, >= 2
   * @param {Function} build (req, index) => Test
   * @return {Promise<Array>}
   * @api public
   */
  obj.concurrently = function(n, build) {
    if (!Number.isInteger(n) || n < 2) {
      throw new TypeError(
        '.concurrently(n, build) expects n to be an integer >= 2, got ' + n
      );
    }
    if (typeof build !== 'function') {
      throw new TypeError(
        '.concurrently(n, build) expects build to be a function, got ' + typeof build
      );
    }

    // A function app would get one ephemeral server per request; wrap it once
    // so all n requests genuinely race against the same server.
    let target = app;
    if (typeof app === 'function') {
      target = options.http2 ? http2.createServer(app) : http.createServer(app);
    }
    const shared = module.exports(target, options);

    const tests = [];
    for (let i = 0; i < n; i += 1) {
      tests.push(build(shared, i));
    }
    return global.Promise.all(tests);
  };

  return obj;
};

/**
 * Expose `Test`
 */
module.exports.Test = Test;

/**
 * Expose the agent function
 */
module.exports.agent = agent;

/**
 * Expose cookie assertions
 */
module.exports.cookies = cookies;
