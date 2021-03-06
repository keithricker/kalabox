/**
 * Module for interacting with and managing user defined apps.
 * @module kbox.app
 */

'use strict';

var fs = require('fs');
var path = require('path');
var core = require('./core.js');
var engine = require('./engine.js');
var services = require('./services.js');
var util = require('./util.js');
var helpers = util.helpers;
var _ = require('lodash');
var share = require('./share.js');
var disco = require('./app/discovery.js');
var async = require('async');
var kbox = require('./kbox.js');

var pp = function(obj) {
  return JSON.stringify(obj, null, '  ');
};

var createComponent = function(app, name, componentSpec) {
  var component = {};
  for (var key in componentSpec) {
    component[key] = componentSpec[key];
  }
  component.name = name;
  component.hostname = [name, app.domain].join('.');
  component.appDomain = app.domain;
  component.url = 'http://' + component.hostname;
  component.dataContainerName = app.dataContainerName;
  component.containerName = ['kb', app.name, name].join('_');
  component.containerIdFile = path.join(app.config.appCidsRoot, name);
  component.containerId = null;

  if (fs.existsSync(component.containerIdFile)) {
    component.containerId = fs.readFileSync(component.containerIdFile, 'utf8');
  }

  if (component.image.build) {
    var pathsToSearch = [
      app.config.appRoot,
      app.config.srcRoot
    ].map(function(dir) {
      return path.join(dir, component.image.srcRoot, 'Dockerfile');
    });
    var rootPath = util.searchForPath(pathsToSearch);
    if (rootPath === null) {
      component.image.build = false;
    } else {
      component.image.srcRoot = rootPath;
    }
  }
  return component;
};

var setupComponents = function(app) {
  app.components = app.config.appComponents;
  if (!fs.existsSync(app.config.appCidsRoot))  {
    fs.mkdirSync(app.config.appCidsRoot);
  }
  for (var key in app.components) {
    if (key !== 'data') {
      var componentSpec = app.components[key];
      app.components[key] = createComponent(app, key, componentSpec);
    }
  }
};

var loadPlugins = exports.loadPlugins = function(app, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('Invalid callback function: ' + callback);
  }
  if (app.config.appPlugins !== undefined) {
    app.plugins = app.config.appPlugins;
  } else {
    app.plugins = [];
  }
  async.eachSeries(app.plugins, function(plugin, next) {
    kbox.require(plugin, next);
  },
  function(err) {
    callback(err);
  });
};

/**
 * Creates an app.
 * @static
 * @method
 * @arg {string} name - The name of the app.
 * @arg {object} config - An app config object.
 * @arg {function} callback - Callback function called when the app is created
 * @arg {error} callback.error - An error if any.
 * @arg {object} callback.app - The instantiated app object.
 * @prop {string} name - String name of the application.
 * @prop {string} domain - The domain name. -> appName.kbox
 * @prop {string} url - URL of the app.
 * @prop {string} dataContainerName - Name of the data component for the app.
 * @prop {string} appRoot - Root directory for the app.
 * @prop {object} config - The app's config object.
 * @prop {object<array>} plugins - List of the app's plugins.
 * @prop {object<array>} components - List of the app's components.
 * @example
 * kbox.app.create(config.appName, config, function(err, app) {
 *  callback(err, app);
 * });
 */
var create = exports.create = function(name, config, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('Invalid function callback: ' + callback);
  }

  var app = {};
  app.name = name;
  app.domain = [name, config.domain].join('.');
  app.url = 'http://' + app.domain;
  app.dataContainerName = ['kb', app.name, 'data'].join('_');
  app.root = config.appRoot;
  app.rootBind = engine.provider.path2Bind4U(app.root);
  app.config = config;
  app.config.homeBind = engine.provider.path2Bind4U(app.config.home);
  app.config.codeRoot = path.join(
    app.root,
    core.deps.lookup('globalConfig').codeDir
  );
  setupComponents(app);
  callback(null, app);
};

/**
 * Lists all the users apps known to Kalabox.
 * @static
 * @method
 * @arg {function} callback - Callback called when query for apps is complete.
 * @arg {error} callback.error
 * @arg {app<array>} callback.apps - Array of apps.
 * @example
 * kbox.app.list(function(err, apps) {
 *   if (err) {
 *     throw err;
 *   } else {
 *     apps.forEach(function(app) {
 *       console.log(app.name);
 *     });
 *   }
 * });
 */
var list = exports.list = function(callback) {
  disco.list(function(err, appNames) {
    if (err)  {
      callback(err);
    } else {
      var apps = async.map(appNames,
      function(appName, next) {
        disco.getAppDir(appName, function(err, dir) {
          if (err) {
            next(err);
          } else {
            var config = core.config.getAppConfig(appName, dir);
            create(appName, config, function(err, app) {
              next(err, app);
            });
          }
        });
      },
      function(err, apps) {
        if (err) {
          callback(err);
        } else {

          // Search for duplicate app names.
          var groups = _.groupBy(apps, function(app) {
            return app.name;
          });
          _.each(groups, function(arr) {
            if (arr.length !== 1) {
              callback(new Error('Duplicate app names exist: ' + pp(arr)));
            }
          });

          callback(null, apps);
        }
      });
    }
  });
};

