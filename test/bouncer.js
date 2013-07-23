var test = require('tap').test;
var http = require('http');
var net = require('net');
var bouncer = require('../');

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

        var pending = 2;

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
            t.equal(res.statusCode, 302)

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
            t.equal(res.statusCode, 200)
            t.equal(res.headers['content-type'], 'text/plain');

            var data = '';
            res.on('data', function (buf) {
                data += buf.toString();
            });

            res.on('end', function () {
                t.equal(data, 'allowed');
                handle_end();
            });
        });
        req.end();
    }
});
