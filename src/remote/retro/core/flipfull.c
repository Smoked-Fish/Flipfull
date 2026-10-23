#ifdef M_CORE_GB
#include <mgba/internal/gb/mbc.h>
#endif

size_t blip_state_size(const blip_t*);
void blip_save_state(const blip_t*, void*);
void blip_load_state(blip_t*, const void*);

size_t flipfull_state_size(void) {
	return core->stateSize(core);
}

struct FlipfullSound {
	uint8_t* blips;
	size_t blipsSize;
	int16_t last[2];
	int clock;
	struct GBAudioSquareChannel ch1;
	struct GBAudioSquareChannel ch2;
	struct GBAudioWaveChannel ch3;
	struct GBAudioNoiseChannel ch4;
	int32_t lowPass[2];
};

struct FlipfullMixer {
	int16_t* lastLeft;
	int16_t* lastRight;
	int* clock;
	struct GBAudio* psg;
};

static bool _flipfullMixer(struct FlipfullMixer* mixer) {
	switch (core->platform(core)) {
#ifdef M_CORE_GBA
	case mPLATFORM_GBA: {
		struct GBAAudio* audio = &((struct GBA*) core->board)->audio;
		mixer->lastLeft = &audio->lastLeft;
		mixer->lastRight = &audio->lastRight;
		mixer->clock = &audio->clock;
		mixer->psg = &audio->psg;
		return true;
	}
#endif
#ifdef M_CORE_GB
	case mPLATFORM_GB: {
		struct GBAudio* audio = &((struct GB*) core->board)->audio;
		mixer->lastLeft = &audio->lastLeft;
		mixer->lastRight = &audio->lastRight;
		mixer->clock = &audio->clock;
		mixer->psg = audio;
		return true;
	}
#endif
	default:
		return false;
	}
}

static void _flipfullSaveSound(struct FlipfullSound* sound) {
	struct FlipfullMixer mixer;
	if (_flipfullMixer(&mixer)) {
		blip_t* left = core->getAudioChannel(core, 0);
		blip_t* right = core->getAudioChannel(core, 1);
		size_t l = blip_state_size(left);
		size_t size = l + blip_state_size(right);
		if (size > sound->blipsSize) {
			free(sound->blips);
			sound->blips = malloc(size);
			sound->blipsSize = sound->blips ? size : 0;
		}
		if (sound->blips) {
			blip_save_state(left, sound->blips);
			blip_save_state(right, sound->blips + l);
		}
		sound->last[0] = *mixer.lastLeft;
		sound->last[1] = *mixer.lastRight;
		sound->clock = *mixer.clock;
		sound->ch1 = mixer.psg->ch1;
		sound->ch2 = mixer.psg->ch2;
		sound->ch3 = mixer.psg->ch3;
		sound->ch4 = mixer.psg->ch4;
	}
	sound->lowPass[0] = audioLowPassLeftPrev;
	sound->lowPass[1] = audioLowPassRightPrev;
}

static void _flipfullLoadSound(const struct FlipfullSound* sound) {
	struct FlipfullMixer mixer;
	if (_flipfullMixer(&mixer)) {
		blip_t* left = core->getAudioChannel(core, 0);
		blip_t* right = core->getAudioChannel(core, 1);
		if (sound->blips) {
			blip_load_state(left, sound->blips);
			blip_load_state(right, sound->blips + blip_state_size(left));
		}
		*mixer.lastLeft = sound->last[0];
		*mixer.lastRight = sound->last[1];
		*mixer.clock = sound->clock;
		mixer.psg->ch1 = sound->ch1;
		mixer.psg->ch2 = sound->ch2;
		mixer.psg->ch3 = sound->ch3;
		mixer.psg->ch4 = sound->ch4;
	}
	audioLowPassLeftPrev = sound->lowPass[0];
	audioLowPassRightPrev = sound->lowPass[1];
}

static struct FlipfullSound flipfullSound;

bool flipfull_save_state(void* state) {
	if (!core->saveState(core, state)) {
		return false;
	}
	_flipfullSaveSound(&flipfullSound);
	return true;
}

