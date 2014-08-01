var util = require("util"),
    nconf = require("nconf"),
    url = require("url"),
    winston = require("winston"),
    mongodb = require("mongodb"),
    request = require('request'),
    http = require('http'),
    https = require('https'),
    through = require('through'),
    httpProxy = require('http-proxy'),
    assert = require('assert'),
    tracker = undefined,
    tracker_key = undefined,
    defaults = {
        "mongo_host": "127.0.0.1",
        "mongo_db": "bouncer",
        "mongo_collection": "session_map",
        "session_cookie": "sid",
        "failover_url": "http://example.com/",
        "clean_uri_regexp": "^/logout",
        "clean_url": "http://example.com/logout",
        "listen_host": "127.0.0.1",
        "listen_port": "7990",
        "tracker_siteid": undefined,
        "log_level": "debug",
        "log_console": 0,
        "log_file": 0,
        "log_file_name": "bouncer.log",
        "debug": 1,
        "response_timeout": 120000
    };

module.exports = function(opts) {
    nconf.overrides(opts)
         .argv()
         .env()
         .file('local.json')
         .defaults(defaults);
    
    var transports = {};
    if (nconf.get('log_console'))
        transports['console'] = {
                level: nconf.get('log_level'),
                colorize: 'true',
                label: 'bouncer',
                timestamp: true
            };
    if (nconf.get('log_file'))
        transports['file'] = {
                level: null,
                timestamp: true,
                json: false,
                maxsize: 10485760,
                filename: nconf.get('log_file_name')
            };

    // Strangely not supported!
    if (Object.keys(transports).length == 0) {
        transports['file'] = {
                level: null,
                timestamp: true,
                json: false,
                maxsize: 10485760,
                filename: '/dev/null'
            };
    }

    winston.loggers.add('bouncer', transports);

    var log = winston.loggers.get('bouncer'),
        debug_level = nconf.get("debug");
    log.info("Create session bouncer");

    if (debug_level >= 2) {
        log.debug("Bouncer settings");
        for (var key in defaults) {
            log.debug(" - " + key + ": " + nconf.get(key) + (nconf.get(key) === defaults[key] ? "  (default)" : "  (overriden from: " + defaults[key] + ")"));
        }
    }

    /**
     * Set-up optional piwik tracker
     */
    if (nconf.get('tracker_siteid')) {
        log.debug("Setting up tracker");
        try {
            var PiwikTracker = require('piwik-tracker'),
                site_id = nconf.get('tracker_siteid'),
                piwik_url = nconf.get('tracker_url');

            tracker = new PiwikTracker(site_id, piwik_url);
            tracker_key = nconf.get('tracker_key');

            tracker.on('error', function(err) {
                log.error("Error occured while reporting tracking data to Piwik: ", err);
            });

            log.debug("Tracker ready: ", tracker);
        } catch(e) {
            log.fatal("Piwik tracker module is not available, but configuration is set - fatal error");
            throw e;
        }

        if (tracker == undefined)
            throw "Tracker not initialized properly";
        if (tracker_key == undefined)
            throw "No Piwik key is set! Use tracker_key config variable to set one";
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

    var track = function(req, res, options, cvars) {
        if (tracker == undefined)
            return;

        var peer = req.socket.address(),
            opts = {
                apiv: 1,
                url: req.url,
                token_auth: tracker_key,
            },
            cvar = {
                '1': ['HTTP method', req.method]
            },
            cvar_idx = 2;

        if (req.headers && ('x-real-ip' in req.headers)) {
            peer = {
                'address': req.headers['x-real-ip'],
                'port': req.headers['x-real-port']
            };
        }

        if (peer != undefined)
            opts['cip'] = peer.address;
        if (req.headers['user-agent'] != undefined)
            opts['ua'] = req.headers['user-agent'];
        if (req.headers['accept-language'] != undefined)
            opts['lang'] = req.headers['accept-language'];
        if (req.headers['referer'] != undefined)
            opts['urlref'] = req.headers['referer'];
        if (req.headers['host'] != undefined) {
            var url_opts = url.parse(req.url);
            url_opts['protocol'] = req.headers['x-secure'] != undefined && req.headers['x-secure'] == 1 ? 'https:' : 'http:';
            url_opts['host'] = req.headers['host'];

            opts['url'] = url.format(url_opts);
        }

        // Merge with user supplied options
        for(var prop in options) {
            opts[prop] = options[prop];
        }

        for(var cv in cvars) {
            cvar[cvar_idx++] = cvars[cv];
        }
        opts['cvar'] = JSON.stringify(cvar)

        log.debug("Sending tracking data");
        log.debug(opts);

        tracker.track(opts);
    };

    /**
     * Genaretes 302 response to redirect user to target URL
     */
    var redirect = function(req, res, target) {
        res.statusCode = 302;
        res.setHeader("Location", target);
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Expires", "Thu, 01 Jan 1970 00:00:00 GMT");
        res.end();

        if (tracker != undefined)
            track(req, res);
    };

    /**
     * Finally log and route connection to upstream server
     */
    var route = function(req, res, bounce, key, upstream, cache, failover) {
        var peer = req.socket.address(),
            url_parsed = url.parse(req.url),
            target = undefined;

        if (upstream != undefined) {
            target = url.resolve(upstream, req.url);
        }

        if (req.headers && ('x-real-ip' in req.headers)) {
            peer = {
                'address': req.headers['x-real-ip'],
                'port': req.headers['x-real-port']
            };
        }

        if (bounce == null && failover != null) {
            target = url.resolve(failover, req.url);
            log.info(peer.address + ':' + peer.port + ' ' + req.method + ' "' + req.url + '" -> ' + key + ' [fail] => ' + target);
            redirect(req, res, target);
            return;
        }

        if (url_parsed != null && 'path' in url_parsed && url_parsed.path != null && url_parsed.path.match(nconf.get('clean_uri_regexp'))) {
            target = nconf.get('clean_url');
            log.info(peer.address + ':' + peer.port + ' ' + req.method + ' "' + req.url + '" -> ' + key + ' [' + cache + '] => ' + target);
            redirect(req, res, target);
        } else {
            log.info(peer.address + ':' + peer.port + ' ' + req.method + ' "' + req.url + '" -> ' + key + ' [' + cache + '] -> ' + target);
            bounce(target);

            if (tracker != undefined)
                track(req, res, {}, [['upstream', upstream.host]]);
        }
    };

    /**
     * Create bouncer code
     */
    var createBouncer = function(session_map) {
        log.info("Prepare bouncer instance");
        var localMap = {},
            proxy = httpProxy.createProxyServer({}),
            server = http.createServer(function(req, res) {
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

                var bounce = function(target) {
                    proxy.web(req, res, { target: target });
                };

                if (localMap[routerKey] != null) { // First look-up in localMap
                    route(req, res, bounce, routerKey, localMap[routerKey], 'cache');
                } else { // If not found, look in remote map
                    if (debug_level >= 3)
                        log.debug("Local map not found for key: " + routerKey);
                    /* Call lookup on remote collection */
                    session_map.findOne({
                        sid: routerKey
                    }, function(err, doc) {
                        //console.log(doc);
                        if (err == null && doc != null) {
                            if (debug_level >= 3)
                                log.debug("Remote map found for key: " + routerKey + ", storing to local map");
                            localMap[routerKey] = url.parse(doc.target);
                            route(req, res, bounce, routerKey, localMap[routerKey], 'remote');
                        } else {
                            if (debug_level >= 3)
                                log.debug("Remote map not found for key: " + routerKey + " redirect to failover: " + nconf.get('failover_url'));
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
                log.error("Failed connecting to MongoDB");
                throw "Error connecting to mongo db";
            }
            log.debug("Connected to MongoDB")
            db.on("close", function() {
                log.info("Connection to the MongoDB was closed!");
            });

            log.debug("Loading session map from collection: " + nconf.get('mongo_collection'));

            var session_map = db.collection(nconf.get('mongo_collection'));
            displaySessionMap(session_map);
            //session_map.remove();
            log.info("Set up done")
            var server = createBouncer(session_map);
            cb(server, db_connector);
        });
    };

    return {
        server: undefined,
        db: undefined,
        address: function () { return this.server.address() },
        close: function () {
            var self = this;

            log.debug("Closing bouncer");
            this.server.close(function() {
                log.debug("Bouncer stopped, going to stop Mongo");
                self.db.close();
            });
            
            return;
        },
        listen: function(port, address) {
            var self = this,
                cb = undefined;

            if (typeof(port) === "function") {
                cb = port;
                port = address = undefined;
            }

            if (this.server == undefined) {
                prepareBouncer(function(srv, db) {
                    self.server = srv;
                    self.db = db;

                    address = address || nconf.get('listen_host');
                    port = port || nconf.get('listen_port');

                    log.info("Start listening on port: " + address + ':' + port);

                    srv.listen(port, address, cb);
                })
            }
            
            return this;
        }
    }
}
