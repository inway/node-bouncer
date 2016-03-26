var test = require('tap').test,
    http = require('http'),
    net = require('net'),
    url = require('url'),
    bouncer = require('../'),
    s0,
    s1,
    s2;

var proceed = function() {
    test('setup', function(t) {
        var started = 0;

        // Target server
        s0 = http.createServer(function (req, res) {
            res.setHeader('content-type', 'text/plain');
            res.write('track');
            res.end();
        });
        s0.listen(9901, setup);

        // Tracker server
        s1 = http.createServer(function (req, res) {
            var u = url.parse(req.url);

            t.equal(req.method, 'GET', "Tracker received a report");
            t.equal(u.pathname, '/tracker', "Tracker received a report to a proper path");

            res.setHeader('content-type', 'text/plain');
            res.setHeader('connection', 'close'); // piwik-tracker by default uses keep-alive connection which breaks tests
            res.write('allowed');
            res.end();
        });
        s1.listen(setup);

        var started = 0;
        function setup() {
            if (++started !== 2) return;

            t.pass('all utility servers started');

            s2 = bouncer({
                "tracker_siteid": "6",
                "tracker_url": "http://localhost:" + s1.address().port + "/tracker",
                "tracker_key": "abcdefghijklmnopqrstuvwxyz1234567890"
            }).listen(function() {
                t.pass('bouncer started');
                t.end();
            });
        }
    });

    test('tracker', function(t) {
        var pending = 1;

        var handle_end = function() {
            if (--pending > 0) return;

            t.pass('all tests run');
            t.end();
        };

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
    });

    test('teardown', function(t) {
        s2.close(function() {
            t.pass('bouncer closed, stopping utility');

            s0.close(function() {
                t.pass("target closed, stop tracker");

                s1.close(function () {
                    t.pass("tracker stopped");
                    t.end();
                });
            });
        });
    });
}

test('check', function(t) {
    try {
        require('piwik-tracker');
        proceed();
    } catch(e) {
        t.pass('no module found');
    }
    t.end();
});