bool flipfull_load_state(const void* state) {
	if (!core->loadState(core, state)) {
		return false;
	}
	_flipfullLoadSound(&flipfullSound);
	return true;
}

void flipfull_draw_next(bool draw) {
	int skip = draw ? 0 : 1;
	switch (core->platform(core)) {
#ifdef M_CORE_GBA
	case mPLATFORM_GBA:
		((struct GBA*) core->board)->video.frameskipCounter = skip;
		break;
#endif
#ifdef M_CORE_GB
	case mPLATFORM_GB:
		((struct GB*) core->board)->video.frameskipCounter = skip;
		break;
#endif
	default:
		break;
	}
}

void flipfull_drain_audio(void) {
	blip_t* left = core->getAudioChannel(core, 0);
	blip_t* right = core->getAudioChannel(core, 1);
	int avail = blip_samples_avail(left);
	while (avail > 0) {
		size_t want = (size_t) avail;
		if (audioSampleBufferSize < want * 2) {
			int16_t* grown = realloc(audioSampleBuffer, want * 2 * sizeof(int16_t));
			if (!grown) {
				return;
			}
			audioSampleBuffer = grown;
			audioSampleBufferSize = want * 2;
		}
		int produced = blip_read_samples(left, audioSampleBuffer, (int) want, true);
		blip_read_samples(right, audioSampleBuffer + 1, (int) want, true);
		if (produced <= 0) {
			return;
		}
		if (audioLowPassEnabled) {
			_audioLowPassFilter(audioSampleBuffer, produced);
		}
		audioCallback(audioSampleBuffer, (size_t) produced);
		avail = blip_samples_avail(left);
	}
}

void flipfull_set_audio_rate(double rate) {
	double clock = core->frequency(core);
	blip_set_rates(core->getAudioChannel(core, 0), clock, rate);
	blip_set_rates(core->getAudioChannel(core, 1), clock, rate);
}

// the daemon gets local time as if it was utc
void flipfull_set_utc_offset(int64_t seconds) {
	if (core->platform(core) == mPLATFORM_GBA && seconds) {
		core->rtc.override = RTC_WALLCLOCK_OFFSET;
		core->rtc.value = seconds * 1000;
	} else {
		core->rtc.override = RTC_NO_OVERRIDE;
		core->rtc.value = 0;
	}
}

size_t flipfull_save_size(void) {
	size_t size = retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
#ifdef M_CORE_GB
	if (core->platform(core) == mPLATFORM_GB) {
		switch (((struct GB*) core->board)->memory.mbcType) {
		case GB_MBC3_RTC:
			size += sizeof(struct GBMBCRTCSaveBuffer);
			break;
		case GB_HuC3:
			size += sizeof(struct GBMBCHuC3SaveBuffer);
			break;
		case GB_TAMA5:
			size += sizeof(struct GBMBCTAMA5SaveBuffer);
			break;
		default:
			break;
		}
	}
#endif
	return size < SIZE_CART_FLASH1M ? size : SIZE_CART_FLASH1M;
}

void flipfull_flush_save(void) {
#ifdef M_CORE_GB
	if (core->platform(core) == mPLATFORM_GB) {
		struct GB* gb = core->board;
		if (!gb->sramVf) {
			return;
		}
		switch (gb->memory.mbcType) {
		case GB_MBC3_RTC:
			GBMBCRTCWrite(gb);
			break;
		case GB_HuC3:
			GBMBCHuC3Write(gb);
			break;
		case GB_TAMA5:
			GBMBCTAMA5Write(gb);
			break;
		default:
			break;
		}
	}
#endif
}

const char* flipfull_gb_palette(size_t i) {
#ifdef M_CORE_GB
	const struct GBColorPreset* presets;
	size_t count = GBColorPresetList(&presets);
	return i < count ? presets[i].name : NULL;
#else
	UNUSED(i);
	return NULL;
#endif
}

int flipfull_platform(void) {
	switch (core->platform(core)) {
	case mPLATFORM_GBA:
		return 1;
	case mPLATFORM_GB:
		return 2;
	default:
		return 0;
	}
}

