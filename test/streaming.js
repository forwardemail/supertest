'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const sinon = require('sinon');
const should = require('should');
const request = require('../index');

function echo(req, res) {
  req.pipe(res);
}

describe('streaming request bodies', function () {
  it('should write chunks before an ephemeral server is listening', function (done) {
    const test = request(echo).post('/');
    test.write('first ');
    test.write(Buffer.from('second'));
    test.expect(200, 'first second').end(done);
  });

  it('should resume a piped upload after the server starts', function (done) {
    const test = request(echo).post('/');
    test.expect(200, 'first second');
    const end = test.end;
    test.end = function () { return end.call(this, done); };
    Readable.from(['first ', Buffer.from('second')]).pipe(test);
  });

  it('should resolve the URL when the first write is after listening', function (done) {
    const test = request(echo).post('/');
    test._server.once('listening', function () {
      test.write('hello');
      test.expect(200, 'hello').end(done);
    });
  });

  it('should preserve query strings and encoded chunks', function (done) {
    const test = request(function (req, res) {
      req.url.should.equal('/?value=a%20b');
      echo(req, res);
    }).post('/').query('value=a%20b');
    test.write('636166c3a9', 'hex');
    test.expect(200, 'café').end(done);
  });

  it('should preserve streaming to an already-listening server', function (done) {
    const server = http.createServer(echo);
    server.listen(0, '127.0.0.1', function () {
      const test = request(server).post('/');
      test.write('hello');
      test.expect(200, 'hello').end(function (err) {
        server.listening.should.equal(true);
        server.close(function () { done(err); });
      });
    });
  });

  it('should stream with an agent', function (done) {
    const test = request.agent(echo).post('/');
    test.write('hello');
    test.expect(200, 'hello').end(done);
  });

  it('should stream over HTTPS before listening', function (done) {
    const server = https.createServer({
      key: fs.readFileSync(path.join(__dirname, 'fixtures/test_key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'fixtures/test_cert.pem'))
    }, echo);
    const test = request(server).post('/').disableTLSCerts();
    test.write('hello');
    test.expect(200, 'hello').end(done);
  });

  it('should pause a piped source until listening and preserve backpressure', function (done) {
    const server = http.createServer(echo);
    const listen = server.listen;
    let start;
    sinon.stub(server, 'listen').callsFake(function () {
      const args = arguments;
      start = function () { listen.apply(server, args); };
      return server;
    });
    const chunks = Array.from({ length: 8 }, function () { return Buffer.alloc(65536, 'x'); });
    const expected = Buffer.concat(chunks).toString();
    const test = request(server).post('/');
    const end = test.end;
    test.end = function () { return end.call(this, done); };
    test.expect(200, expected);
    Readable.from(chunks).pipe(test);
    process.nextTick(function () {
      test._pendingWrites.length.should.equal(1);
      should.not.exist(test.req);
      start();
    });
  });

  it('should finish exactly once when the server fails to start', function (done) {
    const server = http.createServer(echo);
    const failure = new Error('listen failed');
    sinon.stub(server, 'listen').callsFake(function () {
      process.nextTick(function () { server.emit('error', failure); });
      return server;
    });
    const test = request(server).post('/');
    test.write('hello');
    let calls = 0;
    test.end(function (err) {
      calls += 1;
      err.should.equal(failure);
      should.not.exist(test._pendingWrites);
      should.not.exist(test.req);
      process.nextTick(function () {
        calls.should.equal(1);
        done();
      });
    });
  });

  it('should discard queued writes when aborted before listening', function (done) {
    const test = request(echo).post('/');
    test.write('hello');
    test.abort();
    should.not.exist(test._pendingWrites);
    test.end(function (err) {
      err.message.should.match(/aborted/);
      test._server.listening.should.equal(false);
      done();
    });
  });

  it('should stream to HTTP/2 ephemeral servers', function (done) {
    const test = request(echo, { http2: true }).post('/');
    test.write('hello');
    test.expect(200, 'hello').end(done);
  });
  it('should retain normal buffered sends', function (done) {
    const test = request(echo).post('/');
    test.send(Buffer.from('hello'));
    test.expect(200, 'hello').end(done);
  });

  it('should close the server before the callback after queued writes', function (done) {
    const test = request(echo).post('/');
    test.write('hello');
    let closed = false;
    test._server.once('close', function () { closed = true; });
    test.expect(200, 'hello').end(function (err) {
      closed.should.equal(true);
      should.not.exist(test._pendingWrites);
      done(err);
    });
  });
});
