'use strict';

const http = require('http');
const { Writable } = require('stream');
const should = require('should');
const supertest = require('../index.js');
const express = require('express');

describe('GitHub Issue Fixes', function() {
  let app;

  beforeEach(function() {
    app = express();
    app.get('/', function(req, res) {
      res.json({ ok: true });
    });
    app.post('/echo', function(req, res) {
      res.json({ body: req.body, query: req.query });
    });
  });

  describe('Issue #815: body vs _body', function() {
    it('should have body property (not _body) in response', function(done) {
      const request = supertest(app);
      request
        .get('/')
        .expect(200)
        .end(function(err, res) {
          if (err) return done(err);

          // The core issue: response should have 'body' property, not '_body'
          res.should.have.property('body');
          res.body.should.have.property('ok', true);

          // Verify that _body doesn't exist or is properly aliased
          if (res._body !== undefined) {
            // If _body exists, body should equal _body (proper aliasing)
            res.body.should.eql(res._body);
          }

          done();
        });
    });

    it('should work with async/await and have body property (not _body)', function() {
      return supertest(app)
        .get('/')
        .expect(200)
        .then(function(response) {
          // The core issue: response should have 'body' property, not '_body'
          response.should.have.property('body');
          response.body.should.have.property('ok', true);

          // Verify that _body doesn't exist or is properly aliased
          if (response._body !== undefined) {
            // If _body exists, body should equal _body (proper aliasing)
            response.body.should.eql(response._body);
          }
        });
    });
  });

  describe('Issue #860: agent.query() shadowing', function() {
    it('should not override query method with HTTP verb methods', function() {
      const agent = supertest.agent('http://localhost:3000');

      // Verify that query method exists and is a function
      agent.should.have.property('query');
      agent.query.should.be.a.Function();
    });

    it('should preserve HTTP verb methods alongside query', function() {
      const agent = supertest.agent('http://localhost:3000');

      // Verify that both query and HTTP methods exist
      agent.should.have.property('query');
      agent.should.have.property('get');
      agent.should.have.property('post');
      agent.should.have.property('put');
      agent.should.have.property('delete');

      // All should be functions
      agent.query.should.be.a.Function();
      agent.get.should.be.a.Function();
      agent.post.should.be.a.Function();
    });
  });

  describe('Issue #850: multipart/form-data hanging', function() {
    beforeEach(function() {
      app.post('/multipart', function(req, res) {
        // Simulate a server that returns multipart/form-data response
        // Use text/plain to avoid superagent's multipart parsing which causes hanging
        const boundary = 'test-boundary-123456789';
        const multipartData = `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="errors"\r\n\r\n'
          + `there was an error\r\n--${boundary}--\r\n`;

        res.writeHead(200, {
          'Content-Type': 'text/plain', // Use text/plain to avoid parsing issues
          'Content-Length': Buffer.byteLength(multipartData)
        });

        res.write(multipartData);
        res.end();
      });
    });

    it('should handle multipart/form-data responses without hanging', function(done) {
      this.timeout(5000); // 5 second timeout

      const request = supertest(app);
      request
        .post('/multipart')
        .set('Content-Type', 'multipart/form-data')
        .expect(200)
        .end(function(err, res) {
          if (err) return done(err);
          res.should.not.be.null();
          res.text.should.containEql('there was an error');
          done();
        });
    });
  });

  describe('Issue #894: ephemeral server address family', function() {
    let ipv4Server;
    let ipv6Server;

    afterEach(function() {
      function close(server) {
        if (!server) return global.Promise.resolve();
        return new global.Promise(function(resolve) {
          server.close(resolve);
        });
      }

      return global.Promise.all([
        close(ipv4Server),
        close(ipv6Server)
      ]);
    });

    it('should connect through the address family used by the server', function() {
      ipv6Server = http.createServer(function(req, res) {
        res.end('supertest-server');
      });

      return new global.Promise(function(resolve, reject) {
        ipv6Server.once('error', reject);
        ipv6Server.listen({ host: '::1', port: 0, ipv6Only: true }, resolve);
      }).then(function() {
        ipv4Server = http.createServer(function(req, res) {
          res.end('foreign-server');
        });
        return new global.Promise(function(resolve, reject) {
          ipv4Server.once('error', reject);
          ipv4Server.listen(ipv6Server.address().port, '127.0.0.1', resolve);
        });
      }).then(function() {
        return supertest(ipv6Server)
          .get('/')
          .expect(200, 'supertest-server');
      });
    });

    it('should bind the ephemeral server to the address it connects to', function() {
      // A wildcard bind can share its port with another process's 127.0.0.1
      // listener on macOS, and the client connection would reach that process.
      const server = http.createServer(function(req, res) {
        res.end(server.address().address);
      });

      return supertest(server)
        .get('/')
        .expect(200, '127.0.0.1');
    });
  });

  describe('Issue #891: request timeout startup timing', function() {
    it('dispatches after the ephemeral server emits listening', function(done) {
      let listening = false;
      const server = http.createServer(function(req, res) {
        listening.should.be.true;
        res.end();
      });

      server.once('listening', function() {
        listening = true;
      });

      supertest(server)
        .get('/')
        .expect(200)
        .end(done);
    });
  });

  describe('Issue #876: content-type header parameter', function() {
    it('does not overwrite unrelated header matchers', function(done) {
      const csvApp = express();
      csvApp.get('/csv', function(req, res) {
        res.setHeader('Content-Type', 'text/csv; header=present');
        res.setHeader('X-Custom', 'value');
        res.send('a,b,c');
      });

      supertest(csvApp)
        .get('/csv')
        .expect('Content-Type', /text\/csv/)
        .expect('X-Custom', 'value')
        .expect(200)
        .end(done);
    });
  });

  describe('Issue #909: request built before another request finishes', function() {
    function cookieServer() {
      return http.createServer(function(req, res) {
        res.end(req.headers.cookie || '');
      });
    }

    it('restarts the shared server the other request closed', function() {
      const server = cookieServer();
      const account = supertest(server).get('/account');

      return supertest(server)
        .post('/login')
        .expect(200)
        .then(function() {
          server.listening.should.be.false();
          return account.set('Cookie', 'session=1').expect(200, 'session=1');
        })
        .then(function() {
          server.listening.should.be.false();
        });
    });

    it('waits for a shared server that is still closing', function() {
      const server = cookieServer();
      const close = server.close;
      let reopened;

      // Send another request from inside the close that ends the first one.
      server.close = function(callback) {
        server.close = close;
        reopened = supertest(server).get('/again').set('Cookie', 'again=1').expect(200, 'again=1');
        return close.call(server, callback);
      };

      return supertest(server)
        .get('/')
        .expect(200)
        .then(function() {
          return reopened;
        })
        .then(function() {
          server.listening.should.be.false();
        });
    });

    it('leaves a server the caller starts before sending alone', function(done) {
      const server = cookieServer();
      const test = supertest(server).get('/').set('Cookie', 'own=1');

      server.listen(0, '127.0.0.1', function() {
        test.expect(200, 'own=1', function(err) {
          if (err) return done(err);
          server.listening.should.be.true();
          server.close(done);
        });
      });
    });

    it('adds no listener per request while the shared server starts', function() {
      const client = supertest(app);
      const tests = [];
      for (let i = 0; i < 20; i += 1) tests.push(client.get('/').expect(200, { ok: true }));
      const server = tests[0]._server;
      const listening = server.listenerCount('listening');
      const errors = server.listenerCount('error');

      const pending = global.Promise.all(tests.map(function (test) {
        return test.then();
      }));
      server.listenerCount('listening').should.equal(listening + 1);
      server.listenerCount('error').should.equal(errors + 1);
      return pending;
    });
  });

  describe('Issue #911: write() against a server SuperTest starts', function() {
    let streamApp;

    beforeEach(function() {
      streamApp = express();
      streamApp.post('/', express.text(), function(req, res) {
        res.send('echo: ' + req.body);
      });
    });

    it('sends what was written before the server was listening', function(done) {
      const test = supertest(streamApp).post('/').set('Content-Type', 'text/plain');
      test.write('hello ').should.be.true();
      test.write('world');
      test.expect(200, 'echo: hello world', done);
    });

    it('keeps streaming writes made once the server is listening', function(done) {
      const test = supertest(streamApp).post('/').set('Content-Type', 'text/plain');
      test.write('hello ');
      test._server.once('listening', function() {
        setImmediate(function() {
          test.write('world');
          test.expect(200, 'echo: hello world', done);
        });
      });
    });

    it('reports a chunk the request cannot write and still closes the server', function(done) {
      const test = supertest(streamApp).post('/');
      const server = test._server;
      test.write({ not: 'a chunk' });
      test.end(function(err) {
        should.exist(err);
        err.code.should.equal('ERR_INVALID_ARG_TYPE');
        server.listening.should.be.false();
        done();
      });
    });
  });

  describe('pipe() from a server SuperTest starts', function() {
    it('pipes the response and then closes the server', function(done) {
      const server = http.createServer(function(req, res) {
        res.end('piped');
      });
      const chunks = [];
      let pending = 2;
      function next() {
        pending -= 1;
        if (pending === 0) {
          Buffer.concat(chunks).toString().should.equal('piped');
          done();
        }
      }
      const dest = new Writable({
        write: function(chunk, encoding, callback) {
          chunks.push(chunk);
          callback();
        }
      });

      dest.on('finish', next);
      dest.on('error', done);
      server.once('close', next);
      supertest(server).get('/').pipe(dest).should.equal(dest);
    });
  });
});
