var instance_skel = require('../../instance_skel');
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}

instance.prototype.updateConfig = function(config) {
	this.config = config;
};
instance.prototype.init = function() {
	this.status(this.STATE_OK);
};

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;

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
			regex: self.REGEX_IP
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

// When module gets deleted
instance.prototype.destroy = function() {
	debug("destroy");
};

instance.prototype.actions = function(system) {
	self.system.emit('instance_actions', this.id, {
		'playpause': { label: 'Play/Pause Toggle'},
		'channel': {
			label: 'Load Channel',
			options: [
				{
					 type: 'textinput',
					 label: 'Channel ID',
					 id: 'channel',
					 default: ''
				},
				{
					type: 'textinput',
					label: 'Start time',
					id: 'initial_time',
					default: '0',
					regex: this.REGEX_SIGNED_NUMBER
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

instance.prototype.play_pause = () => {
}

instance.prototype.load_channel = (id) => {
}

instance.prototype.skip_live = (time) => {
}

instance.prototype.action = function(action) {
	var cmd = null;
	opt = action.options;
	debug('action: ', action);

	switch (action.action) {
		case 'playpause':
			this.play_pause();
			break;

		case 'channel':
			this.load_chanel(opt.channel, opt.initial_time);
			break;

		case 'skip':
			this.skip_live(opt.skip_time);
			break;
	}
}

instance_skel.extendedBy(instance);
exports = module.exports = instance;