/**
 * Get an app object from an app's name.
 * @static
 * @method
 * @arg {string} appName - App name for the app you want to get.
 * @arg {function} callback - Callback function called when the app is got.
 * @arg {error} callback.error - Error from getting the app.
 * @arg {app} callback.app - App object.
 * @example
 * kbox.app.get('myapp', function(err, app) {
 *   if (err) {
 *     throw err;
 *   } else {
 *     console.log(app.config);
 *   }
 * });
 */
var get = function(appName, callback) {
  list(function(err, apps) {
    if (err) {
      callback(err);
    } else {
      var app = helpers.find(apps, function(app) {
        return app.name === appName;
      });
      if (app === null) {
        callback(new Error('App [' + appName + '] does not exist.'));
      } else {
        callback(null, app);
      }
    }
  });
};
exports.get = get;

var getComponents = function(app) {
  // Make sure data container is always numba one!
  var components = _.toArray(app.components);
  var data = _.remove(components, function(component) {
    if (component.name === 'data') {
      return component;
    }
  });
  if (!_.isEmpty(data)) {
    components.unshift(data[0]);
  }
  return components;
};

var getInstallOptions = function(app, component) {
  var opts = {
    Hostname: component.hostname,
    name: component.containerName,
    Image: component.image.name,
    Dns: ['8.8.8.8', '8.8.4.4']
  };
  if (component.dataContainerName !== null) {
    opts.HostConfig = {VolumesFrom:[component.dataContainerName]};
  }
  if (component.installOptions) {
    for (var key in component.installOptions) {
      opts[key] = component.installOptions[key];
    }
  }
  return opts;
};

var installComponent = function(events, app, component, callback) {
  component.installOptions = getInstallOptions(app, component);
  events.emit('pre-install-component', component, function(err) {
    if (err) {
      callback(err);
    } else {
      engine.build(component.image, function(err) {
        if (err) {
          callback(err);
        } else {
          // @todo: debug remove
          engine.create(component.installOptions, function(err, container) {
            if (err) {
              callback(err);
            } else {
              if (container) {
                component.containerId = container.cid;
                fs.writeFileSync(
                  path.resolve(component.containerIdFile), container.cid
                );
              }
              events.emit('post-install-component', component, function(err) {
                callback(err);
              });
            }
          });
        }
      });
    }
  });
};

/**
 * Installs an app's components.
 * @static
 * @method
 * @arg {object} app - App object you want to install.
 * @arg {function} callback - Callback called when the app has been installed.
 * @arg {array} callback.errors - Array of errors from installing components.
 * @example
 * kbox.app.install(app, function(errs) {
 *   if (errs) {
 *     throw errs;
 *   } else {
 *     console.log('App installed.');
 *   }
 * });
 */
var install = function(app, callback) {
  core.deps.call(function(events) {
    services.verify(function(err) {
      if (err) {
        callback(err);
      } else {
        events.emit('pre-install', app, function(err) {
          if (err) {
            callback(err);
          } else {
            disco.registerAppDir(app.config.appRoot, function(err) {
              if (err) {
                callback(err);
              } else {
                helpers.mapAsync(
                  getComponents(app),
                  function(component, done) {
                    installComponent(events, app, component, done);
                  },
                  function(errs) {
                    if (errs && errs.length > 0) {
                      callback(errs[0]);
                    } else {
                      events.emit('post-install', app, function(err) {
                        callback(err);
                      });
                    }
                  }
                );
              }
            });
          }
        });
      }
    });
  });
};
exports.install = install;

var getStartOptions = function(app, component, opts) {
  var startOpts = {
    PublishAllPorts: true,
    Binds: [app.rootBind + ':/src:rw']
  };
  if (opts) {
    for (var key in opts) {
      startOpts[key] = opts[key];
    }
  }
  return startOpts;
};

var startComponent = function(events, app, component, callback) {
  component.opts = getStartOptions(app, component);
  events.emit('pre-start-component', component, function(err) {
    if (err) {
      callback(err);
    } else {
      engine.start(component.containerId, component.opts, function(err) {
        if (err) {
          callback(err);
        } else {
          events.emit('post-start-component', component, function(err) {
            if (err) {
              callback(err);
            } else {
              callback(err);
            }
          });
        }
      });
    }
  });
};

/**
 * Starts an app's components.
 * @static
 * @method
 * @arg {object} app - App object you want to start.
 * @arg {function} callback - Callback called when the app has been started.
 * @arg {array} callback.errors - Array of errors from starting components.
 * @example
 * kbox.app.start(app, function(errs) {
 *   if (errs) {
 *     throw errs;
 *   } else {
 *     console.log('App started.');
 *   }
 * });
 */
