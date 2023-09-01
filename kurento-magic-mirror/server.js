/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser');
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var http = require('http');
var https = require('https');

/* Stunner demo patch starts */
var iceConfiguration;
var stnr_auth_addr = "stunner-auth.stunner-system.svc.cluster.local";
var stnr_auth_port = "8088";
if ("STUNNER_AUTH_ADDR" in process.env) {
  stnr_auth_addr = process.env.STUNNER_AUTH_ADDR;
}
if ("STUNNER_AUTH_PORT" in process.env) {
  stnr_auth_port = process.env.STUNNER_AUTH_PORT;
}


// Generate 'index.js' from 'index.js.template' with the correct STUNner configuration
var client_file = 'static/js/index.js';
var template_file = 'static/js/index.js.template'

// Periodic update of index.js
function queryIceConfig(name) {
    let query = {
        pathname: '/ice',
        query: {
            service: "turn",
            username: name,
            iceTransportPolicy: "relay",
        },
    };
    // filter on namespace, gateway and listener
    if("STUNNER_NAMESPACE" in process.env) {
        query.query.namespace = process.env.STUNNER_NAMESPACE;
    }
    if("STUNNER_GATEWAY" in process.env) {
        query.query.gateway = process.env.STUNNER_GATEWAY;
    }
    if("STUNNER_LISTENER" in process.env) {
        query.query.listener = process.env.STUNNER_LISTENER;
    }

    let options = {
        host: stnr_auth_addr,
        port: stnr_auth_port,
        method: 'GET',
        path: url.format(query),
    };

    return options;
}

function updateIceConfigurationIndexJS(){
    // copy template to client file
    fs.copyFile(template_file, client_file, (err) => {
        if (err) throw err;
    });

    // Replace STUNner config
    file_desc = fs.readFile(client_file, 'utf-8', function(err,data) {
        if (err) {
            return console.log(err);
        }
        if (iceConfiguration){
            data = data.replace("XXXXXX", JSON.stringify(iceConfiguration));
            fs.writeFile(client_file, data, 'utf-8', function(err) {
                if (err) {
                    return console.log(err);
                }
            });
            console.log("Stunner public IP found: ", JSON.stringify(iceConfiguration));
        }
    });
}

// At the time of client connection, static/js/index.js must hold the correct ice config.
function checkIceConfigurationWithDelay(){
    function onError(error) {
        console.log("error: " + error);
    }

    try {
        let options = queryIceConfig("user-1");
        var iceConfData = '';
        var request_data = http.request(options, function (res) {
            var response = '';
            res.on('data', function (chunk) {
                response += chunk;
                console.log('on data response'+ response);
            });
            res.on('end', function () {
                iceConfData += response;
                iceConfiguration = JSON.parse(iceConfData);
                if (iceConfiguration){
                    console.log("Found ICE config from STUNner auth service.");
                    updateIceConfigurationIndexJS();
                }
            });
            res.on('error', function (err) {
                console.log(err);
                return onError("HTTP response error when querying the STUNner auth service with params " +
                               JSON.stringify(options) + ": " + err);
            });
        });
        request_data.on('error', function (err) {
            console.log(err);
            return onError("HTTP error when querying the STUNner auth service with params " +
                           JSON.stringify(options) + ": " + err);
        });
        request_data.end();
    } catch(exception) {
        onError(exception);
        return onError("Exception when querying the STUNner auth service with params " +
                           JSON.stringify(options) + ": " + exception);
    }
}

setInterval(checkIceConfigurationWithDelay, 5000);
/* Stunner demo patch ends */

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento',
        overlay_uri: 'http://overlay-image.default.svc.cluster.local:80/img/mario-wings.png'
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Management of sessions
 */
app.use(cookieParser());

var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});

app.use(sessionHandler);

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};
var kurentoClient = null;

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('STUNnerTutorial started: Kurento magic mirror');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/magicmirror'
});

// serve the overlay image for the Kurento media server
http.createServer(function (req, res) {
    let file = __dirname + "/static/" + req.url;
    console.log("Serving overlay image:", file);
    fs.readFile(file, function (err,data) {
        if (err) {
            res.writeHead(404);
            res.end(JSON.stringify(err));
            return;
        }
        res.writeHead(200);
        res.end(data);
    });
}).listen(80);

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws, req) {
    var sessionId = null;
    var request = req;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, function(err) {
        sessionId = request.session.id;
        console.log('Connection received with sessionId ' + sessionId);
    });

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'start':
            sessionId = request.session.id;
            start(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                }
                ws.send(JSON.stringify({
                    id : 'startResponse',
                    sdpAnswer : sdpAnswer
                }));
            });
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function start(sessionId, ws, sdpOffer, callback) {
    if (!sessionId) {
        return callback('Cannot use undefined sessionId');
    }

    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            createMediaElements(pipeline, ws, function(error, webRtcEndpoint, faceOverlayFilter) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                connectMediaElements(webRtcEndpoint, faceOverlayFilter, function(error) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    webRtcEndpoint.on('IceCandidateFound', function(event) {
                        var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });

                    webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        sessions[sessionId] = {
                            'pipeline' : pipeline,
                            'webRtcEndpoint' : webRtcEndpoint
                        }
                        return callback(null, sdpAnswer);
                    });

                    webRtcEndpoint.gatherCandidates(function(error) {
                        if (error) {
                            return callback(error);
                        }
                    });
                });
            });
        });
    });
}

function createMediaElements(pipeline, ws, callback) {
    pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
        if (error) {
            return callback(error);
        }

        pipeline.create('FaceOverlayFilter', function(error, faceOverlayFilter) {
            if (error) {
                return callback(error);
            }

            // const appServerUrl = url.format(asUrl);
            console.log("Using overlay image URI:", argv.overlay_uri);
            faceOverlayFilter.setOverlayedImage(argv.overlay_uri,
                    -0.35, -1.2, 1.6, 1.6, function(error) {
                if (error) {
                    return callback(error);
                }

                return callback(null, webRtcEndpoint, faceOverlayFilter);
            });
        });
    });
}

function connectMediaElements(webRtcEndpoint, faceOverlayFilter, callback) {
    webRtcEndpoint.connect(faceOverlayFilter, function(error) {
        if (error) {
            return callback(error);
        }

        faceOverlayFilter.connect(webRtcEndpoint, function(error) {
            if (error) {
                return callback(error);
            }

            return callback(null);
        });
    });
}

function stop(sessionId) {
    if (sessions[sessionId]) {
        var pipeline = sessions[sessionId].pipeline;
        console.info('Releasing pipeline');
        pipeline.release();

        delete sessions[sessionId];
        delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    if (sessions[sessionId]) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
