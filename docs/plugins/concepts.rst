.. _sec-plugin-concepts:

Concepts
========

.. contents::
   :local:

OctoPrint's plugins are `Python Packages <https://docs.python.org/2/tutorial/modules.html#packages>`_ which in their
top-level module define a bunch of :ref:`control properties <sec-plugin-concepts-controlproperties>` defining
metadata (like name, version etc of the plugin) as well as information on how to initialize the plugin and into what
parts of the system the plugin will actually plug in to perform its job.

There are three types of ways a plugin might attach itself to the system, through so called
:ref:`mixin <sec-plugins-mixins>` implementations, by attaching itself to specified
:ref:`hook <sec-plugins-hooks>`, by offering :ref:`helper <sec-plugins-helpers>` functionality to be
used by other plugins or by providing :ref:`settings overlays <sec-plugins-controlproperties-plugin_settings_overlay>`.

Plugin mixin implementations will get a bunch of :ref:`properties injected <sec-plugins-concepts-injectedproperties>`
by OctoPrint plugin system to help them work.

.. _sec-plugin-concepts-controlproperties:

Control Properties
------------------

As already mentioned above, plugins are Python packages which provide certain pieces of metadata to tell OctoPrint's
plugin subsystem about themselves. These are simple package attributes defined in the top most package file, e.g.:

.. code-block:: python

   import octoprint.plugin

   # ...

   __plugin_name__ = "My Plugin"
   def __plugin_load__():
       # whatever you need to do to load your plugin, if anything at all
       pass

The following properties are recognized:

``__plugin_name__``
  Name of your plugin, optional, overrides the name specified in ``setup.py`` if provided. If neither this property nor
  a name from ``setup.py`` is available to the plugin subsystem, the plugin's identifier (= package name) will be
  used instead.
``__plugin_version__``
  Version of your plugin, optional, overrides the version specified in ``setup.py`` if provided.
``__plugin_description__``
  Description of your plugin, optional, overrides the description specified in ``setup.py`` if provided.
``__plugin_author__``
  Author of your plugin, optional, overrides the author specified in ``setup.py`` if provided.
``__plugin_url__``
  URL of the webpage of your plugin, e.g. the Github repository, optional, overrides the URL specified in ``setup.py`` if
  provided.
``__plugin_license__``
  License of your plugin, optional, overrides the license specified in ``setup.py`` if provided.
``__plugin_implementation__``
  Instance of an implementation of one or more :ref:`plugin mixins <sec-plugins-mixins>`.
``__plugin_hooks__``
  Handlers for one or more of the various :ref:`plugin hooks <sec-plugins-hooks>`.
``__plugin_check__``
  Method called upon discovery of the plugin by the plugin subsystem, should return ``True`` if the
  plugin can be instantiated later on, ``False`` if there are reasons why not, e.g. if dependencies
  are missing.
``__plugin_load__``
  Method called upon loading of the plugin by the plugin subsystem, can be used to instantiate
  plugin implementations, connecting them to hooks etc.
``__plugin_unload__``
  Method called upon unloading of the plugin by the plugin subsystem, can be used to do any final clean ups.
``__plugin_enable__``
  Method called upon enabling of the plugin by the plugin subsystem. Also see :func:`~octoprint.plugin.core.Plugin.on_plugin_enabled``.
``__plugin_disable__``
  Method called upon disabling of the plugin by the plugin subsystem. Also see :func:`~octoprint.plugin.core.Plugin.on_plugin_disabled``.

.. _sec-plugin-concepts-mixins:

Mixins
------

Plugin mixins are the heart of OctoPrint's plugin system. They are :ref:`special base classes <sec-plugins-mixins>`
which are to be subclassed and extended to add functionality to OctoPrint. Plugins declare their instances that
implement one or multiple mixins using the ``__plugin_implementation__`` control property. OctoPrint's plugin core
collects those from the plugins and offers methods to access them based on the mixin type, which get used at multiple
locations within OctoPrint.

Using mixins always follows the pattern of retrieving the matching implementations from the plugin subsystem, then
calling the specific mixin's methods as defined and necessary.

The following snippet taken from OctoPrint's code for example shows how all :class:`~octoprint.plugin.AssetPlugin`
implementations are collected and then all assets they return via their ``get_assets`` methods are retrieved and
merged into one big asset map (differing between javascripts and stylesheets of various types) for use during
rendition of the UI.

