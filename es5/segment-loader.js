/**
 * @file segment-loader.js
 */
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

var _get = function get(_x2, _x3, _x4) { var _again = true; _function: while (_again) { var object = _x2, property = _x3, receiver = _x4; _again = false; if (object === null) object = Function.prototype; var desc = Object.getOwnPropertyDescriptor(object, property); if (desc === undefined) { var parent = Object.getPrototypeOf(object); if (parent === null) { return undefined; } else { _x2 = parent; _x3 = property; _x4 = receiver; _again = true; desc = parent = undefined; continue _function; } } else if ('value' in desc) { return desc.value; } else { var getter = desc.get; if (getter === undefined) { return undefined; } return getter.call(receiver); } } };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _inherits(subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _playlist = require('./playlist');

var _videoJs = require('video.js');

var _videoJs2 = _interopRequireDefault(_videoJs);

var _sourceUpdater = require('./source-updater');

var _sourceUpdater2 = _interopRequireDefault(_sourceUpdater);

var _config = require('./config');

var _config2 = _interopRequireDefault(_config);

var _globalWindow = require('global/window');

var _globalWindow2 = _interopRequireDefault(_globalWindow);

var _binUtils = require('./bin-utils');

// in ms
var CHECK_BUFFER_DELAY = 500;

/**
 * Determines if we should call endOfStream on the media source based
 * on the state of the buffer or if appened segment was the final
 * segment in the playlist.
 *
 * @param {Object} playlist a media playlist object
 * @param {Object} mediaSource the MediaSource object
 * @param {Number} segmentIndex the index of segment we last appended
 * @returns {Boolean} do we need to call endOfStream on the MediaSource
 */
var detectEndOfStream = function detectEndOfStream(playlist, mediaSource, segmentIndex) {
  if (!playlist) {
    return false;
  }

  var segments = playlist.segments;

  // determine a few boolean values to help make the branch below easier
  // to read
  var appendedLastSegment = segmentIndex === segments.length;

  // if we've buffered to the end of the video, we need to call endOfStream
  // so that MediaSources can trigger the `ended` event when it runs out of
  // buffered data instead of waiting for me
  return playlist.endList && mediaSource.readyState === 'open' && appendedLastSegment;
};

/**
 * Turns segment byterange into a string suitable for use in
 * HTTP Range requests
 */
var byterangeStr = function byterangeStr(byterange) {
  var byterangeStart = undefined;
  var byterangeEnd = undefined;

  // `byterangeEnd` is one less than `offset + length` because the HTTP range
  // header uses inclusive ranges
  byterangeEnd = byterange.offset + byterange.length - 1;
  byterangeStart = byterange.offset;
  return 'bytes=' + byterangeStart + '-' + byterangeEnd;
};

/**
 * Defines headers for use in the xhr request for a particular segment.
 */
var segmentXhrHeaders = function segmentXhrHeaders(segment) {
  var headers = {};

  if ('byterange' in segment) {
    headers.Range = byterangeStr(segment.byterange);
  }
  return headers;
};

/**
 * Returns a unique string identifier for a media initialization
 * segment.
 */
var initSegmentId = function initSegmentId(initSegment) {
  var byterange = initSegment.byterange || {
    length: Infinity,
    offset: 0
  };

  return [byterange.length, byterange.offset, initSegment.resolvedUri].join(',');
};

/**
 * An object that manages segment loading and appending.
 *
 * @class SegmentLoader
 * @param {Object} options required and optional options
 * @extends videojs.EventTarget
 */

var SegmentLoader = (function (_videojs$EventTarget) {
  _inherits(SegmentLoader, _videojs$EventTarget);

  function SegmentLoader(options) {
    var _this = this;

    _classCallCheck(this, SegmentLoader);

    _get(Object.getPrototypeOf(SegmentLoader.prototype), 'constructor', this).call(this);
    // check pre-conditions
    if (!options) {
      throw new TypeError('Initialization options are required');
    }
    if (typeof options.currentTime !== 'function') {
      throw new TypeError('No currentTime getter specified');
    }
    if (!options.mediaSource) {
      throw new TypeError('No MediaSource specified');
    }
    var settings = _videoJs2['default'].mergeOptions(_videoJs2['default'].options.hls, options);

    // public properties
    this.state = 'INIT';
    this.bandwidth = settings.bandwidth;
    this.throughput = { rate: 0, count: 0 };
    this.roundTrip = NaN;
    this.resetStats_();
    this.mediaIndex = null;

    // private settings
    this.hasPlayed_ = settings.hasPlayed;
    this.currentTime_ = settings.currentTime;
    this.seekable_ = settings.seekable;
    this.seeking_ = settings.seeking;
    this.setCurrentTime_ = settings.setCurrentTime;
    this.mediaSource_ = settings.mediaSource;
    this.hls_ = settings.hls;
    this.loaderType_ = settings.loaderType;

    // private instance variables
    this.checkBufferTimeout_ = null;
    this.error_ = void 0;
    this.currentTimeline_ = -1;
    this.xhr_ = null;
    this.pendingSegment_ = null;
    this.mimeType_ = null;
    this.sourceUpdater_ = null;
    this.xhrOptions_ = null;

    // Fragmented mp4 playback
    this.activeInitSegmentId_ = null;
    this.initSegments_ = {};

    this.decrypter_ = settings.decrypter;

    // Manages the tracking and generation of sync-points, mappings
    // between a time in the display time and a segment index within
    // a playlist
    this.syncController_ = settings.syncController;
    this.syncPoint_ = {
      segmentIndex: 0,
      time: 0
    };

    this.syncController_.on('syncinfoupdate', function () {
      return _this.trigger('syncinfoupdate');
    });

    // ...for determining the fetch location
    this.fetchAtBuffer_ = false;

    if (settings.debug) {
      this.logger_ = _videoJs2['default'].log.bind(_videoJs2['default'], 'segment-loader', this.loaderType_, '->');
    }
  }

  /**
   * reset all of our media stats
   *
   * @private
   */

  _createClass(SegmentLoader, [{
    key: 'resetStats_',
    value: function resetStats_() {
      this.mediaBytesTransferred = 0;
      this.mediaRequests = 0;
      this.mediaTransferDuration = 0;
      this.mediaSecondsLoaded = 0;
    }

    /**
     * dispose of the SegmentLoader and reset to the default state
     */
  }, {
    key: 'dispose',
    value: function dispose() {
      this.state = 'DISPOSED';
      this.abort_();
      if (this.sourceUpdater_) {
        this.sourceUpdater_.dispose();
      }
      this.resetStats_();
    }

    /**
     * abort anything that is currently doing on with the SegmentLoader
     * and reset to a default state
     */
  }, {
    key: 'abort',
    value: function abort() {

      if (this.state !== 'WAITING') {
        if (this.pendingSegment_) {
          this.pendingSegment_ = null;
        }
        return;
      }

      this.abort_();

      // don't wait for buffer check timeouts to begin fetching the
      // next segment
      if (!this.paused()) {
        this.state = 'READY';
        this.monitorBuffer_();
      }
    }

    /**
     * abort all pending xhr requests and null any pending segements
     *
     * @private
     */
  }, {
    key: 'abort_',
    value: function abort_() {
      if (this.xhr_) {
        this.xhr_.abort();
      }

      // clear out the segment being processed
      this.pendingSegment_ = null;
    }

    /**
     * set an error on the segment loader and null out any pending segements
     *
     * @param {Error} error the error to set on the SegmentLoader
     * @return {Error} the error that was set or that is currently set
     */
  }, {
    key: 'error',
    value: function error(_error) {
      if (typeof _error !== 'undefined') {
        this.error_ = _error;
      }

      this.pendingSegment_ = null;
      return this.error_;
    }

    /**
     * load a playlist and start to fill the buffer
     */
  }, {
    key: 'load',
    value: function load() {
      // un-pause
      this.monitorBuffer_();

      // if we don't have a playlist yet, keep waiting for one to be
      // specified
      if (!this.playlist_) {
        return;
      }

      // not sure if this is the best place for this
      this.syncController_.setDateTimeMapping(this.playlist_);

      // if all the configuration is ready, initialize and begin loading
      if (this.state === 'INIT' && this.mimeType_) {
        return this.init_();
      }

      // if we're in the middle of processing a segment already, don't
      // kick off an additional segment request
      if (!this.sourceUpdater_ || this.state !== 'READY' && this.state !== 'INIT') {
        return;
      }

      this.state = 'READY';
    }

    /**
     * Once all the starting parameters have been specified, begin
     * operation. This method should only be invoked from the INIT
     * state.
     *
     * @private
     */
  }, {
    key: 'init_',
    value: function init_() {
      this.state = 'READY';
      this.sourceUpdater_ = new _sourceUpdater2['default'](this.mediaSource_, this.mimeType_);
      this.resetEverything();
      return this.monitorBuffer_();
    }

    /**
     * set a playlist on the segment loader
     *
     * @param {PlaylistLoader} media the playlist to set on the segment loader
     */
  }, {
    key: 'playlist',
    value: function playlist(newPlaylist) {
      var options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

      if (!newPlaylist) {
        return;
      }

      var oldPlaylist = this.playlist_;
      var segmentInfo = this.pendingSegment_;

      this.playlist_ = newPlaylist;
      this.xhrOptions_ = options;

      // when we haven't started playing yet, the start of a live playlist
      // is always our zero-time so force a sync update each time the playlist
      // is refreshed from the server
      if (!this.hasPlayed_()) {
        newPlaylist.syncInfo = {
          mediaSequence: newPlaylist.mediaSequence,
          time: 0
        };
      }

      // in VOD, this is always a rendition switch (or we updated our syncInfo above)
      // in LIVE, we always want to update with new playlists (including refreshes)
      this.trigger('syncinfoupdate');

      // if we were unpaused but waiting for a playlist, start
      // buffering now
      if (this.mimeType_ && this.state === 'INIT' && !this.paused()) {
        return this.init_();
      }

      if (!oldPlaylist || oldPlaylist.uri !== newPlaylist.uri) {
        if (this.mediaIndex !== null) {
          // we must "resync" the segment loader when we switch renditions and
          // the segment loader is already synced to the previous rendition
          this.resyncLoader();
        }

        // the rest of this function depends on `oldPlaylist` being defined
        return;
      }

      // we reloaded the same playlist so we are in a live scenario
      // and we will likely need to adjust the mediaIndex
      var mediaSequenceDiff = newPlaylist.mediaSequence - oldPlaylist.mediaSequence;

      this.logger_('mediaSequenceDiff', mediaSequenceDiff);

      // update the mediaIndex on the SegmentLoader
      // this is important because we can abort a request and this value must be
      // equal to the last appended mediaIndex
      if (this.mediaIndex !== null) {
        this.mediaIndex -= mediaSequenceDiff;
      }

      // update the mediaIndex on the SegmentInfo object
      // this is important because we will update this.mediaIndex with this value
      // in `handleUpdateEnd_` after the segment has been successfully appended
      if (segmentInfo) {
        segmentInfo.mediaIndex -= mediaSequenceDiff;

        // we need to update the referenced segment so that timing information is
        // saved for the new playlist's segment, however, if the segment fell off the
        // playlist, we can leave the old reference and just lose the timing info
        if (segmentInfo.mediaIndex >= 0) {
          segmentInfo.segment = newPlaylist.segments[segmentInfo.mediaIndex];
        }
      }

      this.syncController_.saveExpiredSegmentInfo(oldPlaylist, newPlaylist);
    }

    /**
     * Prevent the loader from fetching additional segments. If there
     * is a segment request outstanding, it will finish processing
     * before the loader halts. A segment loader can be unpaused by
     * calling load().
     */
  }, {
    key: 'pause',
    value: function pause() {
      if (this.checkBufferTimeout_) {
        _globalWindow2['default'].clearTimeout(this.checkBufferTimeout_);

        this.checkBufferTimeout_ = null;
      }
    }

    /**
     * Returns whether the segment loader is fetching additional
     * segments when given the opportunity. This property can be
     * modified through calls to pause() and load().
     */
  }, {
    key: 'paused',
    value: function paused() {
      return this.checkBufferTimeout_ === null;
    }

    /**
     * create/set the following mimetype on the SourceBuffer through a
     * SourceUpdater
     *
     * @param {String} mimeType the mime type string to use
     */
  }, {
    key: 'mimeType',
    value: function mimeType(_mimeType) {
      if (this.mimeType_) {
        return;
      }

      this.mimeType_ = _mimeType;
      // if we were unpaused but waiting for a sourceUpdater, start
      // buffering now
      if (this.playlist_ && this.state === 'INIT' && !this.paused()) {
        this.init_();
      }
    }

    /**
     * Delete all the buffered data and reset the SegmentLoader
     */
  }, {
    key: 'resetEverything',
    value: function resetEverything() {
      this.resetLoader();
      this.remove(0, Infinity);
    }

    /**
     * Force the SegmentLoader to resync and start loading around the currentTime instead
     * of starting at the end of the buffer
     *
     * Useful for fast quality changes
     */
  }, {
    key: 'resetLoader',
    value: function resetLoader() {
      this.fetchAtBuffer_ = false;
      this.resyncLoader();
    }

    /**
     * Force the SegmentLoader to restart synchronization and make a conservative guess
     * before returning to the simple walk-forward method
     */
  }, {
    key: 'resyncLoader',
    value: function resyncLoader() {
      this.mediaIndex = null;
      this.syncPoint_ = null;
    }

    /**
     * Remove any data in the source buffer between start and end times
     * @param {Number} start - the start time of the region to remove from the buffer
     * @param {Number} end - the end time of the region to remove from the buffer
     */
  }, {
    key: 'remove',
    value: function remove(start, end) {
      if (this.sourceUpdater_) {
        this.sourceUpdater_.remove(start, end);
      }
    }

    /**
     * (re-)schedule monitorBufferTick_ to run as soon as possible
     *
     * @private
     */
  }, {
    key: 'monitorBuffer_',
    value: function monitorBuffer_() {
      if (this.checkBufferTimeout_) {
        _globalWindow2['default'].clearTimeout(this.checkBufferTimeout_);
      }

      this.checkBufferTimeout_ = _globalWindow2['default'].setTimeout(this.monitorBufferTick_.bind(this), 1);
    }

    /**
     * As long as the SegmentLoader is in the READY state, periodically
     * invoke fillBuffer_().
     *
     * @private
     */
  }, {
    key: 'monitorBufferTick_',
    value: function monitorBufferTick_() {
      if (this.state === 'READY') {
        this.fillBuffer_();
      }

      if (this.checkBufferTimeout_) {
        _globalWindow2['default'].clearTimeout(this.checkBufferTimeout_);
      }

      this.checkBufferTimeout_ = _globalWindow2['default'].setTimeout(this.monitorBufferTick_.bind(this), CHECK_BUFFER_DELAY);
    }

    /**
     * fill the buffer with segements unless the sourceBuffers are
     * currently updating
     *
     * Note: this function should only ever be called by monitorBuffer_
     * and never directly
     *
     * @private
     */
  }, {
    key: 'fillBuffer_',
    value: function fillBuffer_() {
      if (this.sourceUpdater_.updating()) {
        return;
      }

      if (!this.syncPoint_) {
        this.syncPoint_ = this.syncController_.getSyncPoint(this.playlist_, this.mediaSource_.duration, this.currentTimeline_);
      }

      // see if we need to begin loading immediately
      var segmentInfo = this.checkBuffer_(this.sourceUpdater_.buffered(), this.playlist_, this.mediaIndex, this.hasPlayed_(), this.currentTime_(), this.syncPoint_);

      if (!segmentInfo) {
        return;
      }

      var isEndOfStream = detectEndOfStream(this.playlist_, this.mediaSource_, segmentInfo.mediaIndex);

      if (isEndOfStream) {
        this.mediaSource_.endOfStream();
        return;
      }

      if (segmentInfo.mediaIndex === this.playlist_.segments.length - 1 && this.mediaSource_.readyState === 'ended' && !this.seeking_()) {
        return;
      }

      // We will need to change timestampOffset of the sourceBuffer if either of
      // the following conditions are true:
      // - The segment.timeline !== this.currentTimeline
      //   (we are crossing a discontinuity somehow)
      // - The "timestampOffset" for the start of this segment is less than
      //   the currently set timestampOffset
      if (segmentInfo.timeline !== this.currentTimeline_ || segmentInfo.startOfSegment !== null && segmentInfo.startOfSegment < this.sourceUpdater_.timestampOffset()) {
        this.syncController_.reset();
        segmentInfo.timestampOffset = segmentInfo.startOfSegment;
      }

      this.currentTimeline_ = segmentInfo.timeline;
      this.loadSegment_(segmentInfo);
    }

    /**
     * Determines what segment request should be made, given current playback
     * state.
     *
     * @param {TimeRanges} buffered - the state of the buffer
     * @param {Object} playlist - the playlist object to fetch segments from
     * @param {Number} mediaIndex - the previous mediaIndex fetched or null
     * @param {Boolean} hasPlayed - a flag indicating whether we have played or not
     * @param {Number} currentTime - the playback position in seconds
     * @param {Object} syncPoint - a segment info object that describes the
     * @returns {Object} a segment request object that describes the segment to load
     */
  }, {
    key: 'checkBuffer_',
    value: function checkBuffer_(buffered, playlist, mediaIndex, hasPlayed, currentTime, syncPoint) {
      var lastBufferedEnd = 0;
      var startOfSegment = undefined;

      if (buffered.length) {
        lastBufferedEnd = buffered.end(buffered.length - 1);
      }

      var bufferedTime = Math.max(0, lastBufferedEnd - currentTime);

      if (!playlist.segments.length) {
        return null;
      }

      // if there is plenty of content buffered, and the video has
      // been played before relax for awhile
      if (bufferedTime >= _config2['default'].GOAL_BUFFER_LENGTH) {
        return null;
      }

      // if the video has not yet played once, and we already have
      // one segment downloaded do nothing
      if (!hasPlayed && bufferedTime >= 1) {
        return null;
      }

      this.logger_('checkBuffer_', 'mediaIndex:', mediaIndex, 'hasPlayed:', hasPlayed, 'currentTime:', currentTime, 'syncPoint:', syncPoint, 'fetchAtBuffer:', this.fetchAtBuffer_, 'bufferedTime:', bufferedTime);

      // When the syncPoint is null, there is no way of determining a good
      // conservative segment index to fetch from
      // The best thing to do here is to get the kind of sync-point data by
      // making a request
      if (syncPoint === null) {
        mediaIndex = this.getSyncSegmentCandidate_(playlist);
        this.logger_('getSync', 'mediaIndex:', mediaIndex);
        return this.generateSegmentInfo_(playlist, mediaIndex, null, true);
      }

      // Under normal playback conditions fetching is a simple walk forward
      if (mediaIndex !== null) {
        this.logger_('walkForward', 'mediaIndex:', mediaIndex + 1);
        var segment = playlist.segments[mediaIndex];

        if (segment && segment.end) {
          startOfSegment = segment.end;
        } else {
          startOfSegment = lastBufferedEnd;
        }
        return this.generateSegmentInfo_(playlist, mediaIndex + 1, startOfSegment, false);
      }

      // There is a sync-point but the lack of a mediaIndex indicates that
      // we need to make a good conservative guess about which segment to
      // fetch
      if (this.fetchAtBuffer_) {
        // Find the segment containing the end of the buffer
        var mediaSourceInfo = (0, _playlist.getMediaInfoForTime_)(playlist, lastBufferedEnd, syncPoint.segmentIndex, syncPoint.time);

        mediaIndex = mediaSourceInfo.mediaIndex;
        startOfSegment = mediaSourceInfo.startTime;
      } else {
        // Find the segment containing currentTime
        var mediaSourceInfo = (0, _playlist.getMediaInfoForTime_)(playlist, currentTime, syncPoint.segmentIndex, syncPoint.time);

        mediaIndex = mediaSourceInfo.mediaIndex;
        startOfSegment = mediaSourceInfo.startTime;
      }
      this.logger_('getMediaIndexForTime', 'mediaIndex:', mediaIndex, 'startOfSegment:', startOfSegment);

      return this.generateSegmentInfo_(playlist, mediaIndex, startOfSegment, false);
    }

    /**
     * The segment loader has no recourse except to fetch a segment in the
     * current playlist and use the internal timestamps in that segment to
     * generate a syncPoint. This function returns a good candidate index
     * for that process.
     *
     * @param {Object} playlist - the playlist object to look for a
     * @returns {Number} An index of a segment from the playlist to load
     */
  }, {
    key: 'getSyncSegmentCandidate_',
    value: function getSyncSegmentCandidate_(playlist) {
      var _this2 = this;

      if (this.currentTimeline_ === -1) {
        return 0;
      }

      var segmentIndexArray = playlist.segments.map(function (s, i) {
        return {
          timeline: s.timeline,
          segmentIndex: i
        };
      }).filter(function (s) {
        return s.timeline === _this2.currentTimeline_;
      });

      if (segmentIndexArray.length) {
        return segmentIndexArray[Math.min(segmentIndexArray.length - 1, 1)].segmentIndex;
      }

      return Math.max(playlist.segments.length - 1, 0);
    }
  }, {
    key: 'generateSegmentInfo_',
    value: function generateSegmentInfo_(playlist, mediaIndex, startOfSegment, isSyncRequest) {
      if (mediaIndex < 0 || mediaIndex >= playlist.segments.length) {
        return null;
      }

      var segment = playlist.segments[mediaIndex];

      return {
        // resolve the segment URL relative to the playlist
        uri: segment.resolvedUri,
        // the segment's mediaIndex at the time it was requested
        mediaIndex: mediaIndex,
        // whether or not to update the SegmentLoader's state with this
        // segment's mediaIndex
        isSyncRequest: isSyncRequest,
        startOfSegment: startOfSegment,
        // the segment's playlist
        playlist: playlist,
        // unencrypted bytes of the segment
        bytes: null,
        // when a key is defined for this segment, the encrypted bytes
        encryptedBytes: null,
        // The target timestampOffset for this segment when we append it
        // to the source buffer
        timestampOffset: null,
        // The timeline that the segment is in
        timeline: segment.timeline,
        // The expected duration of the segment in seconds
        duration: segment.duration,
        // retain the segment in case the playlist updates while doing an async process
        segment: segment
      };
    }

    /**
     * load a specific segment from a request into the buffer
     *
     * @private
     */
  }, {
    key: 'loadSegment_',
    value: function loadSegment_(segmentInfo) {
      var _this3 = this;

      var segment = undefined;
      var keyXhr = undefined;
      var initSegmentXhr = undefined;
      var segmentXhr = undefined;
      var removeToTime = 0;

      removeToTime = this.trimBuffer_(segmentInfo);

      if (removeToTime > 0) {
        this.sourceUpdater_.remove(0, removeToTime);
      }

      segment = segmentInfo.segment;

      // optionally, request the decryption key
      if (segment.key) {
        var keyRequestOptions = _videoJs2['default'].mergeOptions(this.xhrOptions_, {
          uri: segment.key.resolvedUri,
          responseType: 'arraybuffer'
        });

        keyXhr = this.hls_.xhr(keyRequestOptions, this.handleResponse_.bind(this));
      }

      // optionally, request the associated media init segment
      if (segment.map && !this.initSegments_[initSegmentId(segment.map)]) {
        var initSegmentOptions = _videoJs2['default'].mergeOptions(this.xhrOptions_, {
          uri: segment.map.resolvedUri,
          responseType: 'arraybuffer',
          headers: segmentXhrHeaders(segment.map)
        });

        initSegmentXhr = this.hls_.xhr(initSegmentOptions, this.handleResponse_.bind(this));
      }
      this.pendingSegment_ = segmentInfo;

      var segmentRequestOptions = _videoJs2['default'].mergeOptions(this.xhrOptions_, {
        uri: segmentInfo.uri,
        responseType: 'arraybuffer',
        headers: segmentXhrHeaders(segment)
      });

      segmentXhr = this.hls_.xhr(segmentRequestOptions, this.handleResponse_.bind(this));
      segmentXhr.addEventListener('progress', function (event) {
        _this3.trigger(event);
      });

      this.xhr_ = {
        keyXhr: keyXhr,
        initSegmentXhr: initSegmentXhr,
        segmentXhr: segmentXhr,
        abort: function abort() {
          if (this.segmentXhr) {
            // Prevent error handler from running.
            this.segmentXhr.onreadystatechange = null;
            this.segmentXhr.abort();
            this.segmentXhr = null;
          }
          if (this.initSegmentXhr) {
            // Prevent error handler from running.
            this.initSegmentXhr.onreadystatechange = null;
            this.initSegmentXhr.abort();
            this.initSegmentXhr = null;
          }
          if (this.keyXhr) {
            // Prevent error handler from running.
            this.keyXhr.onreadystatechange = null;
            this.keyXhr.abort();
            this.keyXhr = null;
          }
        }
      };

      this.state = 'WAITING';
    }

    /**
     * trim the back buffer so we only remove content
     * on segment boundaries
     *
     * @private
     *
     * @param {Object} segmentInfo - the current segment
     * @returns {Number} removeToTime - the end point in time, in seconds
     * that the the buffer should be trimmed.
     */
  }, {
    key: 'trimBuffer_',
    value: function trimBuffer_(segmentInfo) {
      var seekable = this.seekable_();
      var currentTime = this.currentTime_();
      var removeToTime = undefined;

      // Chrome has a hard limit of 150mb of
      // buffer and a very conservative "garbage collector"
      // We manually clear out the old buffer to ensure
      // we don't trigger the QuotaExceeded error
      // on the source buffer during subsequent appends

      // If we have a seekable range use that as the limit for what can be removed safely
      // otherwise remove anything older than 1 minute before the current play head
      if (seekable.length && seekable.start(0) > 0 && seekable.start(0) < currentTime) {
        return seekable.start(0);
      }

      removeToTime = currentTime - 60;

      return removeToTime;
    }

    /**
     * triggered when a segment response is received
     *
     * @private
     */
  }, {
    key: 'handleResponse_',
    value: function handleResponse_(error, request) {
      var segmentInfo = undefined;
      var segment = undefined;
      var view = undefined;

      // timeout of previously aborted request
      if (!this.xhr_ || request !== this.xhr_.segmentXhr && request !== this.xhr_.keyXhr && request !== this.xhr_.initSegmentXhr) {
        return;
      }

      segmentInfo = this.pendingSegment_;
      segment = segmentInfo.segment;

      // if a request times out, reset bandwidth tracking
      if (request.timedout) {
        this.abort_();
        this.bandwidth = 1;
        this.roundTrip = NaN;
        this.state = 'READY';
        return this.trigger('progress');
      }

      // trigger an event for other errors
      if (!request.aborted && error) {
        // abort will clear xhr_
        var keyXhrRequest = this.xhr_.keyXhr;

        this.abort_();
        this.error({
          status: request.status,
          message: request === keyXhrRequest ? 'HLS key request error at URL: ' + segment.key.uri : 'HLS segment request error at URL: ' + segmentInfo.uri,
          code: 2,
          xhr: request
        });
        this.state = 'READY';
        this.pause();
        return this.trigger('error');
      }

      // stop processing if the request was aborted
      if (!request.response) {
        this.abort_();
        return;
      }

      if (request === this.xhr_.segmentXhr) {
        // the segment request is no longer outstanding
        this.xhr_.segmentXhr = null;
        segmentInfo.startOfAppend = Date.now();

        // calculate the download bandwidth based on segment request
        this.roundTrip = request.roundTripTime;
        this.bandwidth = request.bandwidth;
        this.mediaBytesTransferred += request.bytesReceived || 0;
        this.mediaRequests += 1;
        this.mediaTransferDuration += request.roundTripTime || 0;

        if (segment.key) {
          segmentInfo.encryptedBytes = new Uint8Array(request.response);
        } else {
          segmentInfo.bytes = new Uint8Array(request.response);
        }
      }

      if (request === this.xhr_.keyXhr) {
        // the key request is no longer outstanding
        this.xhr_.keyXhr = null;

        if (request.response.byteLength !== 16) {
          this.abort_();
          this.error({
            status: request.status,
            message: 'Invalid HLS key at URL: ' + segment.key.uri,
            code: 2,
            xhr: request
          });
          this.state = 'READY';
          this.pause();
          return this.trigger('error');
        }

        view = new DataView(request.response);
        segment.key.bytes = new Uint32Array([view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)]);

        // if the media sequence is greater than 2^32, the IV will be incorrect
        // assuming 10s segments, that would be about 1300 years
        segment.key.iv = segment.key.iv || new Uint32Array([0, 0, 0, segmentInfo.mediaIndex + segmentInfo.playlist.mediaSequence]);
      }

      if (request === this.xhr_.initSegmentXhr) {
        // the init segment request is no longer outstanding
        this.xhr_.initSegmentXhr = null;
        segment.map.bytes = new Uint8Array(request.response);
        this.initSegments_[initSegmentId(segment.map)] = segment.map;
      }

      if (!this.xhr_.segmentXhr && !this.xhr_.keyXhr && !this.xhr_.initSegmentXhr) {
        this.xhr_ = null;
        this.processResponse_();
      }
    }

    /**
     * Decrypt the segment that is being loaded if necessary
     *
     * @private
     */
  }, {
    key: 'processResponse_',
    value: function processResponse_() {
      if (!this.pendingSegment_) {
        this.state = 'READY';
        return;
      }

      this.state = 'DECRYPTING';

      var segmentInfo = this.pendingSegment_;
      var segment = segmentInfo.segment;

      if (segment.key) {
        // this is an encrypted segment
        // incrementally decrypt the segment
        this.decrypter_.postMessage((0, _binUtils.createTransferableMessage)({
          source: this.loaderType_,
          encrypted: segmentInfo.encryptedBytes,
          key: segment.key.bytes,
          iv: segment.key.iv
        }), [segmentInfo.encryptedBytes.buffer, segment.key.bytes.buffer]);
      } else {
        this.handleSegment_();
      }
    }

    /**
     * Handles response from the decrypter and attaches the decrypted bytes to the pending
     * segment
     *
     * @param {Object} data
     *        Response from decrypter
     * @method handleDecrypted_
     */
  }, {
    key: 'handleDecrypted_',
    value: function handleDecrypted_(data) {
      var segmentInfo = this.pendingSegment_;
      var decrypted = data.decrypted;

      if (segmentInfo) {
        segmentInfo.bytes = new Uint8Array(decrypted.bytes, decrypted.byteOffset, decrypted.byteLength);
      }
      this.handleSegment_();
    }

    /**
     * append a decrypted segement to the SourceBuffer through a SourceUpdater
     *
     * @private
     */
  }, {
    key: 'handleSegment_',
    value: function handleSegment_() {
      var _this4 = this;

      if (!this.pendingSegment_) {
        this.state = 'READY';
        return;
      }

      this.state = 'APPENDING';

      var segmentInfo = this.pendingSegment_;
      var segment = segmentInfo.segment;

      this.syncController_.probeSegmentInfo(segmentInfo);

      if (segmentInfo.isSyncRequest) {
        this.pendingSegment_ = null;
        this.state = 'READY';
        return;
      }

      if (segmentInfo.timestampOffset !== null && segmentInfo.timestampOffset !== this.sourceUpdater_.timestampOffset()) {
        this.sourceUpdater_.timestampOffset(segmentInfo.timestampOffset);
      }

      // if the media initialization segment is changing, append it
      // before the content segment
      if (segment.map) {
        (function () {
          var initId = initSegmentId(segment.map);

          if (!_this4.activeInitSegmentId_ || _this4.activeInitSegmentId_ !== initId) {
            var initSegment = _this4.initSegments_[initId];

            _this4.sourceUpdater_.appendBuffer(initSegment.bytes, function () {
              _this4.activeInitSegmentId_ = initId;
            });
          }
        })();
      }

      segmentInfo.byteLength = segmentInfo.bytes.byteLength;
      if (typeof segment.start === 'number' && typeof segment.end === 'number') {
        this.mediaSecondsLoaded += segment.end - segment.start;
      } else {
        this.mediaSecondsLoaded += segment.duration;
      }

      this.sourceUpdater_.appendBuffer(segmentInfo.bytes, this.handleUpdateEnd_.bind(this));
    }

    /**
     * callback to run when appendBuffer is finished. detects if we are
     * in a good state to do things with the data we got, or if we need
     * to wait for more
     *
     * @private
     */
  }, {
    key: 'handleUpdateEnd_',
    value: function handleUpdateEnd_() {
      this.logger_('handleUpdateEnd_', 'segmentInfo:', this.pendingSegment_);

      if (!this.pendingSegment_) {
        this.state = 'READY';
        if (!this.paused()) {
          this.monitorBuffer_();
        }
        return;
      }

      var segmentInfo = this.pendingSegment_;

      this.pendingSegment_ = null;
      this.recordThroughput_(segmentInfo);
      this.mediaIndex = segmentInfo.mediaIndex;
      this.fetchAtBuffer_ = true;

      // any time an update finishes and the last segment is in the
      // buffer, end the stream. this ensures the "ended" event will
      // fire if playback reaches that point.
      var isEndOfStream = detectEndOfStream(segmentInfo.playlist, this.mediaSource_, this.mediaIndex + 1);

      if (isEndOfStream) {
        this.mediaSource_.endOfStream();
      }

      this.state = 'READY';
      this.trigger('progress');

      if (!this.paused()) {
        this.monitorBuffer_();
      }
    }

    /**
     * Records the current throughput of the decrypt, transmux, and append
     * portion of the semgment pipeline. `throughput.rate` is a the cumulative
     * moving average of the throughput. `throughput.count` is the number of
     * data points in the average.
     *
     * @private
     * @param {Object} segmentInfo the object returned by loadSegment
     */
  }, {
    key: 'recordThroughput_',
    value: function recordThroughput_(segmentInfo) {
      var rate = this.throughput.rate;
      // Add one to the time to ensure that we don't accidentally attempt to divide
      // by zero in the case where the throughput is ridiculously high
      var segmentProcessingTime = Date.now() - segmentInfo.startOfAppend + 1;
      // Multiply by 8000 to convert from bytes/millisecond to bits/second
      var segmentProcessingThroughput = Math.floor(segmentInfo.byteLength / segmentProcessingTime * 8 * 1000);

      // This is just a cumulative moving average calculation:
      //   newAvg = oldAvg + (sample - oldAvg) / (sampleCount + 1)
      this.throughput.rate += (segmentProcessingThroughput - rate) / ++this.throughput.count;
    }

    /**
     * A debugging logger noop that is set to console.log only if debugging
     * is enabled globally
     *
     * @private
     */
  }, {
    key: 'logger_',
    value: function logger_() {}
  }]);

  return SegmentLoader;
})(_videoJs2['default'].EventTarget);

exports['default'] = SegmentLoader;
module.exports = exports['default'];