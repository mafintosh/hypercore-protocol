var events = require('events')
var inherits = require('inherits')
var varint = require('varint')
var messages = require('./messages')
var bufferAlloc = require('buffer-alloc-unsafe')
var debug = require('debug')('hypercore-protocol')

module.exports = Feed

function Feed (stream) {
  if (!(this instanceof Feed)) return new Feed(stream)
  events.EventEmitter.call(this)

  this.key = null
  this.discoveryKey = null
  this.stream = stream
  this.peer = null // support a peer object to avoid event emitter + closures overhead

  this.id = -1
  this.remoteId = -1
  this.header = 0
  this.headerLength = 0
  this.closed = false

  this._buffer = []
}

inherits(Feed, events.EventEmitter)

Feed.prototype.handshake = function (message) {
  debug(this.id, 'send HANDSHAKE', message)
  return this._send(1, messages.Handshake, message)
}

Feed.prototype.info = function (message) {
  debug(this.id, 'send INFO', message)
  return this._send(2, messages.Info, message)
}

Feed.prototype.have = function (message) {
  debug(this.id, 'send HAVE', message)
  return this._send(3, messages.Have, message)
}

Feed.prototype.unhave = function (message) {
  debug(this.id, 'send UNHAVE', message)
  return this._send(4, messages.Unhave, message)
}

Feed.prototype.want = function (message) {
  debug(this.id, 'send WANT', message)
  return this._send(5, messages.Want, message)
}

Feed.prototype.unwant = function (message) {
  debug(this.id, 'send UNWANT', message)
  return this._send(6, messages.Unwant, message)
}

Feed.prototype.request = function (message) {
  debug(this.id, 'send REQUEST', message)
  return this._send(7, messages.Request, message)
}

Feed.prototype.cancel = function (message) {
  debug(this.id, 'send CANCEL', message)
  return this._send(8, messages.Cancel, message)
}

Feed.prototype.data = function (message) {
  debug(this.id, 'send DATA', message)
  return this._send(9, messages.Data, message)
}

Feed.prototype.extension = function (type, message) {
  var id = this.stream.extensions.indexOf(type)
  if (id === -1) return false
  debug(this.id, 'send EXTENSION', type, message)

  var header = this.header | 15
  var len = this.headerLength + varint.encodingLength(id) + message.length
  var box = bufferAlloc(varint.encodingLength(len) + len)
  var offset = 0

  varint.encode(len, box, offset)
  offset += varint.encode.bytes

  varint.encode(header, box, offset)
  offset += varint.encode.bytes

  varint.encode(id, box, offset)
  offset += varint.encode.bytes

  message.copy(box, offset)
  return this.stream._push(box)
}

Feed.prototype.remoteSupports = function (name) {
  return this.stream.remoteSupports(name)
}

Feed.prototype.destroy = function (err) {
  this.stream.destroy(err)
}

Feed.prototype.close = function () {
  var i = this.stream.feeds.indexOf(this)

  if (i > -1) {
    this.stream.feeds[i] = this.stream.feeds[this.stream.feeds.length - 1]
    this.stream.feeds.pop()
    this.stream._localFeeds[this.id] = null
    this.id = -1

    if (this.stream.destroyed) return
    if (this.stream.expectedFeeds <= 0 || --this.stream.expectedFeeds) return

    this.stream._prefinalize()
  }
}

Feed.prototype._onclose = function () {
  if (this.closed) return
  this.closed = true

  if (!this.stream.destroyed) {
    this.close()
    if (this.remoteId > -1) this.stream._remoteFeeds[this.remoteId] = null
    var hex = this.discoveryKey.toString('hex')
    if (this.stream._feeds[hex] === this) delete this.stream._feeds[hex]
  }

  if (this.peer) this.peer.onclose()
  else this.emit('close')
}

Feed.prototype._resume = function () {
  var self = this
  process.nextTick(resume)

  function resume () {
    while (self._buffer.length) {
      var next = self._buffer.shift()
      self._emit(next.type, next.message)
    }
    self._buffer = null
  }
}

Feed.prototype._onextension = function (data, start, end) {
  if (end <= start) return

  var id = varint.decode(data, start)
  var r = this.stream.remoteExtensions
  var localId = !r || id >= r.length ? -1 : r[id]

  if (localId === -1) return

  var message = data.slice(start + varint.decode.bytes, end)
  var name = this.stream.extensions[localId]

  if (this.peer && this.peer.onextension) this.peer.onextension(name, message)
  else this.emit('extension', name, message)
}

Feed.prototype._onmessage = function (type, data, start, end) {
  var message = decodeMessage(type, data, start, end)
  if (!message || this.closed) return

  if (type === 1) {
    debug(this.id, 'recv HANDSHAKE', message)
    return this.stream._onhandshake(message)
  }

  if (!this._buffer) {
    this._emit(type, message)
    return
  }

  if (this._buffer.length > 16) {
    this.destroy(new Error('Remote sent too many messages on an unopened feed'))
    return
  }

  this._buffer.push({type: type, message: message})
}

Feed.prototype._emit = function (type, message) {
  if (debug.enabled) {
    switch (type) {
      case 2: debug(this.id, 'recv INFO', message); break
      case 3: debug(this.id, 'recv HAVE', message); break
      case 4: debug(this.id, 'recv UNHAVE', message); break
      case 5: debug(this.id, 'recv WANT', message); break
      case 6: debug(this.id, 'recv UNWANT', message); break
      case 7: debug(this.id, 'recv REQUEST', message); break
      case 8: debug(this.id, 'recv CANCEL', message); break
      case 9: debug(this.id, 'recv DATA', message); break
    }
  }

  if (this.peer) {
    switch (type) {
      case 2: return this.peer.oninfo(message)
      case 3: return this.peer.onhave(message)
      case 4: return this.peer.onunhave(message)
      case 5: return this.peer.onwant(message)
      case 6: return this.peer.onunwant(message)
      case 7: return this.peer.onrequest(message)
      case 8: return this.peer.oncancel(message)
      case 9: return this.peer.ondata(message)
    }
  } else {
    switch (type) {
      case 2: return this.emit('info', message)
      case 3: return this.emit('have', message)
      case 4: return this.emit('unhave', message)
      case 5: return this.emit('want', message)
      case 6: return this.emit('unwant', message)
      case 7: return this.emit('request', message)
      case 8: return this.emit('cancel', message)
      case 9: return this.emit('data', message)
    }
  }
}

Feed.prototype._send = function (type, enc, message) {
  var header = this.header | type
  var len = this.headerLength + enc.encodingLength(message)
  var box = bufferAlloc(varint.encodingLength(len) + len)
  var offset = 0

  varint.encode(len, box, offset)
  offset += varint.encode.bytes

  varint.encode(header, box, offset)
  offset += varint.encode.bytes

  enc.encode(message, box, offset)

  return this.stream._push(box)
}

function decodeMessage (type, data, start, end) {
  switch (type) {
    case 1: return decode(messages.Handshake, data, start, end)
    case 2: return decode(messages.Info, data, start, end)
    case 3: return decode(messages.Have, data, start, end)
    case 4: return decode(messages.Unhave, data, start, end)
    case 5: return decode(messages.Want, data, start, end)
    case 6: return decode(messages.Unwant, data, start, end)
    case 7: return decode(messages.Request, data, start, end)
    case 8: return decode(messages.Cancel, data, start, end)
    case 9: return decode(messages.Data, data, start, end)
  }
}

function decode (enc, data, start, end) {
  try {
    return enc.decode(data, start, end)
  } catch (err) {
    return null
  }
}
