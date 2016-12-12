#!/usr/bin/env python
import sys
import logging as log

#~~ version

from ._version import get_versions
__version__ = get_versions()['version']
del get_versions

#~~ try to ensure a sound SSL environment

urllib3_ssl = True
"""Whether requests/urllib3 and urllib3 (if installed) should be able to establish
   a sound SSL environment or not."""

version_info = sys.version_info
if version_info.major == 2 and version_info.minor <= 7 and version_info.micro < 9:
	try:
		# make sure our requests version of urllib3 is properly patched (if possible)
		import requests.packages.urllib3.contrib.pyopenssl
		requests.packages.urllib3.contrib.pyopenssl.inject_into_urllib3()
	except ImportError:
		urllib3_ssl = False

	try:
		import urllib3

		# only proceed if urllib3 is even installed on its own
		try:
			# urllib3 is there, let's patch that too
			import urllib3.contrib.pyopenssl
			urllib3.contrib.pyopenssl.inject_into_urllib3()
		except ImportError:
			urllib3_ssl = False
	except ImportError:
		pass

del version_info

#~~ custom exceptions

class FatalStartupError(BaseException):
	pass

#~~ init methods to bring up platform

def init_platform(basedir, configfile, use_logging_file=True, logging_file=None,
                  logging_config=None, debug=False, verbosity=0, uncaught_logger=None,
                  uncaught_handler=None, safe_mode=False, after_preinit_logging=None,
                  after_settings=None, after_logging=None, after_safe_mode=None):
	kwargs = dict()

	logger, recorder = preinit_logging(debug, verbosity, uncaught_logger, uncaught_handler)
	kwargs["logger"] = logger
	kwargs["recorder"] = recorder

	if callable(after_preinit_logging):
		after_preinit_logging(**kwargs)

	settings = init_settings(basedir, configfile)
	kwargs["settings"] = settings
	if callable(after_settings):
		after_settings(**kwargs)

	logger = init_logging(settings,
	                      use_logging_file=use_logging_file,
	                      logging_file=logging_file,
	                      default_config=logging_config,
	                      debug=debug,
	                      verbosity=verbosity,
	                      uncaught_logger=uncaught_logger,
	                      uncaught_handler=uncaught_handler)
	kwargs["logger"] = logger

	if callable(after_logging):
		after_logging(**kwargs)

	settings_safe_mode = settings.getBoolean(["server", "startOnceInSafeMode"])
	safe_mode = safe_mode or settings_safe_mode
	kwargs["safe_mode"] = safe_mode

	if callable(after_safe_mode):
		after_safe_mode(**kwargs)

	plugin_manager = init_pluginsystem(settings, safe_mode=safe_mode)
	return settings, logger, safe_mode, plugin_manager


def init_settings(basedir, configfile):
	"""Inits the settings instance based on basedir and configfile to use."""

	from octoprint.settings import settings, InvalidSettings
	try:
		return settings(init=True, basedir=basedir, configfile=configfile)
	except InvalidSettings as e:
		message = "Error parsing the configuration file, it appears to be invalid YAML."
		if e.line is not None and e.column is not None:
			message += " The parser reported an error on line {}, column {}.".format(e.line, e.column)
		raise FatalStartupError(message)


def preinit_logging(debug=False, verbosity=0, uncaught_logger=None, uncaught_handler=None):
	config = {
		"version": 1,
		"formatters": {
			"simple": {
				"format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
			}
		},
		"handlers": {
			"console": {
				"class": "logging.StreamHandler",
				"level": "DEBUG",
				"formatter": "simple",
				"stream": "ext://sys.stdout"
			}
		},
		"loggers": {
			"octoprint": {
				"level": "DEBUG" if debug else "INFO"
			},
			"octoprint.util": {
				"level": "INFO"
			}
		},
		"root": {
			"level": "WARN",
			"handlers": ["console"]
		}
	}

	logger = set_logging_config(config, debug, verbosity, uncaught_logger, uncaught_handler)

	from octoprint.logging.handlers import RecordingLogHandler
	recorder = RecordingLogHandler(level=log.DEBUG)
	log.getLogger().addHandler(recorder)

	return logger, recorder


