const instance_skel = require('../../instance_skel');
const io = require('socket.io-client');
const request = require('request').defaults({
	rejectUnauthorized: false, // There's a good chance the DE doesn't have a valid cert
	requestCert: true,
	agent: false
});
const sharp = require('sharp');

/**
 * Companion instance for managing Haivision DE devices
 *
 * @version 1.0.5
 * @since 1.0.0
 * @author Justin Osborne (<osborne@churchofthehighlands.com>)
 */
class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config);

		this.defineConst('MIN_BUFFER_TIME', 25);
		this.defineConst('RECONNECT_TIMEOUT', 10); // Number of seconds to try reconnect
		this.defineConst('REBOOT_WAIT_TIME', 210); // Number of seconds to wait until next login after reboot; usually back up within 3.5 mins
		this.defineConst('PREVIEW_REFRESH', 1500); // Only pull thumbnail every x millisec
		this.defineConst('LOGIN_TIMEOUT', 5000); // Timeout for logins

		this.reconnecting = null;

		this.channels = {};
		this.player_status = {};
		this.cur_channel = null;
		this.session_id = null;
		this.cur_time = null;
		this.stream_cache_feedback = null;
		this.cuepoints = {};
		this._image_refresh = null;
		this._login_request = null;
		this.actions(); // export actions

		return this;
	}

	static GetUpgradeScripts() {
		return [
			instance_skel.CreateConvertToBooleanFeedbackUpgradeScript({
				'streaming': {
					'bg': 'bgcolor',
					'fg': 'color',
					'text': 'text'
				},
				'active': true,
				'playing': true,
				'stopped': true,
			}),
		]
	}

	/**
	 * Initialize the available variables. (These are listed in the module config UI)
	 * @access public
	 * @since 1.0.0
	 */
	initVariables() {
		var variables = [
			{
				label: 'Current playing time of video (HH:MM:SS format).',
				name:  'time'
			},
			{
				label: 'Current duration of playing video (HH:MM:SS format).',
				name:  'duration'
			},
			{
				label: 'Remaining time in playing video (HH:MM:SS format).',
				name:  'remaining'
			}
		];

		this.setVariableDefinitions(variables);
		this.setVariable('time', '00:00:00');
		this.setVariable('duration', '00:00:00');
		this.setVariable('remaining', '00:00:00');
	}

	/**
	 * Process configuration updates
	 * @param {Object} config New configuration
	 * @access public
	 * @since 1.0.0
	 */
	updateConfig(config) {
		if(this.session_id) {
			this.logout();
		}

		this.config = config;
		if(this.config.host && this.config.username && this.config.password) {
			this.login(true);
		}
	}

	/**
	 * Main initialization when it's ok to login
	 * @access public
	 * @since 1.0.0
	 */
	init() {
		this.status(this.STATUS_UNKNOWN);
		this.initVariables();

		if(this.config.host) {
			this.login(true);
		}
	}

	/**
	 * Initialize the socket.io connection to the server after successful login
	 * @access public
	 * @since 1.0.0
	 */
	initSocket() {
		this.status(this.STATUS_WARNING, 'Connecting to socket');
		this.socket = io('https://' + this.config.host, {
			path: '/transport/socket.io/',
			rejectUnauthorized: false,
			forceNode: true,
			transports: ['websocket'],
			transportOptions: {
				websocket: {
					extraHeaders: {
						Cookie: 'io=rj-zrxObRlXCYjP7AACx; sessionID=' + this.session_id // io ID can be anything
					}
				}
			}
		});

		this.socket
			.on('connect', () => {
				this.status(this.STATUS_OK);
			})
			.on('connect_error', this._reconnect.bind(this))
			.on('logout', this._reconnect.bind(this, true))
			.on('model:delta', (type, arg1) => {
					if(type === 'player') {
						this._player_updates(arg1);
					} else if(type in this.channels) {
						this._channel_updates(type, arg1);
					}
				})
			.on('data:init', this.device_init.bind(this));
	}

	/**
	 * Updates that are received from the server relating to a specific channel
	 * @param {String} id
	 * @param {Object} params Raw parameters sent from the server
	 * @access private
	 * @since 1.0.0
	 */
	_channel_updates(id, params) {
		if('duration' in params && this.channels[id].duration !== params.duration) {
			params.last_duration_change = new Date();
		}
		this.channels[id] = {...this.channels[id], ...params};

		// If current channel is playing, update the duration variable
		if(id === this.cur_channel) {
			this.setVariable('duration', this._userFriendlyTime(this.channels[this.cur_channel].duration));
			if('time' in this.player_status) {
				this.setVariable('remaining', this._userFriendlyTime(this.channels[this.cur_channel].duration - this.player_status.time));
			}
		}

		// cloud_duration is sent often for all channels, so we'll use it to validate that the duration is increasing
		if('cloud_duration' in params && params['cloud_duration'] > 0) {
			this.checkFeedbacks('streaming');
		}
	}

	/**
	 * Updates that are received from the server relating to what's playing
	 * @param {Object} args Raw arguments from the server
	 * @access private
	 * @since 1.0.0
	 */
	_player_updates(args) {
		if(!args) {
			return;
		}

		this.player_status = {...this.player_status, ...args};
		if('time' in args) {
			this._set_cur_time(args.time);
		}
		if('active_channel_id' in args) {
			this.debug('Setting active channel to ' + args.active_channel_id);
			this.set_live_channel(args.active_channel_id);
		}
		if('playing' in args) {
			this.get_latest_image();
			this.checkFeedbacks('playing');
			this.checkFeedbacks('stopped');
		}
	}

	/**
	 * Set the current time, may have been received from the server
	 * @param {String} time Time to set
	 * @access private
	 * @since 1.0.0
	 */
	_set_cur_time(time) {
		this.cur_time = parseFloat(time);
		this.setVariable('time', this._userFriendlyTime(this.cur_time));

		return this.cur_time;
	}

	/**
	 * Attempt a reconnect on connection lost/logout
	 * @param {Boolean} retry_immediately Immediately try reconnecting, useful if the session may have ended
	 * @access public
	 * @since 1.0.0
	 */
	_reconnect(retry_immediately) {
		this.debug('Connection ended, could be due to a stale connection/logout/reboot/network issue.');
		this.log('warn', 'Connection to server ended. Will attempt to reconnect.');
		this.status(this.STATUS_ERROR);

		this._endConnection();

		if(retry_immediately) {
			this.login(true);
		} else {
			this.keep_login_retry(this.RECONNECT_TIMEOUT);
		}
	}

	/**
	 * Try login again after timeout
	 * @param {Int} timeout Timeout to try reconnection
	 * @access public
	 * @since 1.0.0
	 */
	keep_login_retry(timeout) {
		if(this.reconnecting) {
			return;
		}

		this.log('info', 'Attempting to reconnect in ' + timeout + ' seconds.');
		this.reconnecting = setTimeout(this.login.bind(this, true), timeout * 1000);
	}

	_stopOldLogin() {
		if(this.reconnecting) {
			clearTimeout(this.reconnecting);
			this.reconnecting = null;
		}
		if(this._login_request !== null) {
			this._login_request.abort();
			this._login_request = null;
		}
	}

	/**
	 * Login to the device
	 * @param {Boolean} retry Set to true to continue retrying logins (only after a good first connection)
	 * @access public
	 * @since 1.0.0
	 */
	login(retry = false) {
		this.status(this.STATUS_WARNING, 'Logging in');

		this._stopOldLogin();

		this._login_request = request.post({
			url: 'https://' + this.config.host + '/api/session',
			json: true,
			body: {
				username: this.config.username,
				password: this.config.password
			},
			timeout: this.LOGIN_TIMEOUT
		}, (error, response, session_content) => {
			if(this._login_request === null) {
				return;
			}
			this._login_request = null;
			if(typeof response !== 'object' || !('statusCode' in response) || response.statusCode !== 200) {
				this.debug(`Could not connect to ${this.config.host}: ${error}`);
				this.log('warn', 'Could not connect to server.');
				this.status(this.STATUS_ERROR);
				if(retry) {
					this.keep_login_retry(this.RECONNECT_TIMEOUT);
				}
				return;
			}

			this.session_id = session_content.response.sessionID;
			this.log('info', 'Successfully connected. Session ID is ' + this.session_id + '.');

			this.initSocket();
		});
	}

	/**
	 * Initialize the device data received from server
	 * @param {Object} data Data received from server
	 * @access public
	 * @since 1.0.0
	 */
	device_init(data) {
		this.channels = {};
		this.player_status = data.player;
		if('active_channel_id' in data.player) {
			this.set_live_channel(data.player['active_channel_id']);
		}
		if('time' in data.player) {
			this._set_cur_time(data.player['time'])
		}
		data.channel.forEach((id) => {
			this.channels[id] = data[id];
		});

		this.actions();
		this.initFeedbacks();
		this.get_latest_image();
	}

	/**
	 * Sets a current channel as live
	 * @param {String} id ID of channel to set as live
	 * @access public
	 * @since 1.0.0
	 */
	set_live_channel(id) {
		this.cur_channel = id;
		this.checkFeedbacks('active');
	}

	/**
	 * Configuration fields that can be used
	 * @returns {Array}
	 * @access public
	 * @since 1.0.0
	 */
	config_fields() {
		return [
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This will connect with Haivision Connect DVR. If you are using the operator account you will not be able to use the reboot functionality.'
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 12,
				regex: this.REGEX_IP
			},
			{
				type: 'textinput',
				id: 'username',
				label: 'Username',
				value: 'haioperator',
				width: 6
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'Password',
				width: 6
			}
		]
	}

	/**
	 * Returns the choices for channels to use for dropdowns
	 * @returns {Array}
	 * @access private
	 * @since 1.0.0
	 */
	_get_channel_choices(blank = false) {
		var ret = [];

		if(blank) {
			ret.push({
				id: '',
				label: ''
			});
		}

		for(var id in this.channels) {
			ret.push({
				id: this.channels[id].id,
				label: this.channels[id].name
			});
		}
		return ret;
	}

	/**
	 * Setup the actions
	 * @param {Object} system
	 * @access public
	 * @since 1.0.0
	 */
	actions() {
		this.setActions({
			'playpause': { label: 'Play/Pause Toggle'},
			'channel': {
				label: 'Load Channel',
				options: [
					{
						type: 'dropdown',
						label: 'Channel ID',
						id: 'channel',
						choices: this._get_channel_choices(true)
					},
					{
						type: 'textwithvariables',
						label: 'Start time in seconds or HH:MM:SS format (empty for end, if live, or start if not live)',
						id: 'initial_time',
						default: '',
					}
				]
			},
			'reboot': { label: 'Reboot Device'},
			'play': { label: 'Play'},
			'pause': { label: 'Pause'},
			'skip': {
				label: 'Skip',
				options: [
					{
						type: 'textinput',
						label: 'Skip Time',
						id: 'skip_time',
						default: 5,
						tooltip: 'Time, in seconds, to skip back/ahead. Use negative numbers to skip backwards.',
						regex: this.REGEX_SIGNED_NUMBER
					}
				]
			},
			'goto': {
				label: 'Go to time in current channel',
				options: [
					{
						type: 'textwithvariables',
						label: 'Time',
						id: 'time',
						default: '',
						tooltip: 'Time to go to in seconds or HH:MM:SS format.',
					}
				]
			},
			'set_cuepoint': {
				label: 'Set Cue Point',
				options: [
					{
						type: 'dropdown',
						label: 'Slot Number',
						id: 'cuepoint_id',
						default: 1,
						tooltip: 'Select a slot to store the current elapsed time and channel as a cuepoint for later recall. Set points do not survive a server restart.',
						choices: this._get_allowed_cuepoints()
					}
				]
			},
			'recall_cuepoint': {
				label: 'Recall Cue Point',
				options: [
					{
						type: 'dropdown',
						label: 'Slot Number',
						id: 'cuepoint_id',
						default: 1,
						tooltip: 'Select a slot to recall. If there is not a cuepoint saved, nothing will happen. Use feedbacks to change colors if a cuepoint is set for a slot.',
						choices: this._get_allowed_cuepoints()
					},
					{
						type: 'dropdown',
						label: 'Play State',
						id: 'play_state',
						default: 'pause',
						tooltip: 'Should the clip start in a playing or paused state.',
						choices: [
							{ id: 'play', label: 'Playing' },
							{ id: 'pause', label: 'Paused' }
						]
					}
				]
			}
		});
	}

	/**
	 * Returns list of allowed cue points slots
	 * @access protected
	 * @return {Object}
	 * @since 1.1.0
	 */
	_get_allowed_cuepoints() {
		return [
			{ id: '1', label: 'Slot 1' },
			{ id: '2', label: 'Slot 2' },
			{ id: '3', label: 'Slot 3' },
			{ id: '4', label: 'Slot 4' },
			{ id: '5', label: 'Slot 5' },
		];
	}

	/**
	 * Toggles play/pause
	 * @returns {Boolean}
	 * @access public
	 * @since 1.0.0
	 */
	play_pause() {
		if(!this._isConnected()) {
			return false;
		}

		this.log('info', 'Sending pause/play command.');
		this.socket.emit('sendAndCallback2', 'playback:togglePlayState');
		return true;
	}

	/**
	 * Insures that the channel is currently setup on the device
	 * @param {String} id
	 * @returns {Boolean}
	 */
	_is_valid_channel(id) {
		if(id in this.channels) {
			return true;
		}

		return false;
	}

	/**
	 * Adds an warning to the log if not currently connected
	 */
	_isConnected() {
		if(this.socket === undefined) {
			this.log('warn', 'Attempted to send command when not connected.');
			return false;
		}

		return true;
	}

	/**
	 * Load a channel to output
	 * @param {String} id ID of channel to check
	 * @param {String} init_time Initial time to load with
	 * @access public
	 * @since 1.0.0
	 */
	load_channel(id, init_time, callback = null) {
		if(!this._isConnected()) {
			return false;
		}

		if(!this._is_valid_channel(id)) {
			return false; // Do not attempt to load an invalid channel
		}

		init_time = this._get_new_init_time(id, init_time);

		this.log('info', 'Loading channel ' + id + ' at ' + init_time + '.');

		this.socket.emit('sendAndCallback2', 'playback:loadChannel', id, init_time, false, -1, callback);
		this.set_live_channel(id);

		return true;
	}

	/**
	 * Check if a channel is live
	 * @param {String} id ID of channel to check
	 * @access public
	 * @since 1.0.0
	 */
	is_live(id) {
		if(this._is_valid_channel(id)) {
			// Cloud updates should be sent every 5 seconds or so
			if('last_duration_change' in this.channels[id] && (new Date - this.channels[id].last_duration_change) <= 15000) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Returns a friendly time in the 00:00:00 format
	 * @param {Int} seconds
	 * @access private
	 * @since 1.0.0
	 */
	_userFriendlyTime(seconds) {
		return new Date(1000 * seconds)
			.toISOString()
			.substr(11, 8);
	}

	_toSeconds(formatted_time) {
		if(formatted_time === '') return '';

		const unparsed_time = String(formatted_time)
			.split(':')
			.reverse();
		let time = parseInt(unparsed_time[0]);

		switch(unparsed_time.length) {
			case 3:
				time += parseInt(unparsed_time[2]) * 3600;
			case 2:
				time += parseInt(unparsed_time[1]) * 60;
		}

		return time;
	}

	/**
	 * Get new start time based on new time, to insure we have a buffer and aren't trying to start at a negative time
	 * @param {String} id ID of channel to check
	 * @param {Float} init_time
	 * @access private
	 * @since 1.0.0
	 */
	_get_new_init_time(id, init_time) {
		if(init_time === '') {
			// Check if stream is live, if it's live go to the end; otherwise go to the beginning
			if(!this.is_live(id)) {
				init_time = 0;
			} else {
				init_time = this.channels[id].duration;
			}
		}

		// Always verify that we don't go to the very end of the video
		if(init_time > (this.channels[id].duration - this.MIN_BUFFER_TIME)) {
			init_time = this.channels[id].duration - this.MIN_BUFFER_TIME; // Give a little second buffer
			if(init_time <= 0) init_time = 0;
		}

		return this._set_cur_time(init_time);
	}

	/**
	 * Checks if a channel is currently active
	 * @returns {Boolean}
	 * @access public
	 * @since 1.1.0
	 */
	is_currently_active() {
		if(!this.cur_channel || !this.cur_time) {
			return false; // No clip is currently playing
		}
		return true;
	}

	/**
	 * Skip to different time for output
	 * @param {String} time Time to jump forward/behind
	 * @access public
	 * @since 1.0.0
	 */
	skip_live(time) {
		if(!this.is_currently_active()) {
			return false;
		}

		time = parseFloat(time);
		this.log('info', 'Skipping time by ' + time + '. From ' + this.cur_time + ' -> ' + (this.cur_time + time) + '.');

		this.load_channel(this.cur_channel, this.cur_time + time);
		return true;
	}

	/**
	 * Reboots the device and starts reconnect attempt
	 * @access public
	 * @since 1.0.0
	 */
	reboot() {
		if(!this._isConnected()) {
			return;
		}
		this.status(this.STATUS_ERROR);

		request.put({
			url: 'https://' + this.config.host + '/api/settings/reboot',
			headers: {
				Cookie: 'sessionID=' + this.session_id
			},
			json: true,
			body: {
				id: 0
			}
		}, (error, response, body) => {
			this.log('info', 'Ending connecting and rebooting...');
		});

		this._endConnection();
		this.session_id = null;
		this.keep_login_retry(this.REBOOT_WAIT_TIME);
	}

	/**
	 * Executes the action
	 * @param {Object} action Action to execute
	 * @access public
	 * @since 1.0.0
	 */
	action(action) {
		var opt = action.options;

		switch (action.action) {
			case 'playpause':
				this.play_pause();
				break;

			case 'play':
				this.play();
				break;

			case 'pause':
				this.pause();
				break;

			case 'channel':
				this.parseVariables(opt.initial_time, (init_time) => {
					this.load_channel(opt.channel, this._toSeconds(init_time));
				});
				break;

			case 'goto':
				if(this.cur_channel === null) {
					this.log('warn', 'Cannot go to time when channel not loaded.');
				} else {
					this.parseVariables(opt.time, (time) => {
						this.load_channel(this.cur_channel, this._toSeconds(time));
					});
				}
				break;

			case 'skip':
				this.skip_live(opt.skip_time);
				break;

			case 'set_cuepoint':
				this.set_cuepoint(opt.cuepoint_id);
				break;

			case 'recall_cuepoint':
				this.recall_cuepoint(opt.cuepoint_id, opt.play_state);
				break;

			case 'reboot':
				this.reboot();
				break;
		}
	}

	/**
	 * Set a cuepoint
	 * @param {String} cuepoint_id
	 * @access public
	 * @since 1.1.0
	 */
	set_cuepoint(cuepoint_id) {
		if(!this.is_currently_active()) {
			this.log('info', 'No active channel to save cuepoint.');
			return false;
		}

		this.log('info', 'Setting cuepoint for slot ' + cuepoint_id);
		this.cuepoints[cuepoint_id] = {
			channel: this.cur_channel,
			time: this.cur_time,
			image: this.image
		};

		this.checkFeedbacks('cuepoint');
	}

	/**
	 * Recalls a saved cuepoint
	 * @param {String} cuepoint_id
	 * @param {String} play_state How to start the recall (play/pause)
	 * @access public
	 * @returns {Boolean|void}
	 * @since 1.1.0
	 */
	recall_cuepoint(cuepoint_id, play_state) {
		if(!(cuepoint_id in this.cuepoints)) {
			this.log('info', 'No cuepoint saved in slot ' + cuepoint_id);
			return false;
		}

		this.log('info', 'Recalling cuepoint for slot ' + cuepoint_id);
		const cuepoint = this.cuepoints[cuepoint_id];
		this.load_channel(cuepoint.channel, cuepoint.time, play_state === 'pause' ? this.play_pause.bind(this) : null);
	}

	/**
	 * Plays the output video
	 * @access public
	 * @since 1.0.0
	 */
	play() {
		if(!this.is_playing() && this.cur_channel !== null) {
			this.play_pause();
		}
	}

	/**
	 * Pauses the output video
	 * @access public
	 * @since 1.0.0
	 */
	pause() {
		if(this.is_playing() && this.cur_channel !== null) {
			this.play_pause();
		}
	}

	is_playing() {
		return 'playing' in this.player_status && this.player_status.playing;
	}

	/**
	 * Initialize feedbacks
	 * @since 1.0.0
	 */
	initFeedbacks() {
		const channels = this._get_channel_choices(true);

		const feedbacks = {
			streaming: {
				type: 'boolean',
				label: 'Channel is Streaming',
				description: 'Indicates this channel is currently live streaming.',
				style: {
					color: this.rgb(255,255,255),
					bgcolor: this.rgb(51, 102, 0)
				},
				options: [
					{
						type: 'dropdown',
						label: 'Channel ID',
						id: 'channel',
						choices: channels
					}
				],
				callback: (feedback) => this.is_live(feedback.options.channel)
			},
			active: {
				type: 'boolean',
				label: 'Channel is Active',
				description: 'Indicates this channel is currently active (playing/paused).',
				style: {
					color: this.rgb(255,255,255),
					bgcolor: this.rgb(51, 102, 0)
				},
				options: [
					{
						type: 'dropdown',
						label: 'Channel ID',
						id: 'channel',
						choices: channels
					}
				],
				callback: (feedback) => feedback.options.channel == this.cur_channel
			},
			playing: {
				type: 'boolean',
				label: 'Output playing',
				description: 'Indicates a channel is currently playing.',
				style: {
					color: this.rgb(255,255,255),
					bgcolor: this.rgb(51, 102, 0)
				},
				callback: (feedback) => this.is_playing()
			},
			stopped: {
				type: 'boolean',
				label: 'Output stopped',
				description: 'Indicates a channel is currently stopped.',
				style: {
					color: this.rgb(255,255,255),
					bgcolor: this.rgb(128, 0, 0)
				},
				callback: (feedback) => !this.is_playing()
			},
			cuepoint: {
				label: 'Cue Point Slot Saved',
				description: 'Indicates a cue point is saved.',
				options: [
					{
						type: 'colorpicker',
						label: 'Foreground color',
						id: 'fg',
						default: this.rgb(255,255,255)
					},
					{
						type: 'colorpicker',
						label: 'Background color',
						id: 'bg',
						default: this.rgb(128, 0, 0)
					},
					{
						type: 'dropdown',
						label: 'Use preview image if available?',
						id: 'use_preview',
						choices: [
							{ id: '', label: 'No' },
							{ id: 'image', label: 'Yes' }
						]
					},
					{
						type: 'dropdown',
						label: 'Cuepoint Slot',
						id: 'cuepoint_id',
						choices: this._get_allowed_cuepoints()
					}
				],
				callback: (feedback) => {
					if(feedback.options.cuepoint_id in this.cuepoints) {
						let ret = {
							color: feedback.options.fg,
							bgcolor: feedback.options.bg
						};
						if(feedback.options.use_preview && feedback.options.use_preview === 'image' && this.cuepoints[feedback.options.cuepoint_id].image) {
							ret.png64 = this.cuepoints[feedback.options.cuepoint_id].image;
						}

						return ret;
					}

					return {};
				}
			},
			previewpic: {
				type: 'advanced',
				label: 'Preview',
				description: 'Preview output image',
				callback: (feedback) => {
					if(this.image) {
						return {
							png64: this.image
						};
					} else {
						return {};
					}
				}
			}
		};

		this.setFeedbackDefinitions(feedbacks);

		for(let feedback in feedbacks) {
			this.checkFeedbacks(feedback);
		}
	}

	get_latest_image() {
		if(this._image_refresh) {
			clearTimeout(this._image_refresh);
		}
		if(!this._isConnected()) {
			return;
		}

		let image_location;

		try {
			// Version 4.6+ includes the image in the stream
			if('image_primary' in this.player_status) {
				image_location = this.player_status.image_primary;
			} else {
				image_location = 'assets/img/live_screenshot_primary.jpg';
			}
			const buff = request.get({
				url: 'https://' + this.config.host + '/' + image_location,
				encoding: null
			}, (error, resp, body) => {
				try {
					sharp(Buffer.from(body))
						.resize(72, 48)
						.png()
						.toBuffer((err, buffer) => {
							this.setImage(buffer);
							this.checkFeedbacks('previewpic');
						});
				} catch (e) {
					this.log('warn', 'Error processing preview image.');
					this.setImage(null);
				}
			});
		} catch (e) {
			this.log('warn', 'Failed to pull latest image.');
			this.setImage(null);
		}
	}

	setImage(image) {
		this.image = image;

		if(this.is_playing()) {
			this._image_refresh = setTimeout(this.get_latest_image.bind(this), this.PREVIEW_REFRESH);
		}

		return this;
	}

	/**
	 * Logout of device
	 * @access public
	 * @since 1.0.0
	 */
	logout() {
		this._endConnection();

		if(!this.session_id) {
			return;
		}

		request.delete({
			url: 'https://' + this.config.host + '/api/session',
			headers: {
				Cookie: 'sessionID=' + this.session_id
			},
			json: true,
			body: {}
		}, (error, response, body) => {
			if(error || !response || !response.statusCode || response.statusCode !== 200) {
				this.debug('warn', 'Could not logout: ' + error);
			} else {
				this.log('info', 'Session logged out.');
			}
		});

		// Server may be down/unreachable, so don't wait for a response here
		this.session_id = null;
	}

	/**
	 * Ends current socket connection
	 */
	_endConnection() {
		if(this._image_refresh) {
			clearTimeout(this._image_refresh);
		}

		if(this.socket !== undefined) {
			this.socket.close();
			delete this.socket;
		}
	}

	/**
	 * Ends session if connected
	 * @since 1.0.0
	 */
	destroy() {
		this._stopOldLogin();
		this.logout();
	}
}

exports = module.exports = instance;
