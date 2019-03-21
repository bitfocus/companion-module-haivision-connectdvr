var instance_skel = require('../../instance_skel');
var io = require('socket.io-client');
var request = require('request');
var debug;
var log;

function instance(system, id, config) {
	this.defineConst('MIN_BUFFER_TIME', 25);
	instance_skel.apply(this, arguments);

	this.channels = {};
	this.cur_channel = null;
	this.session_id = null;
	this.actions(); // export actions

	return this;
}

instance.prototype.updateConfig = function(config) {
	this.config = config;
};
instance.prototype.init = function() {
	debug = this.debug;
	log = this.log;

	this.status(this.STATUS_UNKNOWN);

	if(this.config.host) {
		this.login();
	}
};

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
	}.bind(this));

	this.socket.on('connect_error', function(err) {
		console.log(err);
		this.status(this.STATUS_ERROR);
	}.bind(this));

	this.cur_time = null;
	this.socket
		.on('model:delta', function(type, arg1) {
				if(type === 'player' && arg1 && 'time' in arg1) {
					this.cur_time = parseFloat(arg1.time);
				}
			}.bind(this))
		.on('data:init', this.device_init.bind(this));
};

instance.prototype.login = function() {
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
		if(response.statusCode !== 200) {
			console.log('Could not connect: ' + error)
			this.status(this.STATUS_ERROR);
			return;
		}

		this.session_id = session_content.response.sessionID;
		console.log('Session ID ready: ' + this.session_id);

		this.init_socket();
	}.bind(this));
}

instance.prototype.device_init = function(data) {
	this.channels = {};
	data.channel.forEach(function(id) {
		this.channels[id] = data[id];
		if(data[id].isLive) this.set_live_channel(id);
	}.bind(this));

	this.actions();
	this.init_feedbacks();
};

instance.prototype.set_live_channel = function(id) {
	this.cur_channel = id;
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
			width: 8,
			regex: this.REGEX_IP
		},
		{
			type: 'textinput',
			id: 'username',
			label: 'Username',
			value: 'haiadmin',
			width: 15
		},
		{
			type: 'textinput',
			id: 'password',
			label: 'Password',
			width: 15
		}
	]
};

instance.prototype.destroy = function() {
	if(!this.session_id) {
		return;
	}

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
			console.log('Could not logout: ' + error);
			return;
		} else {
			console.log('Session destroyed.');
		}
	});
};

instance.prototype._get_channel_choices = function() {
	ret = [];
	for(id in this.channels) {
		ret.push({id: this.channels[id].id, label: this.channels[id].name})
	}
	return ret;
};

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
		'skip': {
			label: 'Skip',
			options: [
				{
					 type: 'dropdown',
					 label: 'Channel ID',
					 id: 'skip_time',
					 default: '5',
					 choices: [
						{ id: '-300', label: 'Back 5 Minutes' },
						{ id: '-60', label: 'Back 1 Minute' },
						{ id: '-5', label: 'Back 5 Seconds' },
						{ id: '5', label: 'Forward 5 Seconds' },
						{ id: '60', label: 'Forward 1 Minute' },
						{ id: '300', label: 'Foward 5 Minute' },
					]
				}
			]
		}
	});
}

instance.prototype.play_pause = function() {
	console.log('Pausing/playing');
	this.socket.emit('sendAndCallback2', 'playback:togglePlayState');
	return true;
}

instance.prototype.load_channel = function(id, init_time) {
	if(init_time === '') {
		init_time = this.channels[id].duration;
	}

	// Always verify that we don't go to the very end of the video
	if(init_time > (this.channels[id].duration - this.MIN_BUFFER_TIME)) {
		init_time = this.channels[id].duration - this.MIN_BUFFER_TIME; // Give a little second buffer
		if(init_time <= 0) init_time = 0;
	}

	console.log('Loading channel ' + id + ' @ ' + init_time);
	this.socket.emit('sendAndCallback2', 'playback:loadChannel', id, parseFloat(init_time), false, false);
	this.set_live_channel(id);
	return true;
}

instance.prototype.skip_live = function(time) {
	console.log('Skipping time: ' + time + ' (from ' + this.cur_time + ' to ' + (this.cur_time + time) + ')');
	if(!this.cur_time) {
		return false;
	}

	this.load_channel(this.cur_channel, this.cur_time + parseFloat(time));
	return true;
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
	}
}

instance.prototype.init_feedbacks = function() {
	var self = this;

	// feedbacks
	var feedbacks = {
		playing: {
			label: 'Video Playing',
			description: 'If video is playing, change colors of the bank',
			options: [
				{
					type: 'colorpicker',
					label: 'Foreground color',
					id: 'fg',
					default: self.rgb(255,255,255)
				},
				{
					type: 'colorpicker',
					label: 'Background color',
					id: 'bg',
					default: self.rgb(100,255,0)
				},
			]
		}
	};

	this.setFeedbackDefinitions(feedbacks);
};

instance.prototype.feedback = function(feedback, bank) {
	if(feedback.type == 'streaming') {
		return {
			color: feedback.options.fg,
			bgcolor: feedback.options.bg
		};
	}
	
	return {};
};


instance_skel.extendedBy(instance);
exports = module.exports = instance;
