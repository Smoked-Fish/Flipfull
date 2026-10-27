#ifdef M_CORE_GB
#include <mgba/internal/gb/io.h>
#include <mgba/internal/gb/mbc.h>
#include <mgba/internal/gb/renderers/software.h>
#include <mgba/internal/gb/serialize.h>
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

#ifdef M_CORE_GB
// the super game boy's packets and transfer, which a state leaves out or loses: loading one sends an
// ATRC_EN packet, so every run-ahead would cancel the transfer
struct FlipfullSGB {
	uint8_t command;
	int bufferIndex;
	uint8_t packets[128];
	int transfer;
	uint8_t packet[128];
	uint8_t header;
};

static struct FlipfullSGB flipfullSGB;
static bool flipfullDrawing;
static bool flipfullBorderStale;

static struct GBVideoSoftwareRenderer* _flipfullSGBRenderer(void) {
	if (core->platform(core) != mPLATFORM_GB) {
		return NULL;
	}
	struct GB* gb = core->board;
	return gb->model & GB_MODEL_SGB ? (struct GBVideoSoftwareRenderer*) gb->video.renderer : NULL;
}

static void _flipfullSaveSGB(struct FlipfullSGB* sgb) {
	struct GBVideoSoftwareRenderer* renderer = _flipfullSGBRenderer();
	if (!renderer) {
		return;
	}
	struct GBVideo* video = &((struct GB*) core->board)->video;
	sgb->command = video->sgbCommandHeader;
	sgb->bufferIndex = video->sgbBufferIndex;
	memcpy(sgb->packets, video->sgbPacketBuffer, sizeof(sgb->packets));
	sgb->transfer = renderer->sgbTransfer;
	memcpy(sgb->packet, renderer->sgbPacket, sizeof(sgb->packet));
	sgb->header = renderer->sgbCommandHeader;
}

static void _flipfullLoadSGB(const struct FlipfullSGB* sgb) {
	struct GBVideoSoftwareRenderer* renderer = _flipfullSGBRenderer();
	if (!renderer) {
		return;
	}
	struct GBVideo* video = &((struct GB*) core->board)->video;
	video->sgbCommandHeader = sgb->command;
	video->sgbBufferIndex = sgb->bufferIndex;
	memcpy(video->sgbPacketBuffer, sgb->packets, sizeof(sgb->packets));
	renderer->sgbTransfer = sgb->transfer;
	memcpy(renderer->sgbPacket, sgb->packet, sizeof(sgb->packet));
	renderer->sgbCommandHeader = sgb->header;
}

// the color of the background or window at x, y, from vram
static int _flipfullPixel(const struct GB* gb, int x, int y) {
	const uint8_t* io = gb->memory.io;
	GBRegisterLCDC lcdc = io[GB_REG_LCDC];
	if (!GBRegisterLCDCIsBgEnable(lcdc)) {
		return 0;
	}
	int map;
	int wx = io[GB_REG_WX] - 7;
	if (GBRegisterLCDCIsWindow(lcdc) && y >= io[GB_REG_WY] && x >= wx) {
		map = GBRegisterLCDCIsWindowTileMap(lcdc) ? 0x1C00 : 0x1800;
		x -= wx;
		y -= io[GB_REG_WY];
	} else {
		map = GBRegisterLCDCIsTileMap(lcdc) ? 0x1C00 : 0x1800;
		x = (x + io[GB_REG_SCX]) & 0xFF;
		y = (y + io[GB_REG_SCY]) & 0xFF;
	}
	uint8_t tile = gb->video.vram[map + (y >> 3) * 32 + (x >> 3)];
	int base = GBRegisterLCDCIsTileData(lcdc) ? tile * 16 : 0x1000 + (int8_t) tile * 16;
	const uint8_t* row = &gb->video.vram[base + (y & 7) * 2];
	int bit = 7 - (x & 7);
	return (((row[1] >> bit) & 1) << 1) | ((row[0] >> bit) & 1);
}

