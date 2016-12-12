function DataUpdater(allViewModels) {
    var self = this;

    self.allViewModels = allViewModels;

    self._socket = undefined;
    self._autoReconnecting = false;
    self._autoReconnectTrial = 0;
    self._autoReconnectTimeouts = [0, 1, 1, 2, 3, 5, 8, 13, 20, 40, 100];
    self._autoReconnectDialogIndex = 1;

    self._pluginHash = undefined;

    self._throttleFactor = 1;
    self._baseProcessingLimit = 500.0;
    self._lastProcessingTimes = [];
    self._lastProcessingTimesSize = 20;

    self._safeModePopup = undefined;

    self.increaseThrottle = function() {
        self.setThrottle(self._throttleFactor + 1);
    };

    self.decreaseThrottle = function() {
        if (self._throttleFactor <= 1) {
            return;
        }
        self.setThrottle(self._throttleFactor - 1);
    };

    self.setThrottle = function(throttle) {
        self._throttleFactor = throttle;

        self._send("throttle", self._throttleFactor);
        log.debug("DataUpdater: New SockJS throttle factor:", self._throttleFactor, " new processing limit:", self._baseProcessingLimit * self._throttleFactor);
    };

    self._send = function(message, data) {
        var payload = {};
        payload[message] = data;
        self._socket.send(JSON.stringify(payload));
    };

    self._onconnect = function() {
        self._autoReconnecting = false;
        self._autoReconnectTrial = 0;
    };

    self._onclose = function(e) {
        if (e.code == SOCKJS_CLOSE_NORMAL) {
            return;
        }
        if (self._autoReconnectTrial >= self._autoReconnectDialogIndex) {
            // Only consider it a real disconnect if the trial number has exceeded our threshold.

            var handled = false;
            _.each(self.allViewModels, function(viewModel) {
                if (handled == true) {
                    return;
                }

                if (viewModel.hasOwnProperty("onServerDisconnect")) {
                    var result = viewModel.onServerDisconnect();
                    if (result !== undefined && !result) {
                        handled = true;
                    }
                }
            });

            if (handled) {
                return;
            }

            showOfflineOverlay(
                gettext("Server is offline"),
                gettext("The server appears to be offline, at least I'm not getting any response from it. I'll try to reconnect automatically <strong>over the next couple of minutes</strong>, however you are welcome to try a manual reconnect anytime using the button below."),
                self.reconnect
            );
        }

        if (self._autoReconnectTrial < self._autoReconnectTimeouts.length) {
            var timeout = self._autoReconnectTimeouts[self._autoReconnectTrial];
            log.info("Reconnect trial #" + self._autoReconnectTrial + ", waiting " + timeout + "s");
            setTimeout(self.reconnect, timeout * 1000);
            self._autoReconnectTrial++;
        } else {
            self._onreconnectfailed();
        }
    };

    self._onreconnectfailed = function() {
        var handled = false;
        _.each(self.allViewModels, function(viewModel) {
            if (handled == true) {
                return;
            }

            if (viewModel.hasOwnProperty("onServerDisconnect")) {
                var result = viewModel.onServerDisconnect();
                if (result !== undefined && !result) {
                    handled = true;
                }
            }
        });

        if (handled) {
            return;
        }

        $("#offline_overlay_title").text(gettext("Server is offline"));
        $("#offline_overlay_message").html(gettext("The server appears to be offline, at least I'm not getting any response from it. I <strong>could not reconnect automatically</strong>, but you may try a manual reconnect using the button below."));
    };

    self._onConnected = function(event) {
        var data = event.data;

        // update version information
        var oldVersion = VERSION;
        VERSION = data["version"];
        DISPLAY_VERSION = data["display_version"];
        BRANCH = data["branch"];
        $("span.version").text(DISPLAY_VERSION);

        // update plugin hash
        var oldPluginHash = self._pluginHash;
        self._pluginHash = data["plugin_hash"];

        // update config hash
        var oldConfigHash = self._configHash;
        self._configHash = data["config_hash"];

        // process safe mode
        if (self._safeModePopup) self._safeModePopup.remove();
        if (data["safe_mode"]) {
            // safe mode is active, let's inform the user
            log.info("Safe mode is active. Third party plugins are disabled and cannot be enabled.");

            self._safeModePopup = new PNotify({
                title: gettext("Safe mode is active"),
                text: gettext("The server is currently running in safe mode. Third party plugins are disabled and cannot be enabled."),
                hide: false
            });
        }

        // if the offline overlay is still showing, now's a good time to
        // hide it, plus reload the camera feed if it's currently displayed
        if ($("#offline_overlay").is(":visible")) {
            hideOfflineOverlay();
            callViewModels(self.allViewModels, "onServerReconnect");
            callViewModels(self.allViewModels, "onDataUpdaterReconnect");
        } else {
            callViewModels(self.allViewModels, "onServerConnect");
        }

        // if the version, the plugin hash or the config hash changed, we
        // want the user to reload the UI since it might be stale now
        var versionChanged = oldVersion != VERSION;
        var pluginsChanged = oldPluginHash != undefined && oldPluginHash != self._pluginHash;
        var configChanged = oldConfigHash != undefined && oldConfigHash != self._configHash;
        if (versionChanged || pluginsChanged || configChanged) {
            showReloadOverlay();
        }

        log.info("Connected to the server");

        // if we have a connected promise, resolve it now
        if (self._connectedDeferred) {
            self._connectedDeferred.resolve();
            self._connectedDeferred = undefined;
        }
    };

    self._onHistoryData = function(event) {
        callViewModels(self.allViewModels, "fromHistoryData", [event.data]);
    };

    self._onCurrentData = function(event) {
        callViewModels(self.allViewModels, "fromCurrentData", [event.data]);
    };

    self._onSlicingProgress = function(event) {
        $("#gcode_upload_progress").find(".bar").text(_.sprintf(gettext("Slicing ... (%(percentage)d%%)"), {percentage: Math.round(event.data["progress"])}));

            var data = e.data[prop];

            var start = new Date().getTime();
            switch (prop) {
                case "connected": {
                    // update the current UI API key and send it with any request
                    UI_API_KEY = data["apikey"];
                    $.ajaxSetup({
                        headers: {"X-Api-Key": UI_API_KEY}
                    });

                    var oldVersion = VERSION;
                    VERSION = data["version"];
                    DISPLAY_VERSION = data["display_version"];
                    BRANCH = data["branch"];
                    $("span.version").text(DISPLAY_VERSION);

                    var oldPluginHash = self._pluginHash;
                    self._pluginHash = data["plugin_hash"];

                    if ($("#offline_overlay").is(":visible")) {
                        hideOfflineOverlay();
                        _.each(self.allViewModels, function(viewModel) {
                            if (viewModel.hasOwnProperty("onServerReconnect")) {
                                viewModel.onServerReconnect();
                            } else if (viewModel.hasOwnProperty("onDataUpdaterReconnect")) {
                                viewModel.onDataUpdaterReconnect();
                            }
                        });

                        if ($('#tabs li[class="active"] a').attr("href") == "#control") {
                            $("#webcam_image").attr("src", CONFIG_WEBCAM_STREAM + "?" + new Date().getTime());
                        }
                    } else {
                        _.each(self.allViewModels, function(viewModel) {
                            if (viewModel.hasOwnProperty("onServerConnect")) {
                                viewModel.onServerConnect();
                            }
                        });
                    }

                    if (oldVersion != VERSION || (oldPluginHash != undefined && oldPluginHash != self._pluginHash)) {
                        showReloadOverlay();
                    }

                    self.setThrottle(1);

                    log.info("Connected to the server");

                    if (self._connectCallback) {
                        self._connectCallback();
                        self._connectCallback = undefined;
                    }

                    break;
                }
                case "history": {
                    _.each(self.allViewModels, function(viewModel) {
                        if (viewModel.hasOwnProperty("fromHistoryData")) {
                            viewModel.fromHistoryData(data);
                        }
                    });
                    break;
                }
                case "current": {
                    _.each(self.allViewModels, function(viewModel) {
                        if (viewModel.hasOwnProperty("fromCurrentData")) {
                            viewModel.fromCurrentData(data);
                        }
                    });
                    break;
                }
                case "slicingProgress": {
                    _.each(self.allViewModels, function(viewModel) {
                        if (viewModel.hasOwnProperty("onSlicingProgress")) {
                            viewModel.onSlicingProgress(data["slicer"], data["model_path"], data["machinecode_path"], data["progress"]);
                        }
                    });
                    break;
                }
                case "event": {
                    var type = data["type"];
                    var payload = data["payload"];

                    log.debug("Got event " + type + " with payload: " + JSON.stringify(payload));

                    if (type == "PrintCancelled") {
                        if (payload.firmwareError) {
                            new PNotify({
                                title: gettext("Unhandled communication error"),
                                text: _.sprintf(gettext("There was an unhandled error while talking to the printer. Due to that the ongoing print job was cancelled. Error: %(firmwareError)s"), payload),
                                type: "error",
                                hide: false
                            });
                        }
                    } else if (type == "Error") {
                        new PNotify({
                                title: gettext("Unhandled communication error"),
                                text: _.sprintf(gettext("There was an unhandled error while talking to the printer. Due to that OctoPrint disconnected. Error: %(error)s"), payload),
                                type: "error",
                                hide: false
                        });
                    }

                    var legacyEventHandlers = {
                        "UpdatedFiles": "onUpdatedFiles",
                        "MetadataStatisticsUpdated": "onMetadataStatisticsUpdated",
                        "MetadataAnalysisFinished": "onMetadataAnalysisFinished",
                        "SlicingDone": "onSlicingDone",
                        "SlicingCancelled": "onSlicingCancelled",
                        "SlicingFailed": "onSlicingFailed"
                    };
                    _.each(self.allViewModels, function(viewModel) {
                        if (viewModel.hasOwnProperty("onEvent" + type)) {
                            viewModel["onEvent" + type](payload);
                        } else if (legacyEventHandlers.hasOwnProperty(type) && viewModel.hasOwnProperty(legacyEventHandlers[type])) {
                            // there might still be code that uses the old callbacks, make sure those still get called
                            // but log a warning
                            log.warn("View model " + viewModel.name + " is using legacy event handler " + legacyEventHandlers[type] + ", new handler is called " + legacyEventHandlers[type]);
                            viewModel[legacyEventHandlers[type]](payload);
                        }
                    });

                    break;
                }
                case "timelapse": {
                    _.each(self.allViewModels, function(viewModel) {
                        if (viewModel.hasOwnProperty("fromTimelapseData")) {
                            viewModel.fromTimelapseData(data);
                        }
                    });
                    break;
                }
                case "plugin": {
                    _.each(self.allViewModels, function(viewModel) {
                        if (viewModel.hasOwnProperty("onDataUpdaterPluginMessage")) {
                            viewModel.onDataUpdaterPluginMessage(data.plugin, data.data);
                        }
                    })
                }
            }

            var end = new Date().getTime();
            var difference = end - start;

            while (self._lastProcessingTimes.length >= self._lastProcessingTimesSize) {
                self._lastProcessingTimes.shift();
            }
            self._lastProcessingTimes.push(difference);

            var processingLimit = self._throttleFactor * self._baseProcessingLimit;
            if (difference > processingLimit) {
                self.increaseThrottle();
                log.debug("We are slow (" + difference + " > " + processingLimit + "), reducing refresh rate");
            } else if (self._throttleFactor > 1) {
                var maxProcessingTime = Math.max.apply(null, self._lastProcessingTimes);
                var lowerProcessingLimit = (self._throttleFactor - 1) * self._baseProcessingLimit;
                if (maxProcessingTime < lowerProcessingLimit) {
                    self.decreaseThrottle();
                    log.debug("We are fast (" + maxProcessingTime + " < " + lowerProcessingLimit + "), increasing refresh rate");
                }
            }
        }
    };
}
