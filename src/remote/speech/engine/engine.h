#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct stt_model;

typedef int (*stt_abort)(void * data);

void stt_set_log(void (*log)(const char * line));

int stt_model_info(const char * path, char * name, size_t name_size, int * english);

struct stt_model * stt_load(const char * path, int threads);
void stt_free(struct stt_model * m);

int stt_transcribe(struct stt_model * m, const uint8_t * audio, size_t len, const char * lang, stt_abort abort,
                   void * data, char ** text, float * confidence, long * audio_ms, char * err, size_t err_size);
void stt_text_free(char * text);

#ifdef __cplusplus
}
#endif