def init_logging(settings, use_logging_file=True, logging_file=None, default_config=None, debug=False, verbosity=0, uncaught_logger=None, uncaught_handler=None):
	"""Sets up logging."""

	import os

	from octoprint.util import dict_merge

	# default logging configuration
	if default_config is None:
		default_config = {
			"version": 1,
			"formatters": {
				"simple": {
					"format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
				},
				"serial": {
					"format": "%(asctime)s - %(message)s"
				}
			},
			"handlers": {
				"console": {
					"class": "logging.StreamHandler",
					"level": "DEBUG",
					"formatter": "simple",
					"stream": "ext://sys.stdout"
				},
				"file": {
					"class": "octoprint.logging.handlers.CleaningTimedRotatingFileHandler",
					"level": "DEBUG",
					"formatter": "simple",
					"when": "D",
					"backupCount": 6,
					"filename": os.path.join(settings.getBaseFolder("logs"), "octoprint.log")
				},
				"serialFile": {
					"class": "octoprint.logging.handlers.SerialLogHandler",
					"level": "DEBUG",
					"formatter": "serial",
					"backupCount": 3,
					"filename": os.path.join(settings.getBaseFolder("logs"), "serial.log")
				}
			},
			"loggers": {
				"SERIAL": {
					"level": "CRITICAL",
					"handlers": ["serialFile"],
					"propagate": False
				},
				"octoprint": {
					"level": "INFO"
				},
				"octoprint.util": {
					"level": "INFO"
				},
				"octoprint.plugins": {
					"level": "INFO"
				}
			},
			"root": {
				"level": "WARN",
				"handlers": ["console", "file"]
			}
		}

	if debug or verbosity > 0:
		default_config["loggers"]["octoprint"]["level"] = "DEBUG"
		default_config["root"]["level"] = "INFO"
	if verbosity > 1:
		default_config["loggers"]["octoprint.plugins"]["level"] = "DEBUG"
	if verbosity > 2:
		default_config["root"]["level"] = "DEBUG"

	if use_logging_file:
		# further logging configuration from file...
		if logging_file is None:
			logging_file = os.path.join(settings.getBaseFolder("base"), "logging.yaml")

		config_from_file = {}
		if os.path.exists(logging_file) and os.path.isfile(logging_file):
			import yaml
			with open(logging_file, "r") as f:
				config_from_file = yaml.safe_load(f)

		# we merge that with the default config
		config = dict_merge(default_config, config_from_file)
	else:
		config = default_config

	# configure logging globally
	return set_logging_config(config, debug, verbosity, uncaught_logger, uncaught_handler)


def set_logging_config(config, debug, verbosity, uncaught_logger, uncaught_handler):
	# configure logging globally
	import logging.config as logconfig
	logconfig.dictConfig(config)

	# make sure we log any warnings
	log.captureWarnings(True)

	import warnings

	categories = (DeprecationWarning, PendingDeprecationWarning)
	if verbosity > 2:
		warnings.simplefilter("always")
	elif debug or verbosity > 0:
		for category in categories:
			warnings.simplefilter("always", category=category)

	# make sure we also log any uncaught exceptions
	if uncaught_logger is None:
		logger = log.getLogger(__name__)
	else:
		logger = log.getLogger(uncaught_logger)

	if uncaught_handler is None:
		def exception_logger(exc_type, exc_value, exc_tb):
			logger.error("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))

		uncaught_handler = exception_logger
	sys.excepthook = uncaught_handler

	return logger


def init_pluginsystem(settings, safe_mode=False):
	"""Initializes the plugin manager based on the settings."""

	import os

	logger = log.getLogger(__name__)

	plugin_folders = [(os.path.abspath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "plugins")), True),
	                  settings.getBaseFolder("plugins")]
	plugin_entry_points = ["octoprint.plugin"]
	plugin_disabled_list = settings.get(["plugins", "_disabled"])

	plugin_validators = []
	if safe_mode:
		def validator(phase, plugin_info):
			if phase == "after_load":
				setattr(plugin_info, "safe_mode_victim", not plugin_info.bundled)
				setattr(plugin_info, "safe_mode_enabled", False)
			elif phase == "before_enable":
				if not plugin_info.bundled:
					setattr(plugin_info, "safe_mode_enabled", True)
					return False
			return True
		plugin_validators.append(validator)

	from octoprint.plugin import plugin_manager
	pm = plugin_manager(init=True,
	                    plugin_folders=plugin_folders,
	                    plugin_entry_points=plugin_entry_points,
	                    plugin_disabled_list=plugin_disabled_list,
	                    plugin_validators=plugin_validators)

	settings_overlays = dict()
	disabled_from_overlays = dict()

	def handle_plugin_loaded(name, plugin):
		if hasattr(plugin.instance, "__plugin_settings_overlay__"):
			plugin.needs_restart = True

			# plugin has a settings overlay, inject it
			overlay_definition = getattr(plugin.instance, "__plugin_settings_overlay__")
			if isinstance(overlay_definition, (tuple, list)):
				overlay_definition, order = overlay_definition
			else:
				order = None

			overlay = settings.load_overlay(overlay_definition)

			if "plugins" in overlay and "_disabled" in overlay["plugins"]:
				disabled_plugins = overlay["plugins"]["_disabled"]
				del overlay["plugins"]["_disabled"]
				disabled_from_overlays[name] = (disabled_plugins, order)

			settings_overlays[name] = overlay
			logger.debug("Found settings overlay on plugin {}".format(name))

	def handle_plugins_loaded(startup=False, initialize_implementations=True, force_reload=None):
		if not startup:
			return

		sorted_disabled_from_overlays = sorted([(key, value[0], value[1]) for key, value in disabled_from_overlays.items()], key=lambda x: (x[2] is None, x[2], x[0]))

		disabled_list = pm.plugin_disabled_list
		already_processed = []
		for name, addons, _ in sorted_disabled_from_overlays:
			if not name in disabled_list and not name.endswith("disabled"):
				for addon in addons:
					if addon in disabled_list:
						continue

					if addon in already_processed:
						logger.info("Plugin {} wants to disable plugin {}, but that was already processed".format(name, addon))

					if not addon in already_processed and not addon in disabled_list:
						disabled_list.append(addon)
						logger.info("Disabling plugin {} as defined by plugin {} through settings overlay".format(addon, name))
				already_processed.append(name)

	def handle_plugin_enabled(name, plugin):
		if name in settings_overlays:
			settings.add_overlay(settings_overlays[name])
			logger.info("Added settings overlay from plugin {}".format(name))

	pm.on_plugin_loaded = handle_plugin_loaded
	pm.on_plugins_loaded = handle_plugins_loaded
	pm.on_plugin_enabled = handle_plugin_enabled
	pm.reload_plugins(startup=True, initialize_implementations=False)
	return pm

