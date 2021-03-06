const _ = require('lodash');
const Q = require('q');

// TODO... what indexes should be created and should this be responsible for creating them?

function MessageQueue() {
  const self = this;

  self.errorHandler = console.error;

  self.databasePromise = null;
  self.collectionName = '_queue';
  self.onEmptyQueue = null;

  self.pollingInterval = 1000;
  self.processingTimeout = 30 * 1000;
  self.maxWorkers = 5;

  const _workers = {};
  let _numWorkers = 0;
  let _pollingIntervalId = null;

  self.registerWorker = function (type, promise) {
    _workers[type] = promise;
    _startPolling();
  };

  self.stopPolling = function () {
    _stopPolling();
  };

  self.enqueue = function (type, message, options) {
    const queueItem = {
      dateCreated: new Date(),
      type,
      message,
    };
    if (options && options.nextReceivableTime) {
      queueItem.nextReceivableTime = options.nextReceivableTime;
    }

    // The priority range is 1-10, 1 being the highest.
    queueItem.priority = _.get(options, 'priority', 1);

    return _enqueue(queueItem);
  };

  self.enqueueAndProcess = function (type, message) {
    const queueItem = {
      dateCreated: new Date(),
      type,
      message,
      receivedTime: new Date(),
    };
    return _enqueue(queueItem)
      .then(() => _process(queueItem));
  };

  self.removeOne = function (type, messageQuery) {
    const query = _buildQueueItemQuery(type, messageQuery);

    return _remove(query);
  };

  self.removeMany = function (type, messageQuery) {
    const query = _buildQueueItemQuery(type, messageQuery);

    return _remove(query, true);
  };

  self.updateOne = function (type, messageQuery, messageUpdate, options) {
    const query = _buildQueueItemQuery(type, messageQuery);
    const update = _buildQueueItemUpdate(messageUpdate, options);

    return _update(query, update);
  };

  self.updateMany = function (type, messageQuery, messageUpdate, options) {
    const query = _buildQueueItemQuery(type, messageQuery);
    const update = _buildQueueItemUpdate(messageUpdate, options);

    return _update(query, update, true);
  };

  // region Private Helper Methods

  function _startPolling() {
    if (!_pollingIntervalId) {
      // Try and find work at least once every pollingInterval
      _pollingIntervalId = setInterval(_poll, self.pollingInterval);
    }
  }

  function _stopPolling() {
    if (_pollingIntervalId) {
      clearInterval(_pollingIntervalId);
    }
  }

  function _poll() {
    if (_numWorkers < self.maxWorkers) {
      _numWorkers++;
      self._receive()
        .then((queueItem) => {
          if (queueItem) {
            return _process(queueItem)
              .then(() => {
                // Look for more work to do immediately if we just processed something
                setImmediate(_poll);
              });
          } else if (self.onEmptyQueue) {
            return self.onEmptyQueue(self, _numWorkers);
          }
        })
        .catch(self.errorHandler)
        .finally(() => {
          _numWorkers--;
        });
    }
  }

  function _process(queueItem) {
    const worker = _workers[queueItem.type];
    if (!worker) { return Q.reject(new Error(`No worker registered for type: ${queueItem.type}`)); }

    return worker(queueItem)
      .then((status) => {
        switch (status) {
          case 'Completed':
            return _removeOneById(queueItem._id);
          case 'Retry':
            return _release(queueItem);
          case 'Rejected':
            return _reject(queueItem);
          default:
            throw new Error(`Unknown status: ${status}`);
        }
      });
  }

  function _enqueue(queueItem) {
    if (!self.databasePromise) { return Q.reject(new Error('No database configured')); }
    return self.databasePromise()
      .then((db) => db.collection(self.collectionName).insertOne(queueItem))
      .then((result) => result.ops[0]);
  }

  function _removeOneById(id) {
    return _remove({ _id: id });
  }

  function _remove(query, multi) {
    if (!self.databasePromise) { return Q.reject(new Error('No database configured')); }
    return self.databasePromise()
      .then((db) => {
        if (multi) {
          return db.collection(self.collectionName).deleteOne(query);
        }
        return db.collection(self.collectionName).deleteMany(query);
      })
      .then((result) => result.deletedCount);
  }

  function _updateOneById(id, update) {
    return _update({ _id: id }, update);
  }

  function _update(query, update, multi) {
    if (!self.databasePromise) { return Q.reject(new Error('No database configured')); }
    return self.databasePromise()
      .then((db) => {
        if (multi) {
          return db.collection(self.collectionName).updateOne(query, update);
        }
        return db.collection(self.collectionName).updateMany(query, update);
      })
      .then((result) => result.modifiedCount);
  }

  function _release(queueItem) {
    const update = {
      $unset: {
        receivedTime: '',
      },
      $set: {
        retryCount: queueItem.retryCount ? queueItem.retryCount + 1 : 1,
        nextReceivableTime: queueItem.nextReceivableTime ? queueItem.nextReceivableTime : new Date(),
      },
      $push: {
        releaseHistory: {
          retryCount: queueItem.retryCount ? queueItem.retryCount : 0,
          receivedTime: queueItem.receivedTime,
          releasedTime: new Date(),
          releasedReason: queueItem.releasedReason,
        },
      },
    };

    return _updateOneById(queueItem._id, update);
  }

  function _reject(queueItem) {
    const update = {
      $unset: {
        receivedTime: '',
        nextReceivableTime: '',
      },
      $set: {
        rejectedTime: new Date(),
        rejectionReason: queueItem.rejectionReason,
      },
      $push: {
        releaseHistory: {
          retryCount: queueItem.retryCount ? queueItem.retryCount : 0,
          receivedTime: queueItem.receivedTime,
          releasedTime: new Date(),
          releasedReason: queueItem.releasedReason,
        },
      },
    };

    if (!self.databasePromise) { return Q.reject(new Error('No database configured')); }
    return self.databasePromise()
      .then((db) => db.collection(self.collectionName).updateOne({ _id: queueItem._id }, update))
      .then((result) => result.modifiedCount);
  }

  self._receive = function (type = []) {
    const query = {
      type: { $in: _.keys(_workers).concat(type) },
      rejectedTime: { $exists: false },
      $and: [
        {
          $or: [
            { nextReceivableTime: { $lt: new Date() } },
            { nextReceivableTime: { $exists: false } },
          ],
        },
        {
          $or: [
            { receivedTime: { $lt: new Date(Date.now() - self.processingTimeout) } },
            { receivedTime: { $exists: false } },
          ],
        },
      ],
    };
    const update = {
      $set: {
        receivedTime: new Date(),
      },
    };

    if (!self.databasePromise) { return Q.reject(new Error('No database configured')); }
    return self.databasePromise()
      .then((db) => db.collection(self.collectionName).findOneAndUpdate(query, update, { returnOriginal: false, sort: 'priority' }))
      .then((result) => result.value);
  };

  function _buildQueueItemQuery(type, messageQuery) {
    const query = { type };

    _.forEach(messageQuery, (value, key) => {
      const property = `message.${key}`;
      query[property] = value;
    });

    return query;
  }

  function _buildQueueItemUpdate(messageUpdate, options) {
    const update = {};
    const $set = {};

    if (options.nextReceivableTime) {
      $set.nextReceivableTime = options.nextReceivableTime;
    }

    _.forEach(messageUpdate, (value, key) => {
      const property = `message.${key}`;
      $set[property] = value;
    });

    if (!_.isEmpty($set)) {
      update.$set = $set;
    }

    return update;
  }

  // endregion
}

module.exports = MessageQueue;
