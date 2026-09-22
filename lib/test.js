'use strict';

/**
 * Module dependencies.
 */

const { inspect } = require('util');
const http = require('http');
const { STATUS_CODES } = require('http');
const { Server } = require('tls');
const { deepStrictEqual } = require('assert');
const { Request } = require('superagent');
let http2;
try {
  http2 = require('http2'); // eslint-disable-line global-require
} catch (_) {
  // eslint-disable-line no-empty
}

/** @typedef {import('superagent').Response} Response */

// Tracks only servers started by SuperTest.  WeakMap keeps the bookkeeping
// private and lets user-owned servers remain untouched.
const serverStates = new WeakMap();

class Test extends Request {
  /**
   * Initialize a new `Test` with the given `app`,
   * request `method` and `path`.
   *
   * @param {Server} app
   * @param {String} method
   * @param {String} path
   * @api public
   */
  constructor (app, method, path, optHttp2) {
    super(method.toUpperCase(), path);

    if (typeof app === 'function') {
      if (optHttp2) {
        app = http2.createServer(app); // eslint-disable-line no-param-reassign
      } else {
        app = http.createServer(app); // eslint-disable-line no-param-reassign
      }
    }

    this.redirects(0);
    this.buffer();
    this.app = app;
    this._asserts = [];
    this.url = typeof app === 'string'
      ? app + path
      : this.serverAddress(app, path);
  }

  /**
   * Returns a URL, extracted from a server.
   *
   * @param {Server} app
   * @param {String} path
   * @returns {String} URL address
   * @api private
   */
  serverAddress(app, path) {
    let addr = app.address();
    let state = serverStates.get(app);

    if (!addr) {
      if (!state) {
        state = {
          pending: 0,
          starting: true,
          closing: false,
          startError: null
        };
        serverStates.set(app, state);

        const onListening = function () {
          state.starting = false;
          app.removeListener('error', onError);
        };
        const onError = function (err) {
          state.starting = false;
          state.startError = err;
          app.removeListener('listening', onListening);
        };

        app.once('listening', onListening);
        app.once('error', onError);
        app.listen(0);
      }
      addr = app.address();
    }

    // A previously started SuperTest server is shared by every request created
    // from the same request factory and closes after the final request settles.
    if (state) {
      this._server = app;
    }

    // A SuperTest-created IPv6 wildcard is dual-stack by default. Prefer IPv4
    // for that wildcard so SuperAgent does not construct an IPv6 loopback URL;
    // explicit IPv6-only servers retain their own address family below.
    let host = addr.address;
    if (host === '::') host = '127.0.0.1';
    else if (host === '0.0.0.0') host = '127.0.0.1';
    if (host.includes(':')) host = `[${host}]`;

    const port = addr.port;
    const protocol = app instanceof Server ? 'https' : 'http';
    return protocol + '://' + host + ':' + port + path;
  }

  /**
   * Expectations:
   *
   *   .expect(200)
   *   .expect(200, fn)
   *   .expect(200, body)
   *   .expect('Some body')
   *   .expect('Some body', fn)
   *   .expect(['json array body', { key: 'val' }])
   *   .expect('Content-Type', 'application/json')
   *   .expect('Content-Type', 'application/json', fn)
   *   .expect(fn)
   *   .expect([200, 404])
   *
   * @return {Test}
   * @api public
   */
  expect(a, b, c) {
    // callback
    if (typeof a === 'function') {
      this._asserts.push(wrapAssertFn(a));
      return this;
    }
    if (typeof b === 'function') this.end(b);
    if (typeof c === 'function') this.end(c);

    // status
    if (typeof a === 'number') {
      this._asserts.push(wrapAssertFn(this._assertStatus.bind(this, a)));
      // body
      if (typeof b !== 'function' && arguments.length > 1) {
        this._asserts.push(wrapAssertFn(this._assertBody.bind(this, b)));
      }
      return this;
    }

    // multiple statuses
    if (Array.isArray(a) && a.length > 0 && a.every(val => typeof val === 'number')) {
      this._asserts.push(wrapAssertFn(this._assertStatusArray.bind(this, a)));
      return this;
    }

    // header field
    if (typeof b === 'string' || typeof b === 'number' || b instanceof RegExp) {
      this._asserts.push(wrapAssertFn(this._assertHeader.bind(this, { name: '' + a, value: b })));
      return this;
    }

    // body
    this._asserts.push(wrapAssertFn(this._assertBody.bind(this, a)));

    return this;
  }

