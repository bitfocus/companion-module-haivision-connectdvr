var instance_skel = require('../../instance_skel');
var io = require('socket.io-client');
var request = require('request');

function instance(system, id, config) {
	this.defineConst('MIN_BUFFER_TIME', 25);
	this.defineConst('RECONNECT_TIMEOUT', 60); // Number of seconds to try reconnect
	this.defineConst('REBOOT_WAIT_TIME', 210); // Number of seconds to wait until next login after reboot; usually back up within 3.5 mins
	this.reconnecting = null;
	instance_skel.apply(this, arguments);

	this.channels = {};
	this.cur_channel = null;
	this.session_id = null;
	this.cur_time = null;
	this.actions(); // export actions

	return this;
}

/**
 * Initialize the available variables. (These are listed in the module config UI)
 */
instance.prototype.initVariables = function() {
	var variables = [
		{
			label: 'Current playing time of video.',
			name:  'time'
		},
		{
			label: 'Current duration of playing video.',
			name:  'duration'
		}
	];

	this.setVariableDefinitions(variables);
	this.setVariable('time', 'Not playing');
	this.setVariable('duration', 'Not playing');
}

instance.prototype.updateConfig = function(config) {
	this.config = config;
}

instance.prototype.init = function() {
	this.status(this.STATUS_UNKNOWN);
	this.initVariables();

	if(this.config.host) {
		this.login(false);
	}
}

instance.prototype.init_socket = function() {
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

	this.socket.on('connect', function() {
		this.status(this.STATUS_OK);
	}.bind(this))
		.on('connect_error', this._reconnect.bind(this))
		.on('logout', this._reconnect.bind(this, true))
		.on('model:delta', function(type, arg1) {
				if(type === 'player') {
					this._player_updates(arg1);
				} else if(type in this.channels) {
					this._channel_updates(type, arg1);
				}
			}.bind(this))
		.on('data:init', this.device_init.bind(this));
}

instance.prototype._channel_updates = function(id, params) {
	this.channels[id] = {...this.channels[id], ...params};

	// If current channel is playing, update the duration variable
	if(id === this.cur_channel) {
		this.setVariable('duration', this._userFriendlyTime(this.channels[this.cur_channel].duration));
	}
	if('isLive' in params) {
		this.checkFeedbacks('streaming');
	}
}

instance.prototype._player_updates = function(args) {
	if(!args) {
		return;
	}
	if('time' in args) {
		this._set_cur_time(args.time);
	}
	if('active_channel_id' in args) {
		this.debug('Setting active channel to ' + args.active_channel_id);
		this.set_live_channel(args.active_channel_id);
	}
}

instance.prototype._set_cur_time = function(time) {
	this.cur_time = parseFloat(time);
	this.setVariable('time', this._userFriendlyTime(this.cur_time));

	return this.cur_time;
}

instance.prototype._reconnect = function(retry_immediately) {
	this.debug('Connection ended, could be due to a stale connection/logout/reboot/network issue.');
	this.log('warn', 'Connection to server ended. Will attempt to reconnect.');
	this.status(this.STATUS_ERROR);
	this.socket.close(); // Possibly a reboot/lost network, we'll need to wait to try another reconnect

	if(retry_immediately) {
		this.login(true);
	} else {
		this.keep_login_retry(this.RECONNECT_TIMEOUT);
	}
}

instance.prototype.keep_login_retry = function(timeout) {
	if(this.reconnecting) {
		return;
	}

	this.log('info', 'Attempting to reconnect in ' + timeout + ' seconds.');
	this.reconnecting = setTimeout(this.login.bind(this, true), timeout * 1000);
}

instance.prototype.login = function(retry = false) {
	if(this.reconnecting) {
		clearTimeout(this.reconnecting);
		this.reconnecting = null;
	}
	request.post({
		url: 'https://' + this.config.host + '/api/session',
		json: true,
		body: {
			username: this.config.username,
			password: this.config.password
		},
		rejectUnauthorized: false, // There's a good chance the DE doesn't have a valid cert
		requestCert: true,
		agent: false
	}, function(error, response, session_content) {
		if(!('statusCode' in response) || response.statusCode !== 200) {
			this.debug('Could not connect, error: ' + error);
			this.log('warn', 'Could not connect to server.');
			this.status(this.STATUS_ERROR);
			if(retry) {
				this.keep_login_retry(this.RECONNECT_TIMEOUT);
			}
			return;
		}

		this.session_id = session_content.response.sessionID;
		this.log('info', 'Successfully connected. Session ID is ' + this.session_id + '.');

		this.init_socket();
	}.bind(this));
}

instance.prototype.device_init = function(data) {
	this.channels = {};
	if('active_channel_id' in data.player) {
		this.set_live_channel(data.player['active_channel_id']);
	}
	data.channel.forEach(function(id) {
		this.channels[id] = data[id];
	}.bind(this));

	this.actions();
	this.init_feedbacks();
}

instance.prototype.set_live_channel = function(id) {
	this.cur_channel = id;
	this.checkFeedbacks('active');
	return this;
}

