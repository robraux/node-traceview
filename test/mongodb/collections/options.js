exports.run = function (ctx, done) {
  ctx.mongo.collection('test').options(function () {
    done()
  })
}
