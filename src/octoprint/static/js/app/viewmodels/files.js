$(function() {
    function FilesViewModel(parameters) {
        var self = this;

        self.settingsViewModel = parameters[0];
        self.loginState = parameters[1];
        self.printerState = parameters[2];
        self.slicing = parameters[3];

        self.isErrorOrClosed = ko.observable(undefined);
        self.isOperational = ko.observable(undefined);
        self.isPrinting = ko.observable(undefined);
        self.isPaused = ko.observable(undefined);
        self.isError = ko.observable(undefined);
        self.isReady = ko.observable(undefined);
        self.isLoading = ko.observable(undefined);
        self.isSdReady = ko.observable(undefined);

        self.searchQuery = ko.observable(undefined);
        self.searchQuery.subscribe(function() {
            self.performSearch();
        });

        self.freeSpace = ko.observable(undefined);
        self.totalSpace = ko.observable(undefined);
        self.freeSpaceString = ko.pureComputed(function() {
            if (!self.freeSpace())
                return "-";
            return formatSize(self.freeSpace());
        });
        self.totalSpaceString = ko.pureComputed(function() {
            if (!self.totalSpace())
                return "-";
            return formatSize(self.totalSpace());
        });

        self.diskusageWarning = ko.pureComputed(function() {
            return self.freeSpace() != undefined
                && self.freeSpace() < self.settingsViewModel.server_diskspace_warning();
        });
        self.diskusageCritical = ko.pureComputed(function() {
            return self.freeSpace() != undefined
                && self.freeSpace() < self.settingsViewModel.server_diskspace_critical();
        });
        self.diskusageString = ko.pureComputed(function() {
            if (self.diskusageCritical()) {
                return gettext("Your available free disk space is critically low.");
            } else if (self.diskusageWarning()) {
                return gettext("Your available free disk space is starting to run low.");
            } else {
                return gettext("Your current disk usage.");
            }
        });

        self.uploadButton = undefined;
        self.sdUploadButton = undefined;
        self.uploadProgressBar = undefined;
        self.localTarget = undefined;
        self.sdTarget = undefined;

        self.uploadProgressText = ko.observable();

        self._uploadInProgress = false;

        // initialize list helper
        self.listHelper = new ItemListHelper(
            "gcodeFiles",
            {
                "name": function(a, b) {
                    // sorts ascending
                    if (a["name"].toLocaleLowerCase() < b["name"].toLocaleLowerCase()) return -1;
                    if (a["name"].toLocaleLowerCase() > b["name"].toLocaleLowerCase()) return 1;
                    return 0;
                },
                "upload": function(a, b) {
                    // sorts descending
                    if (b["date"] === undefined || a["date"] > b["date"]) return -1;
                    if (a["date"] < b["date"]) return 1;
                    return 0;
                },
                "size": function(a, b) {
                    // sorts descending
                    if (b["size"] === undefined || a["size"] > b["size"]) return -1;
                    if (a["size"] < b["size"]) return 1;
                    return 0;
                }
            },
            {
                "printed": function(file) {
                    return !(file["prints"] && file["prints"]["success"] && file["prints"]["success"] > 0);
                },
                "sd": function(file) {
                    return file["origin"] && file["origin"] == "sdcard";
                },
                "local": function(file) {
                    return !(file["origin"] && file["origin"] == "sdcard");
                },
                "machinecode": function(file) {
                    return file["type"] && file["type"] == "machinecode";
                },
                "model": function(file) {
                    return file["type"] && file["type"] == "model";
                }
            },
            "name",
            [],
            [["sd", "local"], ["machinecode", "model"]],
            0
        );

        self.isLoadActionPossible = ko.pureComputed(function() {
            return self.loginState.isUser() && !self.isPrinting() && !self.isPaused() && !self.isLoading();
        });

        self.isLoadAndPrintActionPossible = ko.pureComputed(function() {
            return self.loginState.isUser() && self.isOperational() && self.isLoadActionPossible();
        });

        self.printerState.filename.subscribe(function(newValue) {
            self.highlightFilename(newValue);
        });

        self.highlightFilename = function(filename) {
            if (filename == undefined) {
                self.listHelper.selectNone();
            } else {
                self.listHelper.selectItem(function(item) {
                    return item.name == filename;
                });
            }
        };

        self.fromCurrentData = function(data) {
            self._processStateData(data.state);
        };

        self.fromHistoryData = function(data) {
            self._processStateData(data.state);
        };

        self._processStateData = function(data) {
            self.isErrorOrClosed(data.flags.closedOrError);
            self.isOperational(data.flags.operational);
            self.isPaused(data.flags.paused);
            self.isPrinting(data.flags.printing);
            self.isError(data.flags.error);
            self.isReady(data.flags.ready);
            self.isLoading(data.flags.loading);
            self.isSdReady(data.flags.sdReady);
        };

        self._otherRequestInProgress = undefined;
        self._focus = undefined;
        self._switchToPath = undefined;
        self.requestData = function(params) {
            var focus, switchToPath, force;

            if (_.isObject(params)) {
                focus = params.focus;
                switchToPath = params.switchToPath;
                force = params.force
            } else if (arguments.length) {
                // old argument list type call signature
                log.warn("FilesViewModel.requestData called with old argument list. That is deprecated, please use parameter object instead.");
                if (arguments.length >= 1) {
                    if (arguments.length >= 2) {
                        focus = {location: arguments[1], path: arguments[0]};
                    } else {
                        focus = {location: "local", path: arguments[0]};
                    }
                }
                if (arguments.length >= 3) {
                    switchToPath = arguments[2];
                }
                if (arguments.length >= 4) {
                    force = arguments[3];
                }
            }

            self._focus = self._focus || focus;
            self._switchToPath = self._switchToPath || switchToPath;

            if (self._otherRequestInProgress !== undefined) {
                return self._otherRequestInProgress
            }

            return self._otherRequestInProgress = OctoPrint.files.list(true, force)
                .done(function(response) {
                    self.fromResponse(response, {focus: self._focus, switchToPath: self._switchToPath});
                })
                .always(function() {
                    self._otherRequestInProgress = undefined;
                    self._focus = undefined;
                    self._switchToPath = undefined;
                });
        };

        self.fromResponse = function(response, params) {
            var focus = undefined;
            var switchToPath;

            if (_.isObject(params)) {
                focus = params.focus || undefined;
                switchToPath = params.switchToPath || undefined;
            } else if (arguments.length > 1) {
                log.warn("FilesViewModel.requestData called with old argument list. That is deprecated, please use parameter object instead.");
                if (arguments.length > 2) {
                    focus = {location: arguments[2], path: arguments[1]};
                } else {
                    focus = {location: "local", path: arguments[1]};
                }
                if (arguments.length > 3) {
                    switchToPath = arguments[3] || undefined;
                }
            }

            var files = response.files;

            self.allItems(files);

            if (!switchToPath) {
                var currentPath = self.currentPath();
                if (currentPath === undefined) {
                    self.listHelper.updateItems(files);
                    self.currentPath("");
                } else {
                    // if we have a current path, make sure we stay on it
                    self.changeFolderByPath(currentPath);
                }
            } else {
                self.changeFolderByPath(switchToPath);
            }

            if (focus) {
                // got a file to scroll to
                var entryElement = self.getEntryElement({path: focus.path, origin: focus.location});
                if (entryElement) {
                    // scroll to uploaded element
                    var entryOffset = entryElement.offsetTop;
                    $(".gcode_files").slimScroll({
                        scrollTo: entryOffset + "px"
                    });

                    // highlight uploaded element
                    var element = $(entryElement);
                    element.on("webkitAnimationEnd oanimationend msAnimationEnd animationend", function(e) {
                        // remove highlight class again
                        element.removeClass("highlight");
                    });
                    element.addClass("highlight");
                }
            }

            if (response.free != undefined) {
                self.freeSpace(response.free);
            }

            if (response.total != undefined) {
                self.totalSpace(response.total);
            }

            self.highlightCurrentFilename();
        };

        self.changeFolder = function(data) {
            self.currentPath(data.path);
            self.listHelper.updateItems(data.children);
            self.highlightCurrentFilename();
        };

        self.navigateUp = function() {
            var path = self.currentPath().split("/");
            path.pop();
            self.changeFolderByPath(path.join("/"));
        };

        self.changeFolderByPath = function(path) {
            var element = self.elementByPath(path);
            if (element) {
                self.currentPath(path);
                self.listHelper.updateItems(element.children);
            } else{
                self.currentPath("");
                self.listHelper.updateItems(self.allItems());
            }
            self.highlightCurrentFilename();
        };

        self.showAddFolderDialog = function() {
            if (self.addFolderDialog) {
                self.addFolderName("");
                self.addFolderDialog.modal("show");
            }
        };

        self.addFolder = function() {
            var name = self.addFolderName();

            // "local" only for now since we only support local and sdcard,
            // and sdcard doesn't support creating folders...
            var location = "local";

            self.ignoreUpdatedFilesEvent = true;
            self.addingFolder(true);
            OctoPrint.files.createFolder(location, name, self.currentPath())
                .done(function(data) {
                    self.requestData({
                        focus: {
                            path: data.folder.name,
                            location: data.folder.origin
                        }
                    })
                        .done(function() {
                            self.addFolderDialog.modal("hide");
                        })
                        .always(function() {
                            self.addingFolder(false);
                        });
                })
                .fail(function() {
                    self.addingFolder(false);
                })
                .always(function() {
                    self.ignoreUpdatedFilesEvent = false;
                });
        };

        self.removeFolder = function(folder, event) {
            if (!folder) {
                return;
            }

            if (folder.type != "folder") {
                return;
            }

            if (folder.weight > 0) {
                // confirm recursive delete
                var options = {
                    message: _.sprintf(gettext("You are about to delete the folder \"%(folder)s\" which still contains files and/or sub folders."), {folder: folder.name}),
                    onproceed: function() {
                        self._removeEntry(folder, event);
                    }
                };
                showConfirmationDialog(options);
            } else {
                self._removeEntry(folder, event);
            }
        };

        self.loadFile = function(file, printAfterLoad) {
            if (!file) {
                return;
            }
            var withinPrintDimensions = self.evaluatePrintDimensions(file, true);
            var print = printAfterLoad && withinPrintDimensions;

            OctoPrint.files.select(file.origin, file.path, print);
        };

            $.ajax({
                url: file.refs.resource,
                type: "POST",
                dataType: "json",
                contentType: "application/json; charset=UTF-8",
                data: JSON.stringify({command: "select", print: printAfterLoad})
            });
        };

        self.removeFile = function(file) {
            if (!file || !file.refs || !file.refs.hasOwnProperty("resource")) return;

            $.ajax({
                url: file.refs.resource,
                type: "DELETE",
                success: function() {
                    self.requestData();
                }
            });
        };

        self.sliceFile = function(file) {
            if (!file) return;

            self.slicing.show(file.origin, file.name, true);
        };

        self.initSdCard = function() {
            self._sendSdCommand("init");
        };

        self.releaseSdCard = function() {
            self._sendSdCommand("release");
        };

        self.refreshSdFiles = function() {
            self._sendSdCommand("refresh");
        };

        self._removeEntry = function(entry, event) {
            self.activeRemovals.push(entry.origin + ":" + entry.path);
            var finishActiveRemoval = function() {
                self.activeRemovals(_.filter(self.activeRemovals(), function(e) {
                    return e != entry.origin + ":" + entry.path;
                }));
            };

            var activateSpinner = function(){},
                finishSpinner = function(){};

            if (event) {
                var element = $(event.currentTarget);
                if (element.length) {
                    var icon = $("i.icon-trash", element);
                    if (icon.length) {
                        activateSpinner = function() {
                            icon.removeClass("icon-trash").addClass("icon-spinner icon-spin");
                        };
                        finishSpinner = function() {
                            icon.removeClass("icon-spinner icon-spin").addClass("icon-trash");
                        };
                    }
                }
            }

            activateSpinner();

            var deferred = $.Deferred();
            OctoPrint.files.delete(entry.origin, entry.path)
                .done(function() {
                    self.requestData()
                        .done(function() {
                            deferred.resolve();
                        })
                        .fail(function() {
                            deferred.reject();
                        });
                })
                .fail(function() {
                    deferred.reject();
                });

            return deferred.promise()
                .always(function() {
                    finishActiveRemoval();
                    finishSpinner();
                });
        };

        self.downloadLink = function(data) {
            if (data["refs"] && data["refs"]["download"]) {
                return data["refs"]["download"];
            } else {
                return false;
            }
        };

        self.lastTimePrinted = function(data) {
            if (data["prints"] && data["prints"]["last"] && data["prints"]["last"]["date"]) {
                return data["prints"]["last"]["date"];
            } else {
                return "-";
            }
        };

        self.getSuccessClass = function(data) {
            if (!data["prints"] || !data["prints"]["last"]) {
                return "";
            }
            return data["prints"]["last"]["success"] ? "text-success" : "text-error";
        };

        self.templateFor = function(data) {
            return "files_template_" + data.type;
        };

        self.getEntryId = function(data) {
            return "gcode_file_" + md5(data["origin"] + ":" + data["path"]);
        };

        self.getEntryElement = function(data) {
            var entryId = self.getEntryId(data);
            var entryElements = $("#" + entryId);
            if (entryElements && entryElements[0]) {
                return entryElements[0];
            } else {
                return undefined;
            }
        };

        self.enableRemove = function(data) {
            return self.loginState.isUser() && !_.contains(self.printerState.busyFiles(), data.origin + ":" + data.name);
        };

        self.enableSelect = function(data, printAfterSelect) {
            var isLoadActionPossible = self.loginState.isUser() && self.isOperational() && !(self.isPrinting() || self.isPaused() || self.isLoading());
            return isLoadActionPossible && !self.listHelper.isSelected(data);
        };

        self.enableSlicing = function(data) {
            return self.loginState.isUser() && self.slicing.enableSlicingDialog() && self.slicing.enableSlicingDialogForFile(data.name);
        };

        self.enableAdditionalData = function(data) {
            return data["gcodeAnalysis"] || data["prints"] && data["prints"]["last"];
        };

        self.toggleAdditionalData = function(data) {
            var entryElement = self.getEntryElement(data);
            if (!entryElement) return;

            var additionalInfo = $(".additionalInfo", entryElement);
            additionalInfo.slideToggle("fast", function() {
                $(".toggleAdditionalData i", entryElement).toggleClass("icon-chevron-down icon-chevron-up");
            });
        };

        self.getAdditionalData = function(data) {
            var output = "";
            if (data["gcodeAnalysis"]) {
                if (data["gcodeAnalysis"]["dimensions"]) {
                    var dimensions = data["gcodeAnalysis"]["dimensions"];
                    output += gettext("Model size") + ": " + _.sprintf("%(width).2fmm &times; %(depth).2fmm &times; %(height).2fmm", dimensions);
                    output += "<br>";
                }
                if (data["gcodeAnalysis"]["filament"] && typeof(data["gcodeAnalysis"]["filament"]) == "object") {
                    var filament = data["gcodeAnalysis"]["filament"];
                    if (_.keys(filament).length == 1) {
                        output += gettext("Filament") + ": " + formatFilament(data["gcodeAnalysis"]["filament"]["tool" + 0]) + "<br>";
                    } else if (_.keys(filament).length > 1) {
                        for (var toolKey in filament) {
                            if (!_.startsWith(toolKey, "tool") || !filament[toolKey] || !filament[toolKey].hasOwnProperty("length") || filament[toolKey]["length"] <= 0) continue;

                            output += gettext("Filament") + " (" + gettext("Tool") + " " + toolKey.substr("tool".length) + "): " + formatFilament(filament[toolKey]) + "<br>";
                        }
                    }
                }
                output += gettext("Estimated print time") + ": " + formatFuzzyPrintTime(data["gcodeAnalysis"]["estimatedPrintTime"]) + "<br>";
            }
            if (data["prints"] && data["prints"]["last"]) {
                output += gettext("Last printed") + ": " + formatTimeAgo(data["prints"]["last"]["date"]) + "<br>";
                if (data["prints"]["last"]["printTime"]) {
                    output += gettext("Last print time") + ": " + formatDuration(data["prints"]["last"]["printTime"]);
                }
            }
            return output;
        };

        self.evaluatePrintDimensions = function(data, notify) {
            if (!self.settingsViewModel.feature_modelSizeDetection()) {
                return true;
            }

            var analysis = data["gcodeAnalysis"];
            if (!analysis) {
                return true;
            }

            var printingArea = data["gcodeAnalysis"]["printingArea"];
            if (!printingArea) {
                return true;
            }

            var printerProfile = self.printerProfiles.currentProfileData();
            if (!printerProfile) {
                return true;
            }

            var volumeInfo = printerProfile.volume;
            if (!volumeInfo) {
                return true;
            }

            // set print volume boundaries
            var boundaries;
            if (_.isPlainObject(volumeInfo.custom_box)) {
                boundaries = {
                    minX : volumeInfo.custom_box.x_min(),
                    minY : volumeInfo.custom_box.y_min(),
                    minZ : volumeInfo.custom_box.z_min(),
                    maxX : volumeInfo.custom_box.x_max(),
                    maxY : volumeInfo.custom_box.y_max(),
                    maxZ : volumeInfo.custom_box.z_max()
                }
            } else {
                boundaries = {
                    minX : 0,
                    maxX : volumeInfo.width(),
                    minY : 0,
                    maxY : volumeInfo.depth(),
                    minZ : 0,
                    maxZ : volumeInfo.height()
                };
                if (volumeInfo.origin() == "center") {
                    boundaries["maxX"] = volumeInfo.width() / 2;
                    boundaries["minX"] = -1 * boundaries["maxX"];
                    boundaries["maxY"] = volumeInfo.depth() / 2;
                    boundaries["minY"] = -1 * boundaries["maxY"];
                }
            }

            // model not within bounds, we need to prepare a warning
            var warning = "<p>" + _.sprintf(gettext("Object in %(name)s exceeds the print volume of the currently selected printer profile, be careful when printing this."), data) + "</p>";
            var info = "";

            var formatData = {
                profile: boundaries,
                object: printingArea
            };

            // find exceeded dimensions
            if (printingArea["minX"] < boundaries["minX"] || printingArea["maxX"] > boundaries["maxX"]) {
                info += gettext("Object exceeds print volume in width.<br>");
            }
            if (printingArea["minY"] < boundaries["minY"] || printingArea["maxY"] > boundaries["maxY"]) {
                info += gettext("Object exceeds print volume in depth.<br>");
            }
            if (printingArea["minZ"] < boundaries["minZ"] || printingArea["maxZ"] > boundaries["maxZ"]) {
                info += gettext("Object exceeds print volume in height.<br>");
            }

            //warn user
            if (info != "") {
                if (notify) {
                    info += _.sprintf(gettext("Object's bounding box: (%(object.minX).2f, %(object.minY).2f, %(object.minZ).2f) &times; (%(object.maxX).2f, %(object.maxY).2f, %(object.maxZ).2f)"), formatData);
                    info += "<br>";
                    info += _.sprintf(gettext("Print volume: (%(profile.minX).2f, %(profile.minY).2f, %(profile.minZ).2f) &times; (%(profile.maxX).2f, %(profile.maxY).2f, %(profile.maxZ).2f)"), formatData);

                    warning += pnotifyAdditionalInfo(info);

                    warning += "<p><small>You can disable this check via Settings &gt; Features &gt; \"Enable model size detection [...]\"</small></p>";

                    new PNotify({
                        title: gettext("Object doesn't fit print volume"),
                        text: warning,
                        type: "warning",
                        hide: false
                    });
                }
                return false;
            } else {
                return true;
            }
        };

        self.performSearch = function(e) {
            var query = self.searchQuery();
            if (query !== undefined && query.trim() != "") {
                query = query.toLocaleLowerCase();
                self.listHelper.changeSearchFunction(function(entry) {
                    return entry && entry["name"].toLocaleLowerCase().indexOf(query) > -1;
                });
            } else {
                self.listHelper.resetSearch();
            }

            return false;
        };

        self.onUserLoggedIn = function(user) {
            self.uploadButton.fileupload("enable");
        };

        self.onUserLoggedOut = function() {
            self.uploadButton.fileupload("disable");
        };

        self.onStartup = function() {
            $(".accordion-toggle[data-target='#files']").click(function() {
                var files = $("#files");
                if (files.hasClass("in")) {
                    files.removeClass("overflow_visible");
                } else {
                    setTimeout(function() {
                        files.addClass("overflow_visible");
                    }, 100);
                }
            });

            $(".gcode_files").slimScroll({
                height: "306px",
                size: "5px",
                distance: "0",
                railVisible: true,
                alwaysVisible: true,
                scrollBy: "102px"
            });

            //~~ Gcode upload

            self.uploadButton = $("#gcode_upload");
            self.sdUploadButton = $("#gcode_upload_sd");

            self.uploadProgress = $("#gcode_upload_progress");
            self.uploadProgressBar = $(".bar", self.uploadProgress);

            if (CONFIG_SD_SUPPORT) {
                self.localTarget = $("#drop_locally");
            } else {
                self.localTarget = $("#drop");
                self.listHelper.removeFilter('sd');
            }
            self.sdTarget = $("#drop_sd");

            self.loginState.isUser.subscribe(function(newValue) {
                self._enableLocalDropzone(newValue);
            });
            self._enableLocalDropzone(self.loginState.isUser());

            if (CONFIG_SD_SUPPORT) {
                self.printerState.isSdReady.subscribe(function(newValue) {
                    self._enableSdDropzone(newValue === true && self.loginState.isUser());
                });

                self.loginState.isUser.subscribe(function(newValue) {
                    self._enableSdDropzone(newValue === true && self.printerState.isSdReady());
                });

                self._enableSdDropzone(self.printerState.isSdReady() && self.loginState.isUser());
            }

            self.requestData();
        };

        self.onEventUpdatedFiles = function(payload) {
            if (self._uploadInProgress) {
                return;
            }

            if (payload.type !== "gcode") {
                return;
            }

            self.requestData();
        };

        self.onEventSlicingStarted = function(payload) {
            self.uploadProgress
                .addClass("progress-striped")
                .addClass("active");
            self.uploadProgressBar.css("width", "100%");
            if (payload.progressAvailable) {
                self.uploadProgressText(_.sprintf(gettext("Slicing ... (%(percentage)d%%)"), {percentage: 0}));
            } else {
                self.uploadProgressText(gettext("Slicing ..."));
            }
        };

        self.onSlicingProgress = function(slicer, modelPath, machinecodePath, progress) {
            self.uploadProgressText(_.sprintf(gettext("Slicing ... (%(percentage)d%%)"), {percentage: Math.round(progress)}));
        };

        self.onEventSlicingCancelled = function(payload) {
            self.uploadProgress
                .removeClass("progress-striped")
                .removeClass("active");
            self.uploadProgressBar
                .css("width", "0%");
            self.uploadProgressText("");
        };

        self.onEventSlicingDone = function(payload) {
            self.uploadProgress
                .removeClass("progress-striped")
                .removeClass("active");
            self.uploadProgressBar
                .css("width", "0%");
            self.uploadProgressText("");

            new PNotify({
                title: gettext("Slicing done"),
                text: _.sprintf(gettext("Sliced %(stl)s to %(gcode)s, took %(time).2f seconds"), payload),
                type: "success"
            });

            self.requestData();
        };

        self.onEventSlicingFailed = function(payload) {
            self.uploadProgress
                .removeClass("progress-striped")
                .removeClass("active");
            self.uploadProgressBar
                .css("width", "0%");
            self.uploadProgressText("");

            var html = _.sprintf(gettext("Could not slice %(stl)s to %(gcode)s: %(reason)s"), payload);
            new PNotify({title: gettext("Slicing failed"), text: html, type: "error", hide: false});
        };

        self.onEventMetadataAnalysisFinished = function(payload) {
            self.requestData();
        };

        self.onEventMetadataStatisticsUpdated = function(payload) {
            self.requestData();
        };

        self.onEventTransferStarted = function(payload) {
            self.uploadProgress
                .addClass("progress-striped")
                .addClass("active");
            self.uploadProgressBar
                .css("width", "100%");
            self.uploadProgressText(gettext("Streaming ..."));
        };

        self.onEventTransferDone = function(payload) {
            self.uploadProgress
                .removeClass("progress-striped")
                .removeClass("active");
            self.uploadProgressBar
                .css("width", "0");
            self.uploadProgressText("");

            new PNotify({
                title: gettext("Streaming done"),
                text: _.sprintf(gettext("Streamed %(local)s to %(remote)s on SD, took %(time).2f seconds"), payload),
                type: "success"
            });

            self.requestData({focus: {location: "sdcard", path: payload.remote}});
        };

        self.onServerConnect = self.onServerReconnect = function(payload) {
            self._enableDragNDrop(true);
            self.requestData();
        };

        self.onServerDisconnect = function(payload) {
            self._enableDragNDrop(false);
        };

        self._enableLocalDropzone = function(enable) {
            var options = {
                url: API_BASEURL + "files/local",
                dataType: "json",
                dropZone: enable ? self.localTarget : null,
                submit: self._handleUploadStart,
                done: self._handleUploadDone,
                fail: self._handleUploadFail,
                always: self._handleUploadAlways,
                progressall: self._handleUploadProgress
            };
            self.uploadButton.fileupload(options);
        };

        self._enableSdDropzone = function(enable) {
            var options = {
                url: API_BASEURL + "files/sdcard",
                dataType: "json",
                dropZone: enable ? self.sdTarget : null,
                submit: self._handleUploadStart,
                done: self._handleUploadDone,
                fail: self._handleUploadFail,
                always: self._handleUploadAlways,
                progressall: self._handleUploadProgress
            };
            self.sdUploadButton.fileupload(options);
        };

        self._enableDragNDrop = function(enable) {
            if (enable) {
                $(document).bind("dragover", self._handleDragNDrop);
                log.debug("Enabled drag-n-drop");
            } else {
                $(document).unbind("dragover", self._handleDragNDrop);
                log.debug("Disabled drag-n-drop");
            }
        };

        self._handleUploadStart = function(e, data) {
            self._uploadInProgress = true;
            return true;
        };

        self._handleUploadDone = function(e, data) {
            var focus = undefined;
            if (data.result.files.hasOwnProperty("sdcard")) {
                focus = {location: "sdcard", path: data.result.files.sdcard.path};
            } else if (data.result.files.hasOwnProperty("local")) {
                focus = {location: "local", path: data.result.files.local.path};
            }
            self.requestData({focus: focus})
                .done(function() {
                    if (data.result.done) {
                        self.uploadProgressBar
                            .css("width", "0%");
                        self.uploadProgressText("");
                        self.uploadProgress
                            .removeClass("progress-striped")
                            .removeClass("active");
                    }
                });

            if (focus && _.endsWith(focus.path.toLowerCase(), ".stl")) {
                self.slicing.show(focus.location, focus.path);
            }
        };

        self._handleUploadFail = function(e, data) {
            var extensions = _.map(SUPPORTED_EXTENSIONS, function(extension) {
                return extension.toLowerCase();
            }).sort();
            extensions = extensions.join(", ");
            var error = "<p>"
                + _.sprintf(gettext("Could not upload the file. Make sure that it is a valid file with one of these extensions: %(extensions)s"),
                            {extensions: extensions})
                + "</p>";
            error += pnotifyAdditionalInfo("<pre>" + data.jqXHR.responseText + "</pre>");
            new PNotify({
                title: "Upload failed",
                text: error,
                type: "error",
                hide: false
            });
            self.uploadProgressBar
                .css("width", "0%");
            self.uploadProgressText("");
            self.uploadProgress
                .removeClass("progress-striped")
                .removeClass("active");
        };

        self._handleUploadAlways = function(e, data) {
            self._uploadInProgress = false;
        };

        self._handleUploadProgress = function(e, data) {
            var progress = parseInt(data.loaded / data.total * 100, 10);

            self.uploadProgressBar
                .css("width", progress + "%");
            self.uploadProgressText(gettext("Uploading ..."));

            if (progress >= 100) {
                self.uploadProgress
                    .addClass("progress-striped")
                    .addClass("active");
                self.uploadProgressText(gettext("Saving ..."));
            }
        };

        self._handleDragNDrop = function (e) {
            var dropOverlay = $("#drop_overlay");
            var dropZone = $("#drop");
            var dropZoneLocal = $("#drop_locally");
            var dropZoneSd = $("#drop_sd");
            var dropZoneBackground = $("#drop_background");
            var dropZoneLocalBackground = $("#drop_locally_background");
            var dropZoneSdBackground = $("#drop_sd_background");
            var timeout = window.dropZoneTimeout;

            if (!timeout) {
                dropOverlay.addClass('in');
            } else {
                clearTimeout(timeout);
            }

            var foundLocal = false;
            var foundSd = false;
            var found = false;
            var node = e.target;
            do {
                if (dropZoneLocal && node === dropZoneLocal[0]) {
                    foundLocal = true;
                    break;
                } else if (dropZoneSd && node === dropZoneSd[0]) {
                    foundSd = true;
                    break;
                } else if (dropZone && node === dropZone[0]) {
                    found = true;
                    break;
                }
                node = node.parentNode;
            } while (node != null);

            if (foundLocal) {
                dropZoneLocalBackground.addClass("hover");
                dropZoneSdBackground.removeClass("hover");
            } else if (foundSd && self.printerState.isSdReady()) {
                dropZoneSdBackground.addClass("hover");
                dropZoneLocalBackground.removeClass("hover");
            } else if (found) {
                dropZoneBackground.addClass("hover");
            } else {
                if (dropZoneLocalBackground) dropZoneLocalBackground.removeClass("hover");
                if (dropZoneSdBackground) dropZoneSdBackground.removeClass("hover");
                if (dropZoneBackground) dropZoneBackground.removeClass("hover");
            }

            window.dropZoneTimeout = setTimeout(function () {
                window.dropZoneTimeout = null;
                dropOverlay.removeClass("in");
                if (dropZoneLocal) dropZoneLocalBackground.removeClass("hover");
                if (dropZoneSd) dropZoneSdBackground.removeClass("hover");
                if (dropZone) dropZoneBackground.removeClass("hover");
            }, 100);
        }
    }

    OCTOPRINT_VIEWMODELS.push({
        construct: FilesViewModel,
        name: "filesViewModel",
        additionalNames: ["gcodeFilesViewModel"],
        dependencies: ["settingsViewModel", "loginStateViewModel", "printerStateViewModel", "slicingViewModel", "printerProfilesViewModel"],
        elements: ["#files_wrapper", "#add_folder_dialog"],
    });
});