#~~ server main method

def main():
	import argparse

	parser = argparse.ArgumentParser(prog="run")

	parser.add_argument("-v", "--version", action="store_true", dest="version",
						help="Output OctoPrint's version and exit")

	parser.add_argument("-d", "--debug", action="store_true", dest="debug",
						help="Enable debug mode")

	parser.add_argument("--host", action="store", type=str, dest="host",
						help="Specify the host on which to bind the server")
	parser.add_argument("--port", action="store", type=int, dest="port",
						help="Specify the port on which to bind the server")

	parser.add_argument("-c", "--config", action="store", dest="config",
						help="Specify the config file to use. OctoPrint needs to have write access for the settings dialog to work. Defaults to ~/.octoprint/config.yaml")
	parser.add_argument("-b", "--basedir", action="store", dest="basedir",
						help="Specify the basedir to use for uploads, timelapses etc. OctoPrint needs to have write access. Defaults to ~/.octoprint")
	parser.add_argument("--logging", action="store", dest="logConf",
						help="Specify the config file to use for configuring logging. Defaults to ~/.octoprint/logging.yaml")

	parser.add_argument("--daemon", action="store", type=str, choices=["start", "stop", "restart"],
						help="Daemonize/control daemonized OctoPrint instance (only supported under Linux right now)")
	parser.add_argument("--pid", action="store", type=str, dest="pidfile", default="/tmp/octoprint.pid",
						help="Pidfile to use for daemonizing, defaults to /tmp/octoprint.pid")

	parser.add_argument("--iknowwhatimdoing", action="store_true", dest="allowRoot",
						help="Allow OctoPrint to run as user root")

	args = parser.parse_args()

	if args.version:
		print "OctoPrint version %s" % __version__
		sys.exit(0)

	if args.daemon:
		if sys.platform == "darwin" or sys.platform == "win32":
			print >> sys.stderr, "Sorry, daemon mode is only supported under Linux right now"
			sys.exit(2)

		daemon = Main(args.pidfile, args.config, args.basedir, args.host, args.port, args.debug, args.allowRoot, args.logConf)
		if "start" == args.daemon:
			daemon.start()
		elif "stop" == args.daemon:
			daemon.stop()
		elif "restart" == args.daemon:
			daemon.restart()
	else:
		octoprint = Server(configfile=args.config,
		                   basedir=args.basedir,
		                   host=args.host,
		                   port=args.port,
		                   debug=args.debug,
		                   allowRoot=args.allowRoot,
		                   logConf=args.logConf)
		octoprint.run()

if __name__ == "__main__":
	main()