  /**
   * Defer invoking superagent's `.end()` until
   * the server is listening.
   *
   * @param {?Function} fn
   * @api public
   */
  end(fn) {
    const server = this._server;
    const state = server && serverStates.get(server);
    let complete = false;
    let dispatch;
    let onListening;
    let onStartError;
    let onClose;

    const removeStartListeners = () => {
      if (!server) return;
      if (onListening) server.removeListener('listening', onListening);
      if (onStartError) server.removeListener('error', onStartError);
      if (onClose) server.removeListener('close', onClose);
    };

    const finish = (err, res) => {
      if (complete) return;
      complete = true;
      removeStartListeners();

      const localAssert = () => this.assert(err, res, fn);
      if (state) {
        state.pending -= 1;
        if (state.pending === 0 && !state.closing && server._handle) {
          state.closing = true;
          return server.close(function () {
            serverStates.delete(server);
            localAssert();
          });
        }
        if (state.pending === 0 && !server._handle) serverStates.delete(server);
      }

      localAssert();
    };

    dispatch = () => {
      removeStartListeners();
      try {
        super.end(finish);
      } catch (err) {
        finish(err);
      }
    };

    if (state) state.pending += 1;

    if (state && state.startError) {
      finish(state.startError);
    } else if (state && state.starting) {
      onListening = dispatch;
      onStartError = finish;
      onClose = function () {
        finish(new Error('SuperTest server closed before listening'));
      };
      server.once('listening', onListening);
      server.once('error', onStartError);
      server.once('close', onClose);
    } else {
      dispatch();
    }

    return this;
  }

  /**
   * Perform assertions and invoke `fn(err, res)`.
   *
   * @param {?Error} resError
   * @param {Response} res
   * @param {Function} fn
   * @api private
   */
  assert(resError, res, fn) {
    let errorObj;

    // check for unexpected network errors or server not running/reachable errors
    // when there is no response and superagent sends back a System Error
    // do not check further for other asserts, if any, in such case
    // https://nodejs.org/api/errors.html#errors_common_system_errors
    const sysErrors = {
      ECONNREFUSED: 'Connection refused',
      ECONNRESET: 'Connection reset by peer',
      EPIPE: 'Broken pipe',
      ETIMEDOUT: 'Operation timed out'
    };

    if (!res && resError) {
      if (resError instanceof Error && resError.syscall === 'connect'
        && Object.getOwnPropertyNames(sysErrors).indexOf(resError.code) >= 0) {
        errorObj = new Error(resError.code + ': ' + sysErrors[resError.code]);
      } else {
        errorObj = resError;
      }
    }

    // asserts
    for (let i = 0; i < this._asserts.length && !errorObj; i += 1) {
      errorObj = this._assertFunction(this._asserts[i], res);
    }

    // set unexpected superagent error if no other error has occurred.
    if (!errorObj && resError instanceof Error && (!res || resError.status !== res.status)) {
      errorObj = resError;
    }

    if (fn) {
      fn.call(this, errorObj || null, res);
    }
  }

  /*
    * Adds a set Authorization Bearer
    *
    * @param {Bearer} Bearer Token
    * Shortcut for .set('Authorization', `Bearer ${token}`)
    */

  bearer(token) {
    this.set('Authorization', `Bearer ${token}`);
    return this;
  }

