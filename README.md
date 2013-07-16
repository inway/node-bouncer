node-bouncer
============

Bounce incoming requests to many backend servers based on session id mapping.
[![Build Status](https://secure.travis-ci.org/InWayOpenSource/node-bouncer.png)](http://travis-ci.org/InWayOpenSource/node-bouncer)

Features
--------
* Routes all requests based on session key from cookie
* Can be configured through local.json
* Session-host map stored on MongoDB and cached locally
* Requires login site to set session cookie and mapping

Usage
---------------

At first you should install all necessary dependencies with:

```CLI
$ npm install
```

or by hand by consulting [package.json](package.json). 
When this is complete you can run ```./bin/bouncer.js```.

License
-------

This software is Copyright (c) 2013 Sebastian Podjasek
and licensed under the MIT license. See the LICENSE file for 
more details.