// what the renderer reads off the lines it draws while a transfer is on screen, from vram instead:
// the background and window, without sprites
static void _flipfullSGBTransfer(struct GBVideoSoftwareRenderer* renderer) {
	struct GB* gb = core->board;
	uint8_t* buffer;
	switch (renderer->sgbCommandHeader >> 3) {
	case SGB_PAL_TRN:
		buffer = renderer->d.sgbPalRam;
		break;
	case SGB_CHR_TRN:
		buffer = &renderer->d.sgbCharRam[SGB_SIZE_CHAR_RAM / 2 * (renderer->sgbPacket[1] & 1)];
		break;
	case SGB_PCT_TRN:
		buffer = renderer->d.sgbMapRam;
		break;
	case SGB_ATTR_TRN:
		buffer = renderer->d.sgbAttributeFiles;
		break;
	default:
		return;
	}
	if (!buffer || !GBRegisterLCDCIsEnable(gb->memory.io[GB_REG_LCDC])) {
		return;
	}
	int y;
	for (y = 0; y < GB_VIDEO_VERTICAL_PIXELS; ++y) {
		size_t offset = 2 * ((y & 7) + (y >> 3) * GB_VIDEO_HORIZONTAL_PIXELS);
		if (offset >= 0x1000) {
			break;
		}
		int x;
		for (x = 0; x < GB_VIDEO_HORIZONTAL_PIXELS && offset + (x << 1) + 1 < 0x1000; x += 8) {
			uint8_t hi = 0;
			uint8_t lo = 0;
			int i;
			for (i = 0; i < 8; ++i) {
				int color = _flipfullPixel(gb, x + i, y);
				hi |= ((color >> 1) & 1) << (7 - i);
				lo |= (color & 1) << (7 - i);
			}
			buffer[offset + (x << 1)] = lo;
			buffer[offset + (x << 1) + 1] = hi;
		}
	}
}

// what the renderer does for the super game boy in a frame it draws, for one it skipped
static void _flipfullSkippedSGB(void) {
	struct GBVideoSoftwareRenderer* renderer = _flipfullSGBRenderer();
	if (!renderer) {
		return;
	}
	if (renderer->sgbTransfer == 1) {
		_flipfullSGBTransfer(renderer);
	}
	switch (renderer->sgbCommandHeader >> 3) {
	case SGB_PAL_SET:
	case SGB_ATTR_SET:
		if (renderer->sgbPacket[1] & 0x40 && renderer->d.sgbRenderMode) {
			renderer->d.sgbRenderMode = 0;
			flipfullBorderStale |= renderer->sgbBorders;
		}
		break;
	case SGB_PAL_TRN:
	case SGB_CHR_TRN:
	case SGB_PCT_TRN:
	case SGB_ATRC_EN:
	case SGB_MASK_EN:
		if (renderer->sgbBorders && !renderer->d.sgbRenderMode) {
			flipfullBorderStale = true;
		}
		// Fall through
	case SGB_ATTR_TRN:
		++renderer->sgbTransfer;
		if (renderer->sgbTransfer == 5) {
			renderer->sgbCommandHeader = 0;
		}
		break;
	default:
		break;
	}
}

// the border is only redrawn when a frame finishes or color 0 is written
static void _flipfullSGBBorder(void) {
	struct GBVideoSoftwareRenderer* renderer = _flipfullSGBRenderer();
	if (!flipfullBorderStale || !renderer || renderer->d.sgbRenderMode || !GBRegisterLCDCIsEnable(renderer->lcdc)) {
		return;
	}
	renderer->d.writePalette(&renderer->d, 0, ((struct GB*) core->board)->video.palette[0]);
	flipfullBorderStale = false;
}
#endif

bool flipfull_save_state(void* state) {
	if (!core->saveState(core, state)) {
		return false;
	}
	_flipfullSaveSound(&flipfullSound);
#ifdef M_CORE_GB
	_flipfullSaveSGB(&flipfullSGB);
#endif
	return true;
}

bool flipfull_load_state(void* state) {
#ifdef M_CORE_GB
	// or the ATRC_EN the load sends joins a packet that's still coming in
	if (_flipfullSGBRenderer()) {
		((struct GBSerializedState*) state)->sgb.command &= ~7;
	}
#endif
	if (!core->loadState(core, state)) {
		return false;
	}
	_flipfullLoadSound(&flipfullSound);
#ifdef M_CORE_GB
	_flipfullLoadSGB(&flipfullSGB);
#endif
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
		if (draw) {
			_flipfullSGBBorder();
		}
		flipfullDrawing = draw;
		break;
#endif
	default:
		break;
	}
}

void flipfull_frame_done(void) {
#ifdef M_CORE_GB
	if (core->platform(core) == mPLATFORM_GB && !flipfullDrawing) {
		_flipfullSkippedSGB();
	}
#endif
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