.. code-block:: python
   :linenos:

   asset_plugins = pluginManager.get_implementations(octoprint.plugin.AssetPlugin)
   for name, implementation in asset_plugins.items():
       all_assets = implementation.get_assets()

       if "js" in all_assets:
           for asset in all_assets["js"]:
               assets["js"].append(url_for('plugin_assets', name=name, filename=asset))

       if preferred_stylesheet in all_assets:
           for asset in all_assets[preferred_stylesheet]:
               assets["stylesheets"].append((preferred_stylesheet, url_for('plugin_assets', name=name, filename=asset)))
       else:
           for stylesheet in supported_stylesheets:
               if not stylesheet in all_assets:
                   continue

               for asset in all_assets[stylesheet]:
                   assets["stylesheets"].append((stylesheet, url_for('plugin_assets', name=name, filename=asset)))
               break

.. seealso::

   :ref:`Available Mixins <sec-plugins-mixins>`
       An overview of all mixin types available for extending OctoPrint.

   :ref:`The Getting Started Guide <sec-plugins-gettingstarted>`
       Tutorial on how to write a simple OctoPrint module utilizing mixins for various types of extension.

.. _sec-plugin-concepts-hooks:

Hooks
-----

Hooks are the smaller siblings of mixins, allowing to extend functionality or data processing where a custom mixin type
would be too much overhead. Where mixins are based on classes, hooks are based on methods. Like with the mixin
implementations, plugins inform OctoPrint about hook handlers using a control property, ``__plugin_hooks__``.

Each hook defines a contract detailing the call parameters for the hook handler method and the expected return type.
OctoPrint will call the hook with the define parameters and process the result depending on the hook.

An example for a hook within OctoPrint is ``octoprint.comm.protocol.scripts``, which allows adding additional
lines to OctoPrint's :ref:`GCODE scripts <sec-features-gcode_scripts>`, either as ``prefix`` (before the existing lines)
or as ``postfix`` (after the existing lines).

.. code-block:: python
   :linenos:

   self._gcode_hooks = self._pluginManager.get_hooks("octoprint.comm.protocol.scripts")

   # ...

   for hook in self._gcodescript_hooks:
       try:
           retval = self._gcodescript_hooks[hook](self, "gcode", scriptName)
       except:
           self._logger.exception("Error while processing gcodescript hook %s" % hook)
       else:
           if retval is None:
               continue
           if not isinstance(retval, (list, tuple)) or not len(retval) == 2:
               continue

           def to_list(data):
               if isinstance(data, str):
                   data = map(str.strip, data.split("\n"))
               elif isinstance(data, unicode):
                   data = map(unicode.strip, data.split("\n"))

               if isinstance(data, (list, tuple)):
                   return list(data)
               else:
                   return None

           prefix, suffix = map(to_list, retval)
           if prefix:
               scriptLines = list(prefix) + scriptLines
           if suffix:
               scriptLines += list(suffix)

As you can see, the hook's method signature is defined to take the current ``self`` (as in, the current comm layer instance),
the general type of script for which to look for additions ("gcode") and the script name for which to look (e.g.
``beforePrintStarted`` for the GCODE script executed before the beginning of a print job). The hook is expected to
return a 2-tuple of prefix and postfix if has something for either of those, otherwise ``None``. OctoPrint will then take
care to add prefix and suffix as necessary after a small round of preprocessing.

.. note::

Each plugin that OctoPrint finds it will first load, then enable. On enabling a plugin, OctoPrint will
register its declared :ref:`hook handlers <sec-plugins-hooks>` and :ref:`helpers <sec-plugins-helpers>`, apply
any :ref:`settings overlays <sec-plugins-controlproperties-plugin_settings_overlay>`,
:ref:`inject the required properties <sec-plugins-mixins-injectedproperties>` into its declared
:ref:`mixin implementation <sec-plugins-mixins>` and register those as well.

On disabling a plugin, its hook handlers, helpers, mixin implementations and settings overlays will be de-registered again.

Some plugin types require a reload of the frontend or a restart of OctoPrint for enabling/disabling them. You
can recognized such plugins by their implementations implementing :class:`~octoprint.plugin.ReloadNeedingPlugin` or
:class:`~octoprint.plugin.RestartNeedingPlugin` or providing handlers for one of the hooks marked correspondingly.

.. image:: ../images/plugins_lifecycle.png
   :align: center
   :alt: The lifecycle of OctoPrint plugins.
