Keypad.prototype._startVoiceInput = function() {
  const DEBOUNCE_MS = 1500;
  const context = this.inputContext;
  if (!context || context.inputType === 'password' ||
      Date.now() - (this.voiceInputStartedAt || 0) < DEBOUNCE_MS) {
    return;
  }
  this.voiceInputStartedAt = Date.now();
  const request = (this.voiceInputRequest || 0) + 1;
  this.voiceInputRequest = request;

  const activity = new WebActivity('voice-input', {
    from: context.appName || 'Keyboard',
    type: context.inputType || 'text'
  });
  activity.start().then(rv => {
    if (request !== this.voiceInputRequest) {
      return;
    }
    this.voiceinputText = typeof rv === 'string' ? rv.trim() : '';
    this._endVoiceInput();
  }, err => {
    if (request === this.voiceInputRequest) {
      this.isVoiceInputTriggered = false;
    }
    console.error('Unable to get voice-input text!');
    console.error(err);
  });
  this.isVoiceInputTriggered = true;
};

Keypad.prototype._endVoiceInput = function() {
  if (this.voiceinputText && this.inputText) {
    const before = this.inputText.textBeforeCursor || '';
    const text = before && !/\s$/.test(before) ?
      ' ' + this.voiceinputText : this.voiceinputText;
    this.input(text);
    this.voiceinputText = '';
  }
  this.isVoiceInputTriggered = false;
};
