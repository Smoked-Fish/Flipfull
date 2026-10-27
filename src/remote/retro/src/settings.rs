use crate::libretro::{self, Platform};
use crate::video::Colors;
use flipfull_remote::own_dir;
use log::warn;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

const FILE: &str = "settings.json";

struct Def {
    key: &'static str,
    section: &'static str,
    name: &'static str,
    about: &'static str,
    choices: &'static [(&'static str, &'static str)],
    default: &'static str,
    load: bool,
}

const OFF_ON: &[(&str, &str)] = &[("off", "Off"), ("on", "On")];
const AHEAD: &[(&str, &str)] = &[("0", "Off"), ("1", "1 frame"), ("2", "2 frames")];

const DEFS: &[Def] = &[
    Def {
        key: "blend",
        section: "Screen",
        name: "Frame Mixing",
        about: "The Flip 4 screen supports ~30 FPS, but GBA/GBC/GB games run at 60. \
                Mixing the frames can help make the game look and feel more natural at 30 FPS. \
                When set to None the phone will try to render the full 60 anyways",
        choices: &[("off", "Last frame only"), ("on", "Both frames"), ("none", "None")],
        default: "off",
        load: false,
    },
    Def {
        key: "colors",
        section: "Screen",
        name: "Colors",
        about: "User preference, vivid colors or softer colors emulating real hardware on the GBA/GBC",
        choices: &[("vivid", "Vivid"), ("lcd", "Like the handheld")],
        default: "vivid",
        load: false,
    },
    Def {
        key: "gb_colors",
        section: "Screen",
        name: "Game Boy Colors",
        about: "Sets the Game Boy color modes",
        choices: &[("3", "GBC or SGB"), ("1", "GBC"), ("2", "SGB"), ("0", "Palette only")],
        default: "3",
        load: true,
    },
    Def {
        key: "gb_palette",
        section: "Screen",
        name: "Game Boy palette",
        about: "The colors of Game Boy games that have none of their own.",
        choices: &[],
        default: "Grayscale",
        load: false,
    },
    Def {
        key: "sgb_borders",
        section: "Screen",
        name: "Super Game Boy borders",
        about: "The picture around Super Game Boy games. It's wider than the screen so the user can \
        choose if they want the boarder to fit or for the game to scale properly and have the sides cut off",
        choices: &[("off", "Off"), ("on", "Shrunk to fit"), ("cut", "Sides cut off")],
        default: "off",
        load: true,
    },
    Def {
        key: "latency",
        section: "Sound",
        name: "Sound buffer",
        about: "How much sound waits to be played, helps with sound quality",
        choices: &[("60", "60 ms"), ("80", "80 ms"), ("100", "100 ms"), ("120", "120 ms"), ("160", "160 ms")],
        default: "100",
        load: false,
    },
    Def {
        key: "filter",
        section: "Sound",
        name: "Soften the sound",
        about: "Takes the edge off the GBA's harsh high notes.",
        choices: &[("off", "Off"), ("40", "A little"), ("60", "More"), ("80", "Much more")],
        default: "off",
        load: false,
    },
    Def {
        key: "ahead_gba",
        section: "Play",
        name: "Run-ahead, GBA",
        about: "Shows the game that many frames ahead to help with input latency.",
        choices: AHEAD,
        default: "1",
        load: false,
    },
    Def {
        key: "ahead_gb",
        section: "Play",
        name: "Run-ahead, Game Boy",
        about: "The same for Game Boy and Game Boy Color games.",
        choices: AHEAD,
        default: "1",
        load: false,
    },
    Def {
        key: "fast",
        section: "Play",
        name: "Fast forward",
        about: "How fast the game runs while the fast forward key is held.",
        choices: &[("max", "As fast as it goes"), ("2", "2×"), ("3", "3×"), ("4", "4×")],
        default: "max",
        load: false,
    },
    Def {
        key: "opposing",
        section: "Play",
        name: "Opposite directions",
        about: "Lets left and right, or up and down, be held at once. Some games break with it.",
        choices: &[("no", "Not at once"), ("yes", "Allowed")],
        default: "no",
        load: false,
    },
    Def {
        key: "solar",
        section: "Play",
        name: "Sunlight (Boktai)",
        about: "The light the solar sensor of the Boktai games sees.",
        choices: &[
            ("0", "0"),
            ("1", "1"),
            ("2", "2"),
            ("3", "3"),
            ("4", "4"),
            ("5", "5"),
            ("6", "6"),
            ("7", "7"),
            ("8", "8"),
            ("9", "9"),
            ("10", "10"),
        ],
        default: "0",
        load: false,
    },
    Def {
        key: "fps",
        section: "Play",
        name: "FPS monitor",
        about: "The frames, pictures and sound over the game, once a second.",
        choices: OFF_ON,
        default: "off",
        load: false,
    },
    Def {
        key: "gb_model",
        section: "System",
        name: "Game Boy model",
        about: "The Game Boy that plays Game Boy and Game Boy Color games.",
        choices: &[
            ("Autodetect", "The game's own"),
            ("Game Boy", "Game Boy"),
            ("Super Game Boy", "Super Game Boy"),
            ("Game Boy Color", "Game Boy Color"),
            ("Game Boy Advance", "Game Boy Advance"),
        ],
        default: "Autodetect",
        load: true,
    },
    Def {
        key: "bios",
        section: "System",
        name: "BIOS",
        about: "gba_bios.bin, gb_bios.bin, gbc_bios.bin or sgb_bios.bin from a roms folder, when one is \
                there; otherwise mGBA's own.",
        choices: &[("on", "From the roms folder"), ("off", "mGBA's own")],
        default: "on",
        load: true,
    },
    Def {
        key: "skip_bios",
        section: "System",
        name: "BIOS intro",
        about: "The logo a BIOS shows before the game.",
        choices: &[("off", "Show it"), ("on", "Skip it")],
        default: "off",
        load: true,
    },
    Def {
        key: "idle",
        section: "System",
        name: "Idle loops",
        about: "Skips the loops games wait in, which saves battery.",
        choices: &[
            ("Remove Known", "Skip known ones"),
            ("Detect and Remove", "Find and skip"),
            ("Don't Remove", "Run them"),
        ],
        default: "Remove Known",
        load: true,
    },
];

