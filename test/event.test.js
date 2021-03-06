var helper = require('./helper')
var should = require('should')
var tv = require('..')
var addon = tv.addon
var Event = tv.Event

describe('event', function () {
  var emitter
  var event

  //
  // Intercept tracelyzer messages for analysis
  //
  before(function (done) {
    emitter = helper.tracelyzer(done)
    tv.sampleRate = tv.addon.MAX_SAMPLE_RATE
    tv.traceMode = 'always'
  })
  after(function (done) {
    emitter.close(done)
  })

  // Yes, this is really, actually needed.
  // Sampling may actually prevent reporting,
  // if the tests run too fast. >.<
  beforeEach(function (done) {
    helper.padTime(done)
  })

  it('should construct valid event', function () {
    event = new Event('test', 'entry')
    event.should.have.property('Layer', 'test')
    event.should.have.property('Label', 'entry')
    event.should.have.property('taskId').and.match(/^[0-9A-F]{40}$/)
    event.should.have.property('opId').and.match(/^[0-9A-F]{16}$/)
  })

  it('should convert an event to a string', function () {
    event.toString().should.match(/^1B[0-9A-F]{56}$/)
  })

  it('should enter the event context', function () {
    var context = addon.Context.toString()
    event.enter()
    addon.Context.toString().should.not.equal(context)
  })

  it('should send the event', function (done) {
    var event2 = new Event('test', 'exit', event.event)

    emitter.once('message', function (msg) {
      msg.should.have.property('X-Trace', event2.toString())
      msg.should.have.property('Edge', event.opId)
      msg.should.have.property('Layer', 'test')
      msg.should.have.property('Label', 'exit')
      done()
    })

    // NOTE: events must be sent within a request store context
    tv.requestStore.run(function () {
      event2.send()
    })
  })
})
