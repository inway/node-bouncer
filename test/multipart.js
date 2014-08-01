var test = require('tap').test,
    http = require('http'),
    net = require('net'),
    url = require('url'),
    bouncer = require('../');

test('multipart', function (t) {
    var s0 = http.createServer(function (req, res) {
        var body = "";

        req.on('data', function(chunk) {
            body += chunk.toString();
        });

        req.on('end', function() {
            res.setHeader('content-type', 'text/plain');
            res.write("" + body.length + "\r\n");
            res.end();
        });
    });
    s0.listen(9901, connect);
    
    var s1 = bouncer({}).listen(connect);
    
    var connected = 0;
    function connect () {
        if (++connected !== 2) return;

        var pending = 1,
            separator = '----sep',
            dataLength = 128 * 1024;

        var handle_end = function(data) {
            if (--pending > 0) return;
            var received = parseInt(data, 10);

            t.ok(received > dataLength, "should receive at least " + dataLength + " of data (got: " + received + ")");

            s0.close();
            s1.close();
            t.end();
        };

        var opts = {
            method : 'POST',
            host : 'localhost',
            port : s1.address().port,
            path : '/upload',
            headers : {
                connection : 'close',
                cookie : 'sid=abcdefghijklmnopqrstuvwxyz',
                'Content-Type' : 'multipart/form-data; boundary=' + separator,
            }
        };
        console.log("bouncer on port: " + opts.port);

        var req = http.request(opts, function (res) {
            t.equal(res.statusCode, 200, "We should get some reply in reasonable time");

            var data = '';
            res.on('data', function (buf) {
                data += buf.toString();
            });

            res.on('end', function() {
                handle_end(data)
            });
        });
        req.write('--' + separator + '\r\n');
        req.write('Content-Disposition: form-data; name="file"; filename="file.bin"\r\n');
        req.write('Content-Type: application/octet-stream\r\n');
        req.write('Content-Transfer-Encoding: binary\r\n\r\n');
        var chunkSize = 128,
            chunk = new Array(chunkSize + 1).join("a");
        for (var i = 0; i <= dataLength; i+= chunkSize) {
            var c = chunk;
            if (i + chunkSize > dataLength) {
                c = chunk.substring(0, dataLength-i);
            }
            req.write(c);
        }
        req.end('\r\n--' + separator + '--');
    }
});