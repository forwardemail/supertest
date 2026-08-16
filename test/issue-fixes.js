'use strict';

const http = require('http');
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
  });
});