pub const BUTTONS: &[(&str, &str, Option<u16>)] = &[
    ("up", "Up", Some(4)),
    ("down", "Down", Some(5)),
    ("left", "Left", Some(6)),
    ("right", "Right", Some(7)),
    ("a", "A", Some(8)),
    ("b", "B", Some(0)),
    ("l", "L", Some(10)),
    ("r", "R", Some(11)),
    ("start", "Start", Some(3)),
    ("select", "Select", Some(2)),
    ("pause", "Pause", None),
    ("fast", "Fast forward", None),
];

type PresetMap = &'static [(&'static str, &'static [&'static str])];

const PRESETS: &[(&str, &str, PresetMap)] = &[
    (
        "standard",
        "Standard",
        &[
            ("up", &["ArrowUp", "2"]),
            ("down", &["ArrowDown", "8"]),
            ("left", &["ArrowLeft", "4"]),
            ("right", &["ArrowRight", "6"]),
            ("a", &["Enter", "5"]),
            ("b", &["Backspace", "7"]),
            ("l", &["FavoriteContacts", "1"]),
            ("r", &["Message", "3"]),
            ("start", &["SoftLeft"]),
            ("select", &["SoftRight"]),
            ("pause", &["*"]),
            ("fast", &["#"]),
        ],
    ),
    (
        "keypad",
        "Keypad",
        &[
            ("up", &["5", "ArrowUp"]),
            ("down", &["8", "ArrowDown"]),
            ("left", &["7", "ArrowLeft"]),
            ("right", &["9", "ArrowRight"]),
            ("a", &["6", "Enter"]),
            ("b", &["4"]),
            ("l", &["1"]),
            ("r", &["3"]),
            ("start", &["*"]),
            ("select", &["#"]),
            ("pause", &["FavoriteContacts"]),
            ("fast", &["Message"]),
        ],
    ),
    (
        "custom",
        "Custom",
        &[
            ("up", &["ArrowUp", "2"]),
            ("down", &["ArrowDown", "8"]),
            ("left", &["ArrowLeft", "4"]),
            ("right", &["ArrowRight", "6"]),
            ("a", &["Enter", "5"]),
            ("b", &["Backspace", "0"]),
            ("l", &["FavoriteContacts", "1"]),
            ("r", &["Message", "3"]),
            ("start", &["SoftLeft"]),
            ("select", &["SoftRight"]),
            ("pause", &["*"]),
            ("fast", &["#"]),
        ],
    ),
];

