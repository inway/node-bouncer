var util = require("util"),
    nconf = require("nconf"),
    url = require("url"),
    winston = require("winston"),
    mongodb = require("mongodb"),
    request = require('request'),
    http = require('http'),
    https = require('https'),
    through = require('through'),
    bouncy = require('bouncy'),
    assert = require('assert'),
    defaults = {
        "mongo_host": "127.0.0.1",
        "mongo_db": "bouncer",
        "mongo_collection": "session_map",
        "session_cookie": "sid",
        "failover_url": "http://example.com",
        "clean_uri_regexp": "^/logout",
        "clean_url": "http://example.com/logout",
        "listen_host": "127.0.0.1",
        "listen_port": "7990",
        "log_level": "debug",
        "response_timeout": 120000
    };

module.exports = function(opts) {
    nconf.overrides(opts)
         .argv()
         .env()
         .file('local.json')
         .defaults(defaults);
    
    winston.loggers.add('bouncer', {
        console: {
            level: nconf.get('log_level'),
            colorize: 'true',
            label: 'bouncer',
            timestamp: true
        },
        file: {
            level: null,
            timestamp: true,
            json: false,
            maxsize: 10485760,
            filename: 'bouncer.log'
        }
    });
    var log = winston.loggers.get('bouncer');
    log.info("Create session bouncer");
    log.debug("Bouncer settings");
    for (var key in defaults) {
        log.debug(" - " + key + ": " + nconf.get(key) + (nconf.get(key) === defaults[key] ? "  (default)" : "  (overriden from: " + defaults[key] + ")"));
    }
    
    /**
     * Display session map contents
     */
    var displaySessionMap = function(session_map) {
        log.debug("Display remote session map");
        var cursor = session_map.find();
        cursor.each(function(err, doc) {
            if (err != null) {
                throw "Error while iterating over cursor: " + err;
            }
            if (doc != null) {
                log.debug(" - " + doc.sid + " => " + doc.target);
            }
        });
    };
    
    /**
     * Genaretes 302 response to redirect user to target URL
     */
    var redirect = function(res, target) {
        res.statusCode = 302;
        res.setHeader("Location", target);
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Expires", "Thu, 01 Jan 1970 00:00:00 GMT");
        res.end();
    };
    
    /**
     * Finally log and route connection to upstream server
     */
    var route = function(req, res, bounce, key, upstream, cache, failover) {
        var peer = req.socket.address(),
            url_parsed = url.parse(req.url),
            target = url.resolve(upstream, req.url);
    
        if (req.headers && ('x-real-ip' in req.headers)) {
            peer = {
                'address': req.headers['x-real-ip'],
                'port': req.headers['x-real-port']
            };
        }
    
        if (bounce == null && target != null) {
            target = url.resolve(failover, req.url);
            log.info(peer.address + ':' + peer.port + ' ' + req.method + ' "' + req.url + '" -> ' + key + ' [fail] => ' + target);
            redirect(res, target);
            return;
        }
    
        if (url_parsed != null && 'path' in url_parsed && url_parsed.path != null && url_parsed.path.match(nconf.get('clean_uri_regexp'))) {
            target = nconf.get('clean_url');
            log.info(peer.address + ':' + peer.port + ' ' + req.method + ' "' + req.url + '" -> ' + key + ' [' + cache + '] => ' + target);
            redirect(res, target);
        } else {
            log.info(peer.address + ':' + peer.port + ' ' + req.method + ' "' + req.url + '" -> ' + key + ' [' + cache + '] -> ' + target);
            bounce(target);
        }
    };
    
    /**
     * Create bouncer code
     */
    var createBouncer = function(session_map) {
        log.info("Prepare bouncer instance");
        var localMap = {},
            server = bouncy({socketTimeout: nconf.get("response_timeout")}, function(req, res, bounce) {
                var routerKey = req.headers.host;
                var cookies = {};
                req.headers && ('cookie' in req.headers) && req.headers.cookie.split(';').forEach(function(cookie) {
                    var parts = cookie.match(/(.*?)=(.*)$/)
                    cookies[parts[1].trim()] = (parts[2] || '').trim();
                });
                if (cookies[nconf.get('session_cookie')] != null) {
                    routerKey = cookies[nconf.get('session_cookie')];
                } else {
                    log.error("No cookie received in request");
                    for (var item in req.headers) {
                        log.debug("  " + item + ": " + req.headers[item]);
                    }
                }
                //console.log(cookies);
                //console.log("Request routing key: " + routerKey);
                if (localMap[routerKey] != null) { // First look-up in localMap
                    route(req, res, bounce, routerKey, localMap[routerKey], 'cache');
                } else { // If not found, look in remote map
                    //console.log("Local map not found for key: " + routerKey);
                    /* Call lookup on remote collection */
                    session_map.findOne({
                        sid: routerKey
                    }, function(err, doc) {
                        //console.log(doc);
                        if (err == null && doc != null) {
                            //console.log("Remote map found for key: " + routerKey + ", storing to local map");
                            localMap[routerKey] = url.parse(doc.target);
                            route(req, res, bounce, routerKey, localMap[routerKey], 'remote');
                        } else {
                            //console.log("Remote map not found for key: " + routerKey);
                            route(req, res, null, routerKey, null, null, nconf.get('failover_url'));
                        }
                    });
                }
            });
        return server;
    };

    /**
     * Prepare bouncer dependencies and then create bouncer
     */
    var prepareBouncer = function(cb) {
        log.info("Set up mongo server " + nconf.get('mongo_host') + "/" + nconf.get('mongo_db'));
        
        var mongoserver = new mongodb.Server(nconf.get('mongo_host'), mongodb.Connection.DEFAULT_PORT, {
                auto_reconnect: true
            }),
            db_connector = new mongodb.Db(nconf.get('mongo_db'), mongoserver, {
                safe: false
            });

        /*
         * Open MongoDB at start
         */
        db_connector.open(function(err, db) {
            if (err != null) {
                log.fatal("Failed connecting to MongoDB");
                exit();
            }
            log.debug("Connected to MongoDB")
            db.on("close", function(error) {
                log.fatal("Connection to the MongoDB was closed!");
                exit();
            });
        
            log.debug("Loading session map from collection: " + nconf.get('mongo_collection'));
        
            var session_map = db.collection(nconf.get('mongo_collection'));
            displaySessionMap(session_map);
            //session_map.remove();
            log.info("Set up done")
            var server = createBouncer(session_map);
            cb(server);
        });
    };

    return {
        server: undefined,
        listen: function(port, address) {
            var self = this;
            if (self.server == undefined) {
                prepareBouncer(function(srv) {
                    self.server = srv;
                    
                    address = address || nconf.get('listen_host');
                    port = port || nconf.get('listen_port');
                    
                    log.info("Start listening on port: " + address + ':' + port);
                    
                    srv.listen(port, address);
                })
            }
        }
    }
}