var start = function(app, callback) {
  core.deps.call(function(events) {
    services.verify(function(err) {
      if (err) {
        callback(err);
      } else {
        events.emit('pre-start', app, function(err) {
          if (err) {
            callback(err);
          } else {
            helpers.mapAsync(
              getComponents(app),
              function(component, done) {
                startComponent(events, app, component, done);
              },
              function(errs) {
                events.emit('post-start', app, function(err) {
                  if (err) {
                    callback(err);
                  } else {
                    callback(errs);
                  }
                });
              }
            );
          }
        });
      }
    });
  });
};
exports.start = start;

var stopComponent = function(events, component, callback) {
  events.emit('pre-stop-component', component, function(err) {
    if (err) {
      callback(err);
    } else {
      engine.stop(component.containerId, function(err) {
        if (err) {
          callback(err);
        } else {
          events.emit('post-stop-component', component, function(err) {
            callback(err);
          });
        }
      });
    }
  });
};

/**
 * Stops an app's components.
 * @static
 * @method
 * @arg {object} app - App object you want to stop.
 * @arg {function} callback - Callback called when the app has been stopped.
 * @arg {array} callback.errors - Array of errors from stopping components.
 * @example
 * kbox.app.stop(app, function(errs) {
 *   if (errs) {
 *     throw errs;
 *   } else {
 *     console.log('App stopped.');
 *   }
 * });
 */
var stop = function(app, callback) {
  core.deps.call(function(events) {
    services.verify(function(err) {
      if (err) {
        callback(err);
      }
      else {
        events.emit('pre-stop', app, function(err) {
          if (err) {
            callback(err);
          } else {
            helpers.mapAsync(
              getComponents(app),
              function(component, done) {
                stopComponent(events, component, done);
              },
              function(errs) {
                events.emit('post-stop', app, function(err) {
                  if (err) {
                    callback(err);
                  } else {
                    callback(errs);
                  }
                });
              }
            );
          }
        });
      }
    });
  });
};
exports.stop = stop;

/**
 * Stops and then starts an app's components.
 * @static
 * @method
 * @arg {object} app - App object you want to restart.
 * @arg {function} callback - Callback called when the app has been restarted.
 * @arg {array} callback.errors - Array of errors from restarting components.
 * @example
 * kbox.app.restart(app, function(errs) {
 *   if (errs) {
 *     throw errs;
 *   } else {
 *     console.log('App Restarted.');
 *   }
 * });
 */
exports.restart = function(app, callback) {
  stop(app, function(err) {
    if (err) {
      callback(err);
    } else {
      start(app, callback);
    }
  });
};

var uninstallComponent = function(events, component, callback) {
  events.emit('pre-uninstall-component', component, function(err) {
    if (err) {
      callback(err);
    } else {
      engine.remove(component.containerId, function(err) {
        if (err) {
          callback(err);
        } else {
          fs.unlinkSync(component.containerIdFile);
          events.emit('post-uninstall-component', component, function(err) {
            callback(err);
          });
        }
      });
    }
  });
};

/**
 * Uninstalls an app's components except for the data container.
 * @static
 * @method
 * @arg {object} app - App object you want to uninstall.
 * @arg {function} callback - Callback called when the app has been uninstalled.
 * @arg {array} callback.errors - Array of errors from uninstalling components.
 * @example
 * kbox.app.uninstall(app, function(err) {
 *   if (err) {
 *     throw err;
 *   } else {
 *     console.log('App uninstalled.');
 *   }
 * });
 */
var uninstall = function(app, callback) {
  core.deps.call(function(events) {
    events.emit('pre-uninstall', app, function(err) {
      if (err) {
        callback(err);
      } else {
        helpers.mapAsync(
          getComponents(app),
          function(component, done) {
            uninstallComponent(events, component, done);
          },
          function(errs) {
            if (errs && errs.length > 0) {
              callback(errs[0]);
            } else {
              events.emit('post-uninstall', app, function(err) {
                callback(err);
              });
            }
          }
        );
      }
    });
  });
};
exports.uninstall = uninstall;

/**
 * Rebuilds an apps containers. This will stop an app's containers, remove all
 * of them except the data container, pull down the latest versions of the
 * containers as specified in the app's kalabox.json. You will need to run
 * `kbox start` when done to restart your app.
 * @static
 * @method
 * @arg {object} app - App object you want to rebuild.
 * @arg {function} callback - Callback called when the app has been rebuilt.
 * @arg {array} callback.errors - Error from rebuilding components.
 * @example
 * kbox.app.rebuild(app, function(errs) {
 *   if (err) {
 *     throw err;
 *   } else {
 *     console.log('App rebuilt!.');
 *   }
 * });
 */
exports.rebuild = function(app, callback) {
  stop(app, function(err) {
    if (err) {
      callback(err);
    }
    else {
      uninstall(app, function(err) {
        if (err) {
          callback(err);
        }
        else {
          install(app, function(err) {
            if (err) {
              callback(err);
            }
            else {
              callback();
            }
          });
        }
      });
    }
  });
};