// keypad codes from soc_matrix_keypad0.kl
pub const KEY_CODES: &[(&str, u16)] = &[
    ("1", 2),
    ("2", 3),
    ("3", 4),
    ("4", 5),
    ("5", 6),
    ("6", 7),
    ("7", 8),
    ("8", 9),
    ("9", 10),
    ("0", 11),
    ("*", 522),
    ("#", 523),
    ("SoftLeft", 139),
    ("SoftRight", 158),
    ("ArrowUp", 103),
    ("ArrowDown", 108),
    ("ArrowLeft", 105),
    ("ArrowRight", 106),
    ("Enter", 352),
    ("Call", 231),
    ("Backspace", 48),
    ("FavoriteContacts", 138),
    ("Message", 30),
];

fn preset_index(id: &str) -> Option<usize> {
    PRESETS.iter().position(|&(p, _, _)| p == id)
}

fn button_index(id: &str) -> Option<usize> {
    BUTTONS.iter().position(|&(b, _, _)| b == id)
}

fn key_code(key: &str) -> Option<u16> {
    KEY_CODES.iter().find(|&&(k, _)| k == key).map(|&(_, c)| c)
}

type ButtonKeys = Vec<Vec<String>>;

fn preset_defaults(preset: usize) -> ButtonKeys {
    let (_, _, map) = PRESETS[preset];
    BUTTONS
        .iter()
        .map(|&(b, _, _)| map.iter().find(|&&(id, _)| id == b).map_or_else(Vec::new, |&(_, keys)| {
            keys.iter().map(|k| k.to_string()).collect()
        }))
        .collect()
}

fn read_map(map: &Value) -> Option<ButtonKeys> {
    let map = map.as_object()?;
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for &(id, _, _) in BUTTONS {
        let mut keys = Vec::new();
        for key in map.get(id)?.as_array()?.iter().filter_map(Value::as_str) {
            if key_code(key).is_some() && !seen.iter().any(|k| k == key) {
                seen.push(key.to_string());
                keys.push(key.to_string());
            }
        }
        out.push(keys);
    }
    Some(out)
}

#[derive(Clone, Debug, PartialEq)]
struct Keys {
    active: usize,
    maps: Vec<ButtonKeys>,
}

impl Default for Keys {
    fn default() -> Keys {
        Keys { active: 0, maps: (0..PRESETS.len()).map(preset_defaults).collect() }
    }
}

impl Keys {
    fn from_json(keys: &Value) -> Keys {
        let active = match keys["active"].as_str().and_then(preset_index) {
            Some(a) => a,
            None => return Keys::default(),
        };
        let maps = PRESETS
            .iter()
            .enumerate()
            .map(|(i, &(id, _, _))| read_map(&keys["maps"][id]).unwrap_or_else(|| preset_defaults(i)))
            .collect();
        Keys { active, maps }
    }

    fn to_json(&self) -> Value {
        let maps: Map<String, Value> = PRESETS
            .iter()
            .zip(&self.maps)
            .map(|(&(id, _, _), map)| {
                let buttons = BUTTONS.iter().zip(map).map(|(&(b, _, _), keys)| (b.to_string(), json!(keys)));
                (id.to_string(), Value::Object(buttons.collect()))
            })
            .collect();
        json!({ "active": PRESETS[self.active].0, "maps": maps })
    }

    fn bits(&self) -> Vec<(&str, u16)> {
        let mut out: Vec<(&str, u16)> = Vec::new();
        let joypad = BUTTONS.iter().zip(&self.maps[self.active]).filter_map(|(&(_, _, bit), keys)| Some((bit?, keys)));
        for (bit, keys) in joypad {
            for key in keys {
                match out.iter_mut().find(|(k, _)| *k == key.as_str()) {
                    Some((_, bits)) => *bits |= 1 << bit,
                    None => out.push((key.as_str(), 1 << bit)),
                }
            }
        }
        out
    }

    fn keys_of(&self, id: &str) -> &[String] {
        match button_index(id) {
            Some(b) => &self.maps[self.active][b],
            None => &[],
        }
    }

