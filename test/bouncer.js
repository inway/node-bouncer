var test = require('tap').test,
    http = require('http'),
    net = require('net'),
    url = require('url'),
    bouncer = require('../'),
    s0,
    s1;

test('setup', function(t) {
    var connected = 0;

    s0 = http.createServer(function (req, res) {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('connection', 'close');
        res.write('allowed');
        res.end();
    });
    s0.listen(9901, connect);
    
    s1 = bouncer({}).listen(connect);
    
    function connect () {
        if (++connected !== 2) return;

        t.pass('servers set-up');
        t.end();
    }
});

test('bouncer', function (t) {
    var pending = 3;

    var opts = {
        method : 'GET',
        host : 'localhost',
        port : s1.address().port,
        path : '/deny',
        headers : { connection : 'close' }
    };
    
    var handle_end = function() {
        if (--pending > 0) return;

        t.pass('all tests done');
        t.end();
    };
    
    var req = http.request(opts, function (res) {
        t.equal(res.statusCode, 302, "First request should be denied & redirected with 302");

        var data = '';
        res.on('data', function (buf) {
            data += buf.toString();
        });

        res.on('end', handle_end);
    });
    req.end();

    opts.path = '/allow';
    opts.headers.cookie = 'sid=abcdefghijklmnopqrstuvwxyz';
    req = http.request(opts, function (res) {
        t.equal(res.statusCode, 200, "Second request should be accepted with 200");
        t.equal(res.headers['content-type'], 'text/plain', "Second request Content-Type should be text/plain");

        var data = '';
        res.on('data', function (buf) {
            data += buf.toString();
        });

        res.on('end', function () {
            t.equal(data, 'allowed', "Second request should return 'allowed' string in response");
            handle_end();
        });
    });
    req.end();

    opts.path = '/logout';
    req = http.request(opts, function (res) {
        t.equal(res.statusCode, 302, "Last request should properly logout with 302 status code");

        var data = '';
        res.on('data', function (buf) {
            data += buf.toString();
        });

        res.on('end', handle_end);
    });
    req.end();
});

test('teardown', function(t) {
    s1.close(function() {
        t.pass('bouncer stopped, close utility');

        s0.close(function() {
            t.pass('utility stopped');
            t.end();
        });
    });
});
