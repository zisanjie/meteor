var Fiber = Npm.require('fibers');
var Future = Npm.require('fibers/future');

var PHASE = {
  INITIALIZING: 1,
  FETCHING: 2,
  STEADY: 3
};

var idForOp = function (op) {
  if (op.op === 'd')
    return op.o._id;
  else if (op.op === 'i')
    return op.o._id;
  else if (op.op === 'u')
    return op.o2._id;
  else
    throw Error("Unknown op: " + EJSON.stringify(op));
};

MongoConnection.prototype._observeChangesWithOplog = function (
  cursorDescription, callbacks) {
  var self = this;

  var phase = PHASE.INITIALIZING;

  var published = new IdMap;
  var selector = LocalCollection._compileSelector(cursorDescription.selector);

  var needToFetch = new IdMap;
  var currentlyFetching = new IdMap;

  var add = function (doc) {
    var id = doc._id;
    var fields = EJSON.clone(doc);
    delete fields._id;
    if (published.has(id))
      throw Error("tried to add something already published " + id);
    published.set(id, fields);
    callbacks.added && callbacks.added(id, EJSON.clone(fields));
  };

  var remove = function (id) {
    if (!published.has(id))
      throw Error("tried to remove something unpublished " + id);
    published.remove(id);
    callbacks.removed && callbacks.removed(id);
  };

  // XXX mutates newDoc, that's weird
  var handleDoc = function (id, newDoc) {
    var matchesNow = newDoc && selector(newDoc);
    var matchedBefore = published.has(id);
    if (matchesNow && !matchedBefore) {
      add(newDoc);
    } else if (matchedBefore && !matchesNow) {
      remove(id);
    } else if (matchesNow) {
      var oldDoc = published.get(id);
      if (!oldDoc)
        throw Error("thought that " + id + " was there!");
      delete newDoc._id;
      published.set(id, newDoc);
      if (callbacks.changed) {
        var changed = LocalCollection._makeChangedFields(
          EJSON.clone(newDoc), oldDoc);
        if (!_.isEmpty(changed))
          callbacks.changed(id, changed);
      }
    }
  };

  var fetchModifiedDocuments = function () {
    phase = PHASE.FETCHING;
    while (!needToFetch.isEmpty()) {
      if (phase !== PHASE.FETCHING)
        throw new Error("Surprising phase in fetchModifiedDocuments: " + phase);

      var futures = [];
      currentlyFetching = needToFetch;
      needToFetch = new IdMap;
      currentlyFetching.each(function (cacheKey, id) {
        // Run each until they yield. This implies that needToFetch will not be
        // updated during this loop.
        Fiber(function () {
          var f = new Future;
          futures.push(f);
          var doc = self._docFetcher.fetch(cursorDescription.collectionName, id,
                                           cacheKey);
          handleDoc(id, doc);
          f.return();
        }).run();
      });
      Future.wait(futures);
      // Throw if any throw.
      // XXX this means the observe will now be stalled
      _.each(futures, function (f) {
        f.get();
      });
      currentlyFetching = new IdMap;
    }
    beSteady();
  };

  var writesToCommitWhenWeReachSteady = [];
  var beSteady = function () {
    phase = PHASE.STEADY;
    var writes = writesToCommitWhenWeReachSteady;
    writesToCommitWhenWeReachSteady = [];
    _.each(writes, function (w) {
      w.committed();
    });
  };

  var oplogEntryHandlers = {};
  oplogEntryHandlers[PHASE.INITIALIZING] = function (op) {
    needToFetch.set(idForOp(op), op.ts.toString());
  };
  oplogEntryHandlers[PHASE.FETCHING] = function (op) {
    var id = idForOp(op);
    // We can handle non-modify changes to things that we aren't fetching,
    // directly.
  };
  // We can use the same handler for STEADY and FETCHING; the main difference is
  // that FETCHING has non-empty currentlyFetching and/or needToFetch.
  oplogEntryHandlers[PHASE.STEADY] = function (op) {
    var id = idForOp(op);
    // If we're already fetching this one, or about to, we can't optimize; make
    // sure that we fetch it again if necessary.
    if (currentlyFetching.has(id) || needToFetch.has(id)) {
      if (phase !== PHASE.FETCHING)
        throw Error("map not empty during steady phase");
      needToFetch.set(id, op.ts.toString());
      return;
    }

    if (op.op === 'd') {
      if (published.has(id))
        remove(id);
    } else if (op.op === 'i') {
      if (published.has(id))
        throw new Error("insert found for already-existing ID");

      // XXX what if selector yields?  for now it can't but later it could have
      // $where
      if (selector(op.o))
        add(op.o);
    } else if (op.op === 'u') {
      // Is this a modifier ($set/$unset, which may require us to poll the
      // database to figure out if the whole document matches the selector) or a
      // replacement (in which case we can just directly re-evaluate the
      // selector)?
      var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset');

      if (isReplace) {
        handleDoc(id, _.extend({_id: id}, op.o));
      } else if (published.has(id)) {
        // Oh great, we actually know what the document is, so we can apply
        // this directly.
        // XXX this assumes no field filtering
        var newDoc = EJSON.clone(published.get(id));
        newDoc._id = id;
        LocalCollection._modify(newDoc, op.o);
        handleDoc(id, newDoc);
      } else {
        // If the selector is not affected by the modifier, no need to do
        // anything!
        if (!LocalCollection._isSelectorAffectedByModifier(
          cursorDescription.selector, op.o)) {
          return;
        }

        needToFetch.set(id, op.ts.toString());
        if (phase === PHASE.STEADY)
          fetchModifiedDocuments();
        return;
      }
    } else {
      throw Error("XXX SURPRISING OPERATION: " + op);
    }
  };
  oplogEntryHandlers[PHASE.FETCHING] = oplogEntryHandlers[PHASE.STEADY];


  var oplogHandle = self._oplogHandle.onOplogEntry(
    cursorDescription.collectionName, function (op) {
      oplogEntryHandlers[phase](op);
    }
  );

  // XXX ordering w.r.t. everything else?
  var listenersHandle = listenAll(
    cursorDescription, function (notification, complete) {
      // If we're not in a write fence, we don't have to do anything.
      var fence = DDPServer._CurrentWriteFence.get();
      if (!fence) {
        complete();
        return;
      }
      var write = fence.beginWrite();
      // This write cannot complete until we've caught up to "this point" in the
      // oplog, and then made it back to the steady state.
      self._oplogHandle.callWhenProcessedLatest(function () {
        if (phase === PHASE.STEADY)
          write.committed();
        else
          writesToCommitWhenWeReachSteady.push(write);
      });
      complete();
    }
  );

  var initialCursor = new Cursor(self, cursorDescription);
  initialCursor.forEach(function (initialDoc) {
    add(initialDoc);
  });

  var catchUpFuture = new Future;
  self._oplogHandle.callWhenProcessedLatest(catchUpFuture.resolver());
  catchUpFuture.wait();

  if (phase !== PHASE.INITIALIZING)
    throw Error("Phase unexpectedly " + phase);

  if (needToFetch.isEmpty()) {
    beSteady();
  } else {
    phase = PHASE.FETCHING;
    Meteor.defer(fetchModifiedDocuments);
  }

  return {
    stop: function () {
      listenersHandle.stop();
      oplogHandle.stop();
    }
  };
};