    fn set(&mut self, key: &str, value: &Value) -> Result<(), String> {
        match key {
            "keys.preset" => {
                let id = value.as_str().ok_or("Not a preset")?;
                self.active = preset_index(id).ok_or_else(|| format!("No preset {}", id))?;
            }
            "keys.button" => {
                let id = value["button"].as_str().ok_or("Not a button")?;
                let b = button_index(id).ok_or_else(|| format!("No button {}", id))?;
                let key = value["key"].as_str().ok_or("Not a key")?;
                key_code(key).ok_or_else(|| format!("{} isn't on the keypad", key))?;
                let map = &mut self.maps[self.active];
                // without a key there'd be no way out of a game
                let pause = button_index("pause").unwrap_or(b);
                if b != pause && map[pause] == [key] {
                    return Err("It's the only key that pauses. Give Pause another key first.".into());
                }
                for keys in map.iter_mut() {
                    keys.retain(|k| k != key);
                }
                map[b] = vec![key.to_string()];
            }
            "keys.defaults" => self.maps[self.active] = preset_defaults(self.active),
            _ => return Err(format!("No setting {}", key)),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    values: HashMap<String, String>,
    keys: Keys,
    palettes: Vec<String>,
}

impl Settings {
    pub fn from_json(saved: &Value, palettes: Vec<String>) -> Settings {
        let mut values = HashMap::new();
        for def in DEFS {
            if let Some(v) = saved[def.key].as_str() {
                if def.choices.is_empty() || def.choices.iter().any(|(c, _)| *c == v) {
                    values.insert(def.key.to_string(), v.to_string());
                }
            }
        }
        Settings { values, keys: Keys::from_json(&saved["keys"]), palettes }
    }

    pub fn to_json(&self) -> Value {
        let mut out: Map<String, Value> = self.values.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        out.insert("keys".into(), self.keys.to_json());
        Value::Object(out)
    }

    pub fn get(&self, key: &str) -> String {
        match self.values.get(key) {
            Some(v) => v.clone(),
            None => def(key).map(|d| d.default.to_string()).unwrap_or_default(),
        }
    }

    pub fn on(&self, key: &str) -> bool {
        self.get(key) == "on"
    }

    fn number<T: FromStr + Default>(&self, key: &str) -> T {
        self.get(key).parse().unwrap_or_default()
    }

    fn choices(&self, def: &Def) -> Vec<(String, String)> {
        if def.choices.is_empty() {
            self.palettes.iter().map(|p| (p.clone(), p.clone())).collect()
        } else {
            def.choices.iter().map(|&(v, n)| (v.to_string(), n.to_string())).collect()
        }
    }

    pub fn describe(&self) -> Value {
        let mut sections: Vec<(&str, Vec<Value>)> = Vec::new();
        for d in DEFS {
            let item = json!({
                "key": d.key,
                "name": d.name,
                "about": d.about,
                "value": self.get(d.key),
                "choices": self.choices(d).into_iter().map(|(v, n)| json!([v, n])).collect::<Vec<_>>(),
                "load": d.load,
            });
            match sections.iter_mut().find(|(name, _)| *name == d.section) {
                Some((_, items)) => items.push(item),
                None => sections.push((d.section, vec![item])),
            }
        }
        let keys = self.keys.to_json();
        json!({
            "sections": sections.into_iter().map(|(name, items)| json!({ "name": name, "items": items })).collect::<Vec<_>>(),
            "keys": {
                "active": keys["active"],
                "maps": keys["maps"],
                "presets": PRESETS.iter().map(|&(id, name, _)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
                "buttons": BUTTONS.iter().map(|&(id, name, _)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
                "codes": KEY_CODES.iter().map(|&(k, c)| (k.to_string(), json!(c))).collect::<Map<String, Value>>(),
            },
            "play": {
                "keys": self.keys.bits().into_iter().map(|(k, bits)| (k.to_string(), json!(bits))).collect::<Map<String, Value>>(),
                "pause": self.keys.keys_of("pause"),
                "fast": self.keys.keys_of("fast"),
                "latency": self.number::<u32>("latency"),
            },
        })
    }

    pub fn set(&mut self, key: &str, value: &Value) -> Result<bool, String> {
        if key.starts_with("keys.") {
            self.keys.set(key, value)?;
            return Ok(false);
        }
        let d = def(key).ok_or_else(|| format!("No setting {}", key))?;
        let v = value.as_str().ok_or("Not a choice")?;
        if !self.choices(d).iter().any(|(c, _)| c == v) {
            return Err(format!("{} can't be {}", d.name, v));
        }
        self.values.insert(key.to_string(), v.to_string());
        Ok(true)
    }

    pub fn play(&self, platform: Platform) -> Play {
        let keymap = self.keys.bits().into_iter().filter_map(|(k, bits)| Some((key_code(k)?, bits))).collect();
        let fast_keys = self.keys.keys_of("fast").iter().filter_map(|k| key_code(k)).collect();
        Play {
            ahead: self.number(if platform == Platform::Gba { "ahead_gba" } else { "ahead_gb" }),
            mix: self.on("blend"),
            every: self.get("blend") == "none",
            colors: if self.get("colors") == "lcd" { platform.handheld_colors() } else { Colors::Vivid },
            fast: self.get("fast").parse().ok(),
            latency: self.number::<f64>("latency") / 1000.0,
            keymap,
            fast_keys,
        }
    }

    pub fn core_option(&self, key: &str) -> Option<String> {
        let on_off = |k: &str| if self.on(k) { "ON" } else { "OFF" }.to_string();
        Some(match key {
            "mgba_gb_model" => self.get("gb_model"),
            "mgba_use_bios" => on_off("bios"),
            "mgba_skip_bios" => on_off("skip_bios"),
            "mgba_gb_colors" => self.get("gb_palette"),
            "mgba_gb_colors_preset" => self.get("gb_colors"),
            "mgba_sgb_borders" => if self.get("sgb_borders") == "off" { "OFF" } else { "ON" }.into(),
            "mgba_audio_low_pass_filter" => if self.get("filter") == "off" { "disabled" } else { "enabled" }.into(),
            "mgba_audio_low_pass_range" => Some(self.get("filter")).filter(|f| f != "off").unwrap_or_else(|| "60".into()),
            "mgba_allow_opposing_directions" => self.get("opposing"),
            "mgba_solar_sensor_level" => self.get("solar"),
            "mgba_idle_optimization" => self.get("idle"),
            "mgba_force_gbp" => "OFF".into(),
            "mgba_frameskip" => "0".into(),
            _ => return None,
        })
    }
}

fn def(key: &str) -> Option<&'static Def> {
    DEFS.iter().find(|d| d.key == key)
}

pub struct Play {
    pub ahead: u32,
    pub mix: bool,
    pub every: bool,
    pub colors: Colors,
    pub fast: Option<u32>,
    pub latency: f64,
    pub keymap: Vec<(u16, u16)>,
    pub fast_keys: Vec<u16>,
}

static UPDATED: AtomicBool = AtomicBool::new(false);

fn shared() -> MutexGuard<'static, Settings> {
    static SETTINGS: OnceLock<Mutex<Settings>> = OnceLock::new();
    SETTINGS.get_or_init(|| Mutex::new(load())).lock().unwrap()
}

fn load() -> Settings {
    let saved: Value = match fs::read_to_string(own_dir().join(FILE)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            warn!("{}: {}", FILE, e);
            Value::Null
        }),
        Err(_) => Value::Null,
    };
    Settings::from_json(&saved, libretro::gb_palettes())
}

