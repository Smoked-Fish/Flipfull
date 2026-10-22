size_t blip_state_size(const blip_t* m) {
	return sizeof *m + (m->size + buf_extra) * sizeof(buf_t);
}

void blip_save_state(const blip_t* m, void* out) {
	memcpy(out, m, blip_state_size(m));
}

void blip_load_state(blip_t* m, const void* in) {
	memcpy(m, in, blip_state_size(m));
}