  /**
   * Perform assertions on a response body and return an Error upon failure.
   *
   * @param {Mixed} body
   * @param {Response} res
   * @return {?Error}
   * @api private
   */// eslint-disable-next-line class-methods-use-this
  _assertBody(body, res) {
    const isRegexp = body instanceof RegExp;

    // parsed
    if (typeof body === 'object' && !isRegexp) {
      try {
        deepStrictEqual(body, res.body);
      } catch (err) {
        const a = inspect(body);
        const b = inspect(res.body);
        return error('expected ' + a + ' response body, got ' + b, body, res.body);
      }
    } else if (body !== res.text) {
      // string
      const a = inspect(body);
      const b = inspect(res.text);

      // regexp
      if (isRegexp) {
        if (!body.test(res.text)) {
          return error('expected body ' + b + ' to match ' + body, body, res.body);
        }
      } else {
        return error('expected ' + a + ' response body, got ' + b, body, res.body);
      }
    }
  }

  /**
   * Perform assertions on a response header and return an Error upon failure.
   *
   * @param {Object} header
   * @param {Response} res
   * @return {?Error}
   * @api private
   */// eslint-disable-next-line class-methods-use-this
  _assertHeader(header, res) {
    const field = header.name;
    const actual = res.headers[field.toLowerCase()];
    const fieldExpected = header.value;

    if (typeof actual === 'undefined') return new Error('expected "' + field + '" header field');
    // This check handles header values that may be a String or single element Array
    if ((Array.isArray(actual) && actual.toString() === fieldExpected)
      || fieldExpected === actual) {
      return;
    }
    if (fieldExpected instanceof RegExp) {
      if (!fieldExpected.test(actual)) {
        return new Error('expected "' + field + '" matching '
          + fieldExpected + ', got "' + actual + '"');
      }
    } else {
      return new Error('expected "' + field + '" of "' + fieldExpected + '", got "' + actual + '"');
    }
  }

  /**
   * Perform assertions on the response status and return an Error upon failure.
   *
   * @param {Number} status
   * @param {Response} res
   * @return {?Error}
   * @api private
   */// eslint-disable-next-line class-methods-use-this
  _assertStatus(status, res) {
    if (res.status !== status) {
      const a = STATUS_CODES[status];
      const b = STATUS_CODES[res.status];
      return new Error('expected ' + status + ' "' + a + '", got ' + res.status + ' "' + b + '"');
    }
  }

  /**
   * Perform assertions on the response status and return an Error upon failure.
   *
   * @param {Array<Number>} statusArray
   * @param {Response} res
   * @return {?Error}
   * @api private
   */// eslint-disable-next-line class-methods-use-this
  _assertStatusArray(statusArray, res) {
    if (!statusArray.includes(res.status)) {
      const b = STATUS_CODES[res.status];
      const expectedList = statusArray.join(', ');
      return new Error(
        'expected one of "' + expectedList + '", got ' + res.status + ' "' + b + '"'
      );
    }
  }

  /**
   * Performs an assertion by calling a function and return an Error upon failure.
   *
   * @param {Function} fn
   * @param {Response} res
   * @return {?Error}
   * @api private
   */// eslint-disable-next-line class-methods-use-this
  _assertFunction(fn, res) {
    let err;
    try {
      err = fn(res);
    } catch (e) {
      err = e;
    }
    if (err instanceof Error) return err;
  }
}

/**
 * Wraps an assert function into another.
 * The wrapper function edit the stack trace of any assertion error, prepending a more useful stack to it.
 *
 * @param {Function} assertFn
 * @returns {Function} wrapped assert function
 */

function wrapAssertFn(assertFn) {
  const savedStack = new Error().stack.split('\n').slice(3);

  return function(res) {
    let badStack;
    let err;
    try {
      err = assertFn(res);
    } catch (e) {
      err = e;
    }
    if (err instanceof Error && err.stack) {
      badStack = err.stack.replace(err.message, '').split('\n').slice(1);
      err.stack = [err.toString()]
        .concat(savedStack)
        .concat('----')
        .concat(badStack)
        .join('\n');
    }
    return err;
  };
}

/**
 * Return an `Error` with `msg` and results properties.
 *
 * @param {String} msg
 * @param {Mixed} expected
 * @param {Mixed} actual
 * @return {Error}
 * @api private
 */

function error(msg, expected, actual) {
  const err = new Error(msg);
  err.expected = expected;
  err.actual = actual;
  err.showDiff = true;
  return err;
}

/**
 * Expose `Test`.
 */

module.exports = Test;