fn store(s: &Settings) {
    let path = own_dir().join(FILE);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&s.to_json()).unwrap_or_default();
    if let Err(e) = fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, &path)) {
        warn!("{}: {}", FILE, e);
    }
}

pub fn on(key: &str) -> bool {
    shared().on(key)
}

pub fn describe() -> Value {
    shared().describe()
}

pub fn set(key: &str, value: &Value) -> Result<(), String> {
    let mut s = shared();
    if s.set(key, value)? {
        UPDATED.store(true, Ordering::Relaxed);
    }
    store(&s);
    Ok(())
}

pub fn play(platform: Platform) -> Play {
    shared().play(platform)
}

pub fn take_update() -> bool {
    UPDATED.swap(false, Ordering::Relaxed)
}

// the core holds on to the pointer, so each value is made once
fn interned(value: &str) -> &'static CStr {
    static VALUES: OnceLock<Mutex<HashMap<String, &'static CStr>>> = OnceLock::new();
    let mut values = VALUES.get_or_init(Mutex::default).lock().unwrap();
    if let Some(v) = values.get(value) {
        return v;
    }
    let v: &'static CStr = Box::leak(CString::new(value).unwrap_or_default().into_boxed_c_str());
    values.insert(value.to_string(), v);
    v
}

pub fn core_option(key: &CStr) -> Option<&'static CStr> {
    let value = shared().core_option(key.to_str().ok()?)?;
    Some(interned(&value))
}
