var requirePatch = require('../require-patch')
var shimmer = require('shimmer')
var semver = require('semver')
var Layer = require('../layer')
var rum = require('../rum')
var path = require('path')
var tv = require('..')
var conf = tv.hapi



function wrapRender (render, version) {
  return function (filename, context, options, callback) {
    context = context || {}
    var self = this

    function builder (last) {
      if (tv.rumId) {
        var topLayer = tv.requestStore.get('topLayer')
        rum.inject(context, tv.rumId, topLayer.events.exit)
      }

      return last.descend('hapi-render', {
        TemplateFile: filename,
        TemplateLanguage: path.extname(filename) || self._defaultExtension,
      })
    }

    function async (callback) {
      return render.call(self, filename, context, options, callback)
    }

    function sync () {
      return render.call(self, filename, context, options)
    }

    var isSync = version && semver.satisfies(version, '< 1.1.0')

    return tv.instrument(builder, isSync ? sync : async, conf, callback)
  }
}

function patchView (view, version) {
  if ( ! view.render._tv_patched) {
    shimmer.wrap(view, 'render', function (render) {
      return wrapRender(render, version)
    })
    view.render._tv_patched = true
  }
}

function patchConnection (conn) {
  function runAndPatchView (fn) {
    return function () {
      var ret = fn.apply(this, arguments)

      if (this._views) {
        patchView(this._views.constructor.prototype)
      } else if (this.pack && this.pack._env.views) {
        patchView(this.pack._env.views.constructor.prototype)

        // 8.0.0+
      } else if (this._server && this._server._env.views) {
        patchView(this._server._env.views.constructor.prototype)
      }

      return ret
    }
  }

  shimmer.wrap(conn, 'views',  runAndPatchView)
}

function patchRequest (request) {
  shimmer.wrap(request, '_execute', function (execute) {
    // The route argument existed from 1.2.0 and older
    return function (route) {
      // Check if there is a trace to continue
      var last = Layer.last
      if ( ! last || ! conf.enabled) {
        return execute.call(this, route)
      }

      var layer = last.descend('hapi')
      var self = this

      layer.enter()

      shimmer.wrap(this.raw.res, 'end', function (realEnd) {
        return function () {
          var httpLayer = self.raw.res._http_layer
          var exit = httpLayer.events.exit

          var data = tv.requestStore.get('hapi-data')
          if (data) {
            exit.Controller = data.Controller
            exit.Action = data.Action
          }

          layer.exit()
          return realEnd.apply(this, arguments)
        }
      })

      return execute.call(this, route)
    }
  })
}

function patchRouter (router) {
  shimmer.wrap(router, 'route', function (route) {
    return function () {
      var ret = route.apply(this, arguments)

      var last = Layer.last
      if (last) {
        // Moved to ret.route.settings at 6.9.0
        var settings = ret.settings || ret.route.settings
        tv.requestStore.set('hapi-data', {
          Controller: settings.path || ret.path,
          Action: settings.handler.name || '(anonymous)'
        })
      }

      return ret
    }
  })
}

function patchRoute (route) {
  shimmer.wrap(route, '_addRoute', function (fn) {
    return function (opts) {
      var ret = fn.apply(this, arguments)

      // Get routes, it moved in 8.0.0-rc2, so watch for that
      var routes = this._router.routes[opts.method.toLowerCase()]
      routes = routes.routes || routes

      // Get settings for the last
      var route = routes[routes.length - 1]
      var settings = route.route.settings

      // Patch handler
      shimmer.wrap(settings, 'handler', function (handler) {
        return function () {
          var last = Layer.last
          if (last) {
            tv.requestStore.set('hapi-data', {
              Controller: route.path || settings.path || ret.path,
              Action: handler.name || '(anonymous)'
            })
          }

          return handler.apply(this, arguments)
        }
      })

      return ret
    }
  })
}

function patchDecorator (plugin, version) {
  function wrapViews (views) {
    return function () {
      var ret = views.apply(this, arguments)

      var manager = this.realm.plugins.vision.manager
      manager.render = wrapRender(manager.render, version)

      return ret
    }
  }

  shimmer.wrap(plugin, 'decorate', function (fn) {
    return function (name, method, handler) {
      if (name === 'server' && method === 'views') {
        handler = wrapViews(handler)
      }

      return fn.call(this, name, method, handler)
    }
  })
}

//
// Apply hapi patches
//
module.exports = function (hapi) {
  var pkg = requirePatch.relativeRequire('hapi/package.json')

  var Request = requirePatch.relativeRequire('hapi/lib/request')
  patchRequest(Request.prototype)

  var Connection
  var Server

  // After 7.2.0, Server became Connection
  if (semver.satisfies(pkg.version, '>= 8.0.0-rc5')) {
    var Plugin = requirePatch.relativeRequire('hapi/lib/plugin')
    Connection = requirePatch.relativeRequire('hapi/lib/connection')
    patchDecorator(Plugin.prototype, pkg.version)
    patchRoute(Connection.prototype)

  } else if (semver.satisfies(pkg.version, '>= 8.0.0-rc1')) {
    Server = requirePatch.relativeRequire('hapi/lib/server')
    Connection = requirePatch.relativeRequire('hapi/lib/connection')
    patchConnection(Server.prototype)
    patchRoute(Connection.prototype)

  } else if (semver.satisfies(pkg.version, '>= 7.2.0')) {
    Connection = requirePatch.relativeRequire('hapi/lib/connection')
    patchConnection(Connection.prototype)

  // After 2.0.0, View was not patchable directly
  } else if (semver.satisfies(pkg.version, '>= 6.0.0')) {
    Server = requirePatch.relativeRequire('hapi/lib/server')
    patchConnection(Server.prototype)

  // Beyond that, we can patch View directly
  } else {
    var View = requirePatch.relativeRequire('hapi/lib/views')
    if (semver.satisfies(pkg.version, '> 2.0.0')) {
      patchView(View.Manager.prototype)
    } else {
      patchView(View.prototype, pkg.version)
    }
  }

  // The router is no longer a constructor as of 6.9.0
  if (semver.satisfies(pkg.version, '< 8.0.0-rc1')) {
    var Router = requirePatch.relativeRequire('hapi/lib/router')
    if (semver.satisfies(pkg.version, '>= 6.9.0')) {
      shimmer.wrap(Router, 'create', function (create) {
        return function (server) {
          var ret = create.call(this, server)
          patchRouter(server._router)
          return ret
        }
      })
    } else {
      patchRouter(Router.prototype)
    }
  }

  return hapi
}
