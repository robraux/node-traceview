var debug = require('debug')('node-oboe:event')
var extend = require('util')._extend
var addon = require('./addon')
var oboe = require('./')

// Export the event class
module.exports = Event

function startTrace () {
  return addon.Context.startTrace()
}

// Create an event from a specific context,
// without global-state side effects.
// We have to create events at weird times,
// so we need to manage linking manually.
function continueTrace (parent) {
  // Store the current context
  var ctx = addon.Context.toString()

  // Temporarily modify the context
  if (parent.event) {
    parent = parent.event
  }
  addon.Context.set(parent)

  // Create an event in the mofieied context
  var e = addon.Context.createEvent()

  // Restore the original context
  addon.Context.set(ctx)
  return e
}

/**
 * Creates an event
 *
 * NOTE:
 * - This is not context safe. You must manage context externally.
 * - Uses lazy-assignment to defer info changes on native event until send.
 *
 * @class Event
 * @constructor
 * @param {String} name Event name
 * @param {String} label Event label (usually entry or exit)
 * @param {Object} parent Parent event to edge back to
 */
function Event (layer, label, parent) {
  Object.defineProperty(this, 'event', {
    value: parent ? continueTrace(parent) : startTrace()
  })

  if (parent) {
    parent = parent.event ? parent.event : parent
    Object.defineProperty(this, 'parent', {
      value: parent
    })
    debug(this.event + ' added edge ' + parent)
  }

  Object.defineProperty(this, 'edges', {
    value: []
  })

  this.Layer = layer
  this.Label = label
}

/**
 * Read taskId from native event string
 *
 * @property taskId
 * @type {String}
 */
Event.prototype.__defineGetter__('taskId', function () {
  return this.event.toString().substr(2, 40)
})

/**
 * Read opId from native event string
 *
 * @property opId
 * @type {String}
 */
Event.prototype.__defineGetter__('opId', function () {
  return this.event.toString().substr(42)
})

/**
 * Find the last reported event in the active context
 *
 * @property last
 * @type {Event}
 */
Event.__defineGetter__('last', function () {
  return oboe.requestStore.get('lastEvent')
})

/**
 * Enter the context of this event
 *
 * @method enter
 */
Event.prototype.enter = function () {
  debug(this.event + ' entered')
  addon.Context.set(this.event)
}

/**
 * Delegate toString to event
 *
 * @method toString
 */
Event.prototype.toString = function () {
  return this.event.toString()
}

/**
 * Send this event to the reporter
 *
 * @method send
 */
Event.prototype.send = function () {
  // We need to find and restore the context on
  // the JS side before using Reporter.sendReport()
  if (this.parent) {
    debug('restoring request context to ' + this.parent)
    addon.Context.set(this.parent)
  }
  oboe.requestStore.set('lastEvent', this)

  var keys = Object.keys(this)
  var event = this.event
  var len = keys.length
  var key
  var i

  // Mix data from the context object into the event
  for (i = 0; i < len; i++) {
    key = keys[i]
    var val = this[key]
    if (typeof val !== 'undefined') {
      debug(this.event + ' set ' + key + ' = ' + val)
      event.addInfo(key, val)
    }
  }

  // Mix edges from context object into the event
  var edges = this.edges
  len = edges.length

  for (i = 0; i < len; i++) {
    var edge = edges[i]
    if (edge.event) {
      edge = edge.event
    }
    event.addEdge(edge)
    debug(this.event + ' added edge ' + edge)
  }

  // Send the event
  oboe.reporter.sendReport(event)
  debug(this.event + ' sent to reporter')
}