// Return config fields for web config
instance.prototype.config_fields = function () {
	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This will connect with Haivision DisplayEngines.'
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
			value: 'haiadmin',
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

instance.prototype.destroy = function() {
	if(!this.session_id) {
		return;
	}

	this.socket.close();

	request.delete({
		url: 'https://' + this.config.host + '/api/session',
		headers: {
			Cookie: 'sessionID=' + this.session_id
		},
		json: true,
		body: {},
		rejectUnauthorized: false,
		requestCert: true,
		agent: false
	}, function(error, response, body) {
		if(response.statusCode !== 200) {
			this.debug('warn', 'Could not logout: ' + error);
			return;
		} else {
			this.log('info', 'Session logged out.');
		}
	}.bind(this));
}

instance.prototype._get_channel_choices = function() {
	ret = [];
	for(id in this.channels) {
		ret.push({
			id: this.channels[id].id,
			label: this.channels[id].name
		});
	}
	return ret;
}

instance.prototype.actions = function(system) {
	this.system.emit('instance_actions', this.id, {
		'playpause': { label: 'Play/Pause Toggle'},
		'channel': {
			label: 'Load Channel',
			options: [
				{
					 type: 'dropdown',
					 label: 'Channel ID',
					 id: 'channel',
					 choices: this._get_channel_choices()
				},
				{
					type: 'textinput',
					label: 'Start time (blank for end)',
					id: 'initial_time',
					default: ''
				}
			]
		},
		'reboot': { label: 'Reboot Device'},
		'skip': {
			label: 'Skip',
			options: [
				{
					 type: 'dropdown',
					 label: 'Channel ID',
					 id: 'skip_time',
					 default: '5',
					 choices: [
						{ id: '-300', label: '<- 300 Seconds' },
						{ id: '-60', label: '<- 60 Seconds' },
						{ id: '-5', label: '<- 5 Seconds' },
						{ id: '-1', label: '<- 1 Second' },
						{ id: '1', label: '-> 1 Second' },
						{ id: '5', label: '-> 5 Seconds' },
						{ id: '60', label: '-> 60 Seconds' },
						{ id: '300', label: '-> 300 Seconds' },
					]
				}
			]
		}
	});
}

instance.prototype.play_pause = function() {
	this.log('info', 'Sending pause/play command.');
	this.socket.emit('sendAndCallback2', 'playback:togglePlayState');
	return true;
}

instance.prototype.load_channel = function(id, init_time) {
	init_time = this._get_new_init_time(id, init_time);

	this.log('info', 'Loading channel ' + id + ' at ' + init_time + '.');

	this.socket.emit('sendAndCallback2', 'playback:loadChannel', id, init_time, false, false);
	this.set_live_channel(id);
	return true;
}

instance.prototype.is_live = function(id) {
	return id in this.channels && this.channels[id].isLive;
}

instance.prototype._userFriendlyTime = function(seconds) {
	return new Date(1000 * seconds)
		.toISOString()
		.substr(11, 8);
}

instance.prototype._get_new_init_time = function(id, init_time) {
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

instance.prototype.skip_live = function(time) {
	if(!this.cur_channel || !this.cur_time) {
		return false; // No clip is currently playing
	}

	time = parseFloat(time);
	this.log('info', 'Skipping time by ' + time + '. From ' + this.cur_time + ' -> ' + (this.cur_time + time) + '.');

	this.load_channel(this.cur_channel, this.cur_time + time);
	return true;
}

instance.prototype.reboot = function() {
	this.status(this.STATUS_ERROR);

	request.put({
		url: 'https://' + this.config.host + '/api/settings/reboot',
		headers: {
			Cookie: 'sessionID=' + this.session_id
		},
		json: true,
		body: {
			id: 0
		},
		rejectUnauthorized: false,
		requestCert: true,
		agent: false
	}, function(error, response, body) {
		this.log('info', 'Ending connecting and rebooting...');
	}.bind(this));

	this.socket.close();
	this.keep_login_retry(this.REBOOT_WAIT_TIME);
}

instance.prototype.action = function(action) {
	var cmd = null;
	opt = action.options;

	switch (action.action) {
		case 'playpause':
			this.play_pause();
			break;

		case 'channel':
			this.load_channel(opt.channel, opt.initial_time);
			break;

		case 'skip':
			this.skip_live(opt.skip_time);
			break;

		case 'reboot':
			this.reboot();
			break;
	}
}

instance.prototype.init_feedbacks = function() {
	const channels = this._get_channel_choices();

	var feedbacks = {
		streaming: {
			label: 'Channel is Streaming',
			description: 'Indicates this channel is currently live streaming.',
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
					label: 'Channel ID',
					id: 'channel',
					choices: channels
				}
			]
		},
		active: {
			label: 'Channel is Active',
			description: 'Indicates this channel is currently active (playing/paused).',
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
					default: this.rgb(51, 102, 0)
				},
				{
					type: 'dropdown',
					label: 'Channel ID',
					id: 'channel',
					choices: channels
				}
			]
		}
	};

	this.setFeedbackDefinitions(feedbacks);

	for(feedback in feedbacks) {
		this.checkFeedbacks(feedback);
	}
}

instance.prototype.feedback = function(feedback, bank) {
	if(feedback.type === 'streaming' && this.is_live(feedback.options.channel)) {
		return {
			color: feedback.options.fg,
			bgcolor: feedback.options.bg
		};
	} else if(feedback.type === 'active' && feedback.options.channel == this.cur_channel) {
		return {
			color: feedback.options.fg,
			bgcolor: feedback.options.bg
		};
	}

	return {};
}

instance_skel.extendedBy(instance);
exports = module.exports = instance;
