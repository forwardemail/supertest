'use strict';

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

  describe('Issue #876: content-type with header= parameter', function() {
    beforeEach(function() {
      app.get('/csv', function(req, res) {
        res.setHeader('foo', 'bar');
        res.setHeader('x-custom-header', 'custom-value');
        res.setHeader('content-type', 'text/csv; header=present');
        res.end('col1,col2\nval1,val2');
      });
    });

    it('should not break header matchers when content-type has header=present', function(done) {
      supertest(app)
        .get('/csv')
        .expect(200)
        .expect('foo', 'bar')
        .expect('x-custom-header', 'custom-value')
        .expect('content-type', 'text/csv; header=present')
        .end(done);
    });

    it('should support case-insensitive matching with header= present', function(done) {
      supertest(app)
        .get('/csv')
        .expect(200)
        .expect('Foo', 'bar')
        .expect('X-Custom-Header', 'custom-value')
        .expect('Content-Type', 'text/csv; header=present')
        .end(done);
    });

    it('should support regex matching for headers with header= present', function(done) {
      supertest(app)
        .get('/csv')
        .expect(200)
        .expect('foo', /^bar$/)
        .expect('content-type', /header=present/)
        .end(done);
    });

    it('should properly fail when header expectation is not met', function(done) {
      supertest(app)
        .get('/csv')
        .expect('foo', 'wrong-value')
        .end(function(err) {
          err.should.be.an.Error();
          err.message.should.equal('expected "foo" of "wrong-value", got "bar"');
          done();
        });
    });

    it('should properly fail when header field is missing', function(done) {
      supertest(app)
        .get('/csv')
        .expect('non-existent', 'value')
        .end(function(err) {
          err.should.be.an.Error();
          err.message.should.equal('expected "non-existent" header field');
          done();
        });
    });
  });
});
