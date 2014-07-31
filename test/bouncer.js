var test = require('tap').test,
    http = require('http'),
    net = require('net'),
    url = require('url'),
    bouncer = require('../');

test('bouncer', function (t) {
    var s0 = http.createServer(function (req, res) {
        res.setHeader('content-type', 'text/plain');
        res.write('allowed');
        res.end();
    });
    s0.listen(9901, connect);
    
    var s1 = bouncer({}).listen(connect);
    
    var connected = 0;
    function connect () {
        if (++connected !== 2) return;

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

            s0.close();
            s1.close();
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
    }
});

test('tracker', function(t) {
    // Target server
    var s0 = http.createServer(function (req, res) {
        res.setHeader('content-type', 'text/plain');
        res.write('track');
        res.end();
    });
    s0.listen(9901, setup);

    // Tracker server
    var s1 = http.createServer(function (req, res) {
        var u = url.parse(req.url);

        t.equal(req.method, 'GET', "Tracker received a report");
        t.equal(u.pathname, '/tracker', "Tracker received a report to a proper path");

        res.setHeader('content-type', 'text/plain');
        res.write('allowed');
        res.end();

        handle_end();
    });
    s1.listen(setup);

    var pending = 2;

    var handle_end = function() {
        if (--pending > 0) return;

        s0.close();
        s1.close();
        s2.close();
        t.end();
    };
    
    var s2;
    
    var started = 0;
    function setup() {
        console.log('setup==');
        if (++started !== 2) return;
        
        s2 = bouncer({
            "tracker_siteid": "6",
            "tracker_url": "http://localhost:" + s1.address().port + "/tracker",
            "tracker_key": "abcdefghijklmnopqrstuvwxyz1234567890"
        }).listen(connect);
    }
    
    function connect() {
        console.log("connect");
        var opts = {
            method : 'GET',
            host : 'localhost',
            port : s2.address().port,
            path : '/allow',
            headers : {
                    connection : 'close',
                    cookie     : 'sid=abcdefghijklmnopqrstuvwxyz'
                }
        };

        var req = http.request(opts, function (res) {
            t.equal(res.statusCode, 200, "Tracking request should be accepted with 200");
            t.equal(res.headers['content-type'], 'text/plain', "Tracking request Content-Type should be text/plain");

            var data = '';
            res.on('data', function (buf) {
                data += buf.toString();
            });

            res.on('end', function () {
                t.equal(data, 'track', "Tracking request should return 'track' string in response");
                handle_end();
            });
        });
        req.end();
    }
});