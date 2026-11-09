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

/**
 * Starts listening on `server` and tracks it as started by SuperTest.
 *
 * @param {Server} server
 * @return {Object} state
 * @api private
 */
function startServer(server) {
  const state = {
    pending: 0,
    listening: false,
    closing: false,
    error: null,
    waiting: [],
    reopen: []
  };

  function settle(err) {
    server.removeListener('listening', onListening);
    server.removeListener('error', onError);
    server.removeListener('close', onClose);
    state.listening = !err;
    state.error = err;
    const waiting = state.waiting;
    state.waiting = [];
    waiting.forEach(function (callback) {
      callback(err);
    });
  }
  function onListening() {
    settle(null);
  }
  function onError(err) {
    settle(err);
  }
  function onClose() {
    settle(new Error('SuperTest server closed before listening'));
  }

  serverStates.set(server, state);
  server.once('listening', onListening);
  server.once('error', onError);
  server.once('close', onClose);
  // Bind to the same address the client connects to. A wildcard bind can
  // share its port with another process's 127.0.0.1 listener on macOS,
  // and the request would then reach that process instead.
  server.listen(0, '127.0.0.1');
  return state;
}

/**
 * Holds `server` open for one request and calls `fn(err, release)` once it
 * is listening. A server that is not listening is started, and one SuperTest
 * is still closing is started again after the close. `release(done)` closes
 * the server after its last hold, then calls `done`. A server its caller
 * started is left alone, and `release` is then `null`.
 *
 * @param {Server} server
 * @param {Function} fn
 * @api private
 */
function holdServer(server, fn) {
  let state = serverStates.get(server);

  // The caller closed a server SuperTest started, so start it again.
  if (state && state.listening && !state.closing && !server.address()) {
    serverStates.delete(server);
    state = undefined;
  }

  if (state && state.closing) {
    state.reopen.push(function () {
      holdServer(server, fn);
    });
    return;
  }

  if (!state) {
    if (server.address()) return fn(null, null);
    state = startServer(server);
  }

  state.pending += 1;
  const release = function (done) {
    state.pending -= 1;
    if (state.pending > 0 || serverStates.get(server) !== state) return done();

    if (!state.listening || !server.address()) {
      serverStates.delete(server);
      return done();
    }

    state.closing = true;
    server.close(function () {
      serverStates.delete(server);
      // Restart for waiting requests first, so a callback that throws in
      // done() cannot strand them.
      state.reopen.forEach(function (reopen) {
        reopen();
      });
      done();
    });
  };

  if (state.listening || state.error) return fn(state.error, release);
  state.waiting.push(function (err) {
    fn(err, release);
  });
}

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
    const addr = app.address();

    // A server its caller already started stays under the caller's control.
    if (addr && !serverStates.has(app)) return this.formatServerUrl(app, addr, path);

    // Otherwise SuperTest starts the server on the first write(), pipe() or
    // end() and shares it with every request made from the same app until the
    // last one settles. Listening with a host resolves asynchronously, and a
    // restarted server gets a new port, so the URL is completed once listening.
    this._server = app;
    this._serverPath = path;
    if (addr) return this.formatServerUrl(app, addr, path);
    const protocol = app instanceof Server ? 'https' : 'http';
    return protocol + '://127.0.0.1' + path;
  }

  /**
   * Calls `fn(err)` once the server can take this request, holding a server
   * started by SuperTest open until `_releaseServer()`.
   *
   * @param {Function} fn
   * @api private
   */
  _whenServerReady(fn) {
    const server = this._server;
    if (!server || this._serverReady === true) return fn(this._serverError);
    if (this._serverReady) return this._serverReady.push(fn);

    this._serverReady = [fn];
    holdServer(server, (err, release) => {
      const callbacks = this._serverReady;
      this._serverReady = true;
      this._serverError = err;
      this._serverRelease = release;
      if (!err) this.url = this.formatServerUrl(server, server.address(), this._serverPath);
      callbacks.forEach(function (callback) {
        callback(err);
      });
    });
  }

  /**
   * Releases the hold `_whenServerReady()` took, at most once, then calls `fn`.
   *
   * @param {Function} fn
   * @api private
   */
  _releaseServer(fn) {
    const release = this._serverRelease;
    if (!release) return fn();
    this._serverRelease = undefined;
    release(fn);
  }

  /**
   * Write data to the request body, holding it until the server SuperTest
   * starts is listening.
   *
   * @param {Buffer|String} data
   * @param {String} [encoding]
   * @return {Boolean}
   * @api public
   */
  write(data, encoding) {
    if (!this._server || this._serverReady === true) {
      return this._serverError ? false : super.write(data, encoding);
    }

    if (!this._serverWrites) {
      this._serverWrites = [];
      this._whenServerReady((err) => {
        const writes = this._serverWrites;
        this._serverWrites = undefined;
        // end() reports a server that failed to start or a failed write.
        if (err) return;
        try {
          writes.forEach((args) => {
            super.write(args[0], args[1]);
          });
        } catch (e) {
          this._serverError = e;
          this.abort();
        }
      });
    }
    this._serverWrites.push([data, encoding]);
    return true;
  }

  /**
   * Returns the underlying request. Before the server SuperTest starts is
   * listening its port is unknown, and a request built then would go to
   * port 80 and be reused by end(), so this throws instead.
   *
   * @return {http.ClientRequest}
   * @api public
   */
  request() {
    if (!this.req && this._server && (this._serverReady !== true || this._serverError)) {
      throw new Error(
        'request() was called before the server SuperTest started was listening.'
        + ' Use the \'request\' event, or pass a server that is already listening.'
      );
    }
    return super.request();
  }

  /**
   * Pipe the response to `stream` once the server SuperTest starts is
   * listening.
   *
   * @param {Stream} stream
   * @param {Object} [options]
   * @return {Stream}
   * @api public
   */
  pipe(stream, options) {
    // A piped response settles with 'end' instead of the end() callback.
    this.once('end', () => {
      this._releaseServer(function () {});
    });

    this._whenServerReady((err) => {
      if (!err) return super.pipe(stream, options);
      this._releaseServer(function () {
        stream.emit('error', err);
      });
    });
    return stream;
  }

  /**
   * Builds a request URL from a listening server address.
   *
   * @param {Server} app
   * @param {Object} addr
   * @param {String} path
   * @returns {String} URL address
   * @api private
   */// eslint-disable-next-line class-methods-use-this
  formatServerUrl(app, addr, path) {
    // Map wildcard addresses of servers passed in already listening to the
    // IPv4 loopback so SuperAgent does not construct an IPv6 loopback URL;
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
    let complete = false;
    // superagent rejects a second end(), so only the first one releases the
    // server it is still using.
    const releases = !this._ended;
    this._ended = true;

    const finish = (err, res) => {
      if (complete) return;
      complete = true;
      const localAssert = () => this.assert(err, res, fn);
      if (!releases) return localAssert();
      this._releaseServer(localAssert);
    };

    this._whenServerReady(() => {
      if (this._serverError) return finish(this._serverError);
      try {
        super.end(finish);
      } catch (e) {
        finish(e);
      }
    });

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
    // Header values are strings, so a number matches its string form.
    const fieldExpected = typeof header.value === 'number' ? String(header.value) : header.value;

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